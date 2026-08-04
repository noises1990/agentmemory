/**
 * One-off: compare SUMMARY QUALITY across candidate models, using ground
 * truth rather than a structural checklist.
 *
 * Why not reuse scoreSummary(): it awards points for "title present,
 * narrative long enough, three lists non-empty". Six of seven models hit
 * exactly 100 on it, so it ranks reliability, not quality. It cannot tell a
 * summary that names the real files from one that invents plausible ones.
 *
 * The observations themselves are the ground truth. Every CompressedObservation
 * carries the files it touched and the concepts it involved, so for a summary
 * of those observations we can measure:
 *
 *   file precision  — of the files the summary claims, how many actually
 *                     appear in the session. This is the hallucination
 *                     detector, and it is the metric that matters most:
 *                     a memory system that invents file paths is worse than
 *                     one that says less.
 *   file recall     — of the files touched most often in the session, how
 *                     many the summary surfaces. Measures coverage.
 *   concept overlap — same idea, looser, since concepts are free-form
 *                     language rather than identifiers.
 *
 * Precision and recall trade off: a model can score perfect precision by
 * naming one file. Reported side by side, plus counts, so that is visible.
 *
 * Raw summaries are written to disk so they can be read directly — no
 * metric substitutes for looking at the output.
 */

import { homedir } from "node:os";
import { writeFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { SUMMARY_SYSTEM, buildSummaryPrompt } from "../src/prompts/summary.js";
import { getXmlTag, getXmlChildren } from "../src/prompts/xml.js";
import type { CompressedObservation } from "../src/types.js";

const REST = process.env["AGENTMEMORY_URL"] || "http://127.0.0.1:3111";
const TOKEN = process.env["CLOUDFLARE_API_TOKEN"] || "";
const REPS = 2;
const MAX_TOKENS = 8192;

const MODELS = [
  "deepseek/deepseek-v4-flash",
  "workers-ai/@cf/openai/gpt-oss-20b",
  "workers-ai/@cf/openai/gpt-oss-120b",
  "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
  "workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct",
  "workers-ai/@cf/google/gemma-4-26b-a4b-it",
];

const ACCOUNT = /^CLOUDFLARE_ACCOUNT_ID=(.+)$/m.exec(
  readFileSync(`${homedir()}/.agentmemory/.env`, "utf-8"),
)![1]!.trim();
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/open-gate-spekter/compat/chat/completions`;

const sres = await fetch(`${REST}/agentmemory/sessions`);
const { sessions } = (await sres.json()) as { sessions: Array<{ id: string; observationCount?: number }> };
const target = sessions.sort((a, b) => (b.observationCount ?? 0) - (a.observationCount ?? 0))[0]!;
const ores = await fetch(`${REST}/agentmemory/observations?sessionId=${encodeURIComponent(target.id)}&limit=10000`);
// Pinned to a fixed slice. The live session keeps gaining observations
// (321 -> 347 -> 367 across successive runs), so an unpinned corpus makes
// runs incomparable — a model measured later is answering a different
// question than one measured earlier.
const CORPUS_SIZE = 300;
const obs = (((await ores.json()) as { observations?: CompressedObservation[] }).observations ?? [])
  .filter((o) => o.title)
  .slice(0, CORPUS_SIZE);
const prompt = buildSummaryPrompt(obs);

// Ground truth. Basenames, because models legitimately vary the path prefix
// ("src/audit/policy.ts" vs "/x/Projects/lp/src/audit/policy.ts") and
// punishing that would measure formatting, not accuracy.
const fileFreq = new Map<string, number>();
for (const o of obs) for (const f of o.files ?? []) {
  const b = basename(String(f)).toLowerCase();
  if (b) fileFreq.set(b, (fileFreq.get(b) ?? 0) + 1);
}
const realFiles = new Set(fileFreq.keys());
const topFiles = [...fileFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([f]) => f);

const conceptWords = new Set<string>();
for (const o of obs) for (const c of o.concepts ?? []) {
  for (const w of String(c).toLowerCase().split(/[^a-z0-9.+#]+/)) if (w.length > 3) conceptWords.add(w);
}

console.log(`session ${target.id} — ${obs.length} observations`);
console.log(`ground truth: ${realFiles.size} distinct files, ${conceptWords.size} concept words\n`);

function parse(raw: string) {
  let c = (raw || "").trim().replace(/```\s*xml\s*\n?/gi, "").replace(/```/g, "").trim();
  const root = c.match(/(<[a-zA-Z_][\w-]*>[\s\S]*<\/[a-zA-Z_][\w-]*>)/);
  if (root && root[1]) c = root[1].trim();
  const title = getXmlTag(c, "title");
  if (!title) return null;
  return {
    title,
    narrative: getXmlTag(c, "narrative"),
    keyDecisions: getXmlChildren(c, "decisions", "decision"),
    filesModified: getXmlChildren(c, "files", "file"),
    concepts: getXmlChildren(c, "concepts", "concept"),
  };
}

interface Score {
  filePrec: number; fileRec: number; nFiles: number;
  conceptPrec: number; nConcepts: number;
  nDecisions: number; decisionChars: number; narrChars: number;
}

function grade(s: NonNullable<ReturnType<typeof parse>>): Score {
  const claimed = s.filesModified.map((f) => basename(String(f)).toLowerCase()).filter(Boolean);
  const hits = claimed.filter((f) => realFiles.has(f));
  const covered = topFiles.filter((f) => claimed.includes(f));
  const cWords = s.concepts.flatMap((c) => String(c).toLowerCase().split(/[^a-z0-9.+#]+/)).filter((w) => w.length > 3);
  const cHits = cWords.filter((w) => conceptWords.has(w));
  return {
    filePrec: claimed.length ? hits.length / claimed.length : 0,
    fileRec: topFiles.length ? covered.length / topFiles.length : 0,
    nFiles: claimed.length,
    conceptPrec: cWords.length ? cHits.length / cWords.length : 0,
    nConcepts: s.concepts.length,
    nDecisions: s.keyDecisions.length,
    decisionChars: s.keyDecisions.length
      ? Math.round(s.keyDecisions.join("").length / s.keyDecisions.length) : 0,
    narrChars: s.narrative.length,
  };
}

const dump: string[] = [];
const rows: Array<{ model: string; s: Score }> = [];

for (const model of MODELS) {
  const runs: Score[] = [];
  for (let i = 0; i < REPS; i++) {
    let data: any;
    try {
      const res = await fetch(GATEWAY, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "cf-aig-skip-cache": "true" },
        body: JSON.stringify({
          model, max_tokens: MAX_TOKENS, max_completion_tokens: MAX_TOKENS,
          thinking: { type: "disabled" },
          messages: [{ role: "system", content: SUMMARY_SYSTEM }, { role: "user", content: prompt }],
        }),
        // undici's default headers timeout killed an entire run when one
        // slow model exceeded it. Per-call budget instead, and the error is
        // caught below so one bad model cannot end the comparison.
        signal: AbortSignal.timeout(420_000),
      });
      if (!res.ok) { console.log(`${model}: HTTP ${res.status}`); continue; }
      data = await res.json();
    } catch (err) {
      console.log(`${model}: request failed — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const content = data.choices?.[0]?.message?.content ?? "";
    const s = parse(content);
    if (!s) {
      // Record what it actually said. "unparseable" on its own hides
      // whether the model wrote prose, emitted nothing, or spent its
      // budget reasoning — which are different problems.
      const finish = data.choices?.[0]?.finish_reason ?? "?";
      const reasoningTok = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      console.log(
        `${model}: unparseable (finish=${finish}, ${content.length} chars, ` +
        `${data.usage?.completion_tokens ?? 0} out tok, ${reasoningTok} reasoning)`,
      );
      dump.push(
        `${"=".repeat(90)}\n${model}  [UNPARSEABLE finish=${finish}]\n${"=".repeat(90)}\n` +
        `${content.slice(0, 3000) || "(empty content)"}\n`,
      );
      continue;
    }
    runs.push(grade(s));
    if (i === 0) {
      dump.push(
        `${"=".repeat(90)}\n${model}\n${"=".repeat(90)}\n` +
        `TITLE: ${s.title}\n\nNARRATIVE:\n${s.narrative}\n\n` +
        `DECISIONS (${s.keyDecisions.length}):\n${s.keyDecisions.map((d) => `  - ${d}`).join("\n")}\n\n` +
        `FILES (${s.filesModified.length}):\n${s.filesModified.map((f) => `  - ${f}`).join("\n")}\n\n` +
        `CONCEPTS (${s.concepts.length}):\n${s.concepts.map((c) => `  - ${c}`).join("\n")}\n`,
      );
    }
  }
  if (!runs.length) continue;
  const avg = <K extends keyof Score>(k: K) => runs.reduce((a, r) => a + (r[k] as number), 0) / runs.length;
  rows.push({
    model,
    s: {
      filePrec: avg("filePrec"), fileRec: avg("fileRec"), nFiles: avg("nFiles"),
      conceptPrec: avg("conceptPrec"), nConcepts: avg("nConcepts"),
      nDecisions: avg("nDecisions"), decisionChars: avg("decisionChars"), narrChars: avg("narrChars"),
    },
  });
}

