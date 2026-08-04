/**
 * One-off: why did deepseek-v4-flash score 83.3 on the full-session
 * workload while gpt-oss-120b/20b and llama-4-scout scored 100?
 *
 * scoreSummary() is a structural checklist, not a judgement of prose:
 *
 *   title >= 5 chars   20
 *   narrative >= 20    25   (+5 at >= 100)
 *   keyDecisions >= 1  20
 *   filesModified >= 1 15
 *   concepts >= 1      15
 *
 * An average of 83.3 over 3 reps means one run lost exactly 50 points.
 * 20 + 15 + 15 = 50 is the obvious decomposition: title and narrative
 * present, all three LIST sections empty.
 *
 * The leading hypothesis is truncation, not comprehension. The summary
 * template emits <title> and <narrative> first and the lists last, so a
 * response that runs out of output budget loses precisely those three and
 * keeps the first two. If that is what happened, finish_reason will read
 * "length" and the fix is MAX_TOKENS, not the model.
 *
 * So: run it N times against the same full-session prompt and record, per
 * run, finish_reason, output size, which sections survived, and the score.
 */

import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import { SUMMARY_SYSTEM, buildSummaryPrompt } from "../src/prompts/summary.js";
import { getXmlTag, getXmlChildren } from "../src/prompts/xml.js";
import { scoreSummary } from "../src/eval/quality.js";
import type { CompressedObservation } from "../src/types.js";

const REST = process.env["AGENTMEMORY_URL"] || "http://127.0.0.1:3111";
const TOKEN = process.env["CLOUDFLARE_API_TOKEN"] || "";
const MODEL = "deepseek/deepseek-v4-flash";
const REPS = 6;
/** Sweep the output budget: the benchmark ran at 8192. */
const BUDGETS = [8192, 32000];

const { readFileSync } = await import("node:fs");
const ACCOUNT = /^CLOUDFLARE_ACCOUNT_ID=(.+)$/m.exec(
  readFileSync(`${homedir()}/.agentmemory/.env`, "utf-8"),
)![1]!.trim();
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/open-gate-spekter/compat/chat/completions`;

const sres = await fetch(`${REST}/agentmemory/sessions`);
const { sessions } = (await sres.json()) as { sessions: Array<{ id: string; observationCount?: number }> };
const target = sessions.sort((a, b) => (b.observationCount ?? 0) - (a.observationCount ?? 0))[0]!;
const ores = await fetch(`${REST}/agentmemory/observations?sessionId=${encodeURIComponent(target.id)}&limit=10000`);
const obs = (((await ores.json()) as { observations?: CompressedObservation[] }).observations ?? [])
  .filter((o) => o.title);
const prompt = buildSummaryPrompt(obs);

console.log(`session ${target.id} — ${obs.length} observations, ${prompt.length.toLocaleString()} chars (~${Math.round(prompt.length / 3.2).toLocaleString()} tokens)\n`);

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

const failures: string[] = [];

for (const budget of BUDGETS) {
  console.log(`\n${"=".repeat(96)}`);
  console.log(`MAX_TOKENS = ${budget.toLocaleString()}`);
  console.log("=".repeat(96));
  console.log(
    "run".padEnd(5) + "finish".padStart(9) + "out tok".padStart(9) +
    "chars".padStart(8) + "title".padStart(7) + "narr".padStart(6) +
    "dec".padStart(5) + "files".padStart(7) + "conc".padStart(6) + "score".padStart(7),
  );
  console.log("-".repeat(96));

  const scores: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "cf-aig-skip-cache": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: budget,
        max_completion_tokens: budget,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      console.log(`${String(i + 1).padEnd(5)}  HTTP ${res.status}`);
      continue;
    }
    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const content: string = choice?.message?.content ?? "";
    const finish: string = choice?.finish_reason ?? "?";
    const outTok = data.usage?.completion_tokens ?? 0;
    const s = parse(content);
    const score = s ? scoreSummary(s) : 0;
    scores.push(score);

    console.log(
      String(i + 1).padEnd(5) +
      finish.padStart(9) +
      String(outTok).padStart(9) +
      String(content.length).padStart(8) +
      (s?.title ? "y" : "-").padStart(7) +
      (s?.narrative ? String(s.narrative.length) : "-").padStart(6) +
      String(s?.keyDecisions.length ?? "-").padStart(5) +
      String(s?.filesModified.length ?? "-").padStart(7) +
      String(s?.concepts.length ?? "-").padStart(6) +
      String(score).padStart(7),
    );

    if (score < 100) failures.push(`--- budget=${budget} run=${i + 1} finish=${finish} score=${score} ---\n${content}\n`);
  }
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  console.log("-".repeat(96));
  console.log(`  mean score ${avg.toFixed(1)}   (benchmark saw 83.3 at MAX_TOKENS=8192)`);
}

if (failures.length) {
  const out = `${homedir()}/.agentmemory/deepseek-quality-failures.txt`;
  writeFileSync(out, failures.join("\n"));
  console.log(`\n${failures.length} sub-100 response(s) written to ${out}`);
} else {
  console.log("\nno sub-100 responses in this run");
}