console.log(
  "model".padEnd(42) + "file P".padStart(8) + "file R".padStart(8) + "#files".padStart(8) +
  "conc P".padStart(8) + "#dec".padStart(7) + "dec len".padStart(9) + "narr".padStart(7),
);
console.log("-".repeat(97));
for (const { model, s } of rows.sort((a, b) => b.s.filePrec - a.s.filePrec)) {
  console.log(
    model.replace(/^workers-ai\/@cf\//, "").replace(/^deepseek\//, "").padEnd(42) +
    `${(s.filePrec * 100).toFixed(0)}%`.padStart(8) +
    `${(s.fileRec * 100).toFixed(0)}%`.padStart(8) +
    s.nFiles.toFixed(0).padStart(8) +
    `${(s.conceptPrec * 100).toFixed(0)}%`.padStart(8) +
    s.nDecisions.toFixed(1).padStart(7) +
    s.decisionChars.toFixed(0).padStart(9) +
    s.narrChars.toFixed(0).padStart(7),
  );
}

const out = `${homedir()}/.agentmemory/quality-comparison.txt`;
writeFileSync(out, dump.join("\n"));
console.log(`\nfile P = of files the summary claims, share that really appear in the session (hallucination check)`);
console.log(`file R = of the 25 most-touched real files, share the summary surfaces (coverage)`);
console.log(`full summaries written to ${out}`);
