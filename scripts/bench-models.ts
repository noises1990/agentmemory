/**
 * One-off model benchmark for the summarize workload.
 *
 * Not part of the build or the test suite — run it by hand, read the table,
 * delete it or keep it, it does not matter to the product.
 *
 *   powershell:  $env:CLOUDFLARE_API_TOKEN = (& ~/.agentmemory/scripts/credstore.ps1 -Get -Name agentmemory/CLOUDFLARE_API_TOKEN)
 *                npx tsx scripts/bench-models.ts
 *
 * What it measures, and why each choice matters:
 *
 *  - REAL prompts. It pulls actual observations out of the running daemon
 *    and builds the prompt with buildSummaryPrompt(), the same function
 *    production uses. A benchmark on synthetic text would mostly measure
 *    how models handle synthetic text.
 *
 *  - REAL scoring. Quality is scoreSummary() from src/eval/quality.ts —
 *    the metric the dashboard already reports — plus the XML parse rate,
 *    which is the failure mode that actually bites here: a model that
 *    writes prose around its XML, or spends its output budget on
 *    reasoning, scores zero regardless of how clever it is.
 *
 *  - REAL prices, read from Cloudflare's own model catalogue
 *    (/accounts/{id}/ai/models/search returns a `price` property per
 *    model), not from a table I typed in. DeepSeek is a custom gateway
 *    provider so it is not in that catalogue; its published rate is
 *    hardcoded below and labelled as such.
 *
 *  - CACHE DISABLED. The AI Gateway caches aggressively — an identical
 *    summarize call returned in 113ms against a true cost of ~17s. Every
 *    request here sends `cf-aig-skip-cache: true`, or the latency column
 *    would be measuring the cache.
 *
 * Two workloads, because "best model" depends on which question you ask:
 *
 *    chunk  — ~60 observations. Fits every model including the 32k
 *             baseline, so it is an honest head-to-head.
 *    full   — the entire session. Only large-context models can attempt
 *             it; the rest are expected to fail with 413, which is the
 *             point. This is the workload that was broken.
 */

import { homedir } from "node:os";
import { SUMMARY_SYSTEM, buildSummaryPrompt } from "../src/prompts/summary.js";
import { getXmlTag, getXmlChildren } from "../src/prompts/xml.js";
import { scoreSummary } from "../src/eval/quality.js";
import type { CompressedObservation } from "../src/types.js";

const REST = process.env["AGENTMEMORY_URL"] || "http://127.0.0.1:3111";
const TOKEN = process.env["CLOUDFLARE_API_TOKEN"] || "";
const ACCOUNT = await readAccountId();
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/open-gate-spekter/compat/chat/completions`;

/** Repetitions per model per workload. Latency is noisy; 3 is enough to see past a bad draw. */
const REPS = 3;
/** Output budget. Matches MAX_TOKENS in ~/.agentmemory/.env. */
const MAX_TOKENS = 8192;

const DEEPSEEK_PRICE = { in: 0.14, out: 0.28, note: "published rate (not in CF catalogue)" };

const MODELS = [
  "deepseek/deepseek-v4-flash",
  "workers-ai/@cf/openai/gpt-oss-120b",
  "workers-ai/@cf/openai/gpt-oss-20b",
  "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
  "workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct",
  "workers-ai/@cf/google/gemma-4-26b-a4b-it",
  "workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
  "workers-ai/@cf/moonshotai/kimi-k2.6",
  // The model that was configured when every summary was failing. Kept as
  // the control: any improvement should be measured against it, not against
  // an idealised baseline.
  "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8",
];

async function readAccountId(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const env = readFileSync(`${homedir()}/.agentmemory/.env`, "utf-8");
  const m = /^CLOUDFLARE_ACCOUNT_ID=(.+)$/m.exec(env);
  if (!m || !m[1]) throw new Error("CLOUDFLARE_ACCOUNT_ID not found in ~/.agentmemory/.env");
  return m[1].trim();
}

interface Price { in: number | null; out: number | null; note?: string }

async function loadPrices(): Promise<Map<string, Price>> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/models/search?per_page=300`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  const body = (await res.json()) as { result?: Array<Record<string, any>> };
  const out = new Map<string, Price>();
  for (const m of body.result ?? []) {
    let p: Price = { in: null, out: null };
    for (const prop of m.properties ?? []) {
      if (prop.property_id !== "price") continue;
      for (const v of prop.value ?? []) {
        if (String(v.unit).includes("input")) p.in = v.price;
        else if (String(v.unit).includes("output")) p.out = v.price;
      }
    }
    out.set(`workers-ai/${m.name}`, p);
  }
  out.set("deepseek/deepseek-v4-flash", {
    in: DEEPSEEK_PRICE.in, out: DEEPSEEK_PRICE.out, note: DEEPSEEK_PRICE.note,
  });
  return out;
}

async function loadObservations(): Promise<CompressedObservation[]> {
  const sres = await fetch(`${REST}/agentmemory/sessions`);
  const { sessions } = (await sres.json()) as { sessions: Array<{ id: string; observationCount?: number }> };
  // Biggest session available — the interesting case.
  const target = sessions.sort((a, b) => (b.observationCount ?? 0) - (a.observationCount ?? 0))[0];
  if (!target) throw new Error("no sessions in the store to benchmark against");
  const ores = await fetch(`${REST}/agentmemory/observations?sessionId=${encodeURIComponent(target.id)}&limit=10000`);
  const body = (await ores.json()) as { observations?: CompressedObservation[] };
  const obs = (body.observations ?? []).filter((o) => o.title);
  if (obs.length === 0) throw new Error(`session ${target.id} has no compressed observations`);
  console.log(`corpus: session ${target.id} — ${obs.length} observations\n`);
  return obs;
}

interface Run {
  ok: boolean;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  parsed: boolean;
  quality: number;
  error?: string;
}

async function callModel(model: string, userPrompt: string): Promise<Run> {
  const started = Date.now();
  try {
    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        // Without this the gateway serves a cached completion and the
        // latency column becomes fiction.
        "cf-aig-skip-cache": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        max_completion_tokens: MAX_TOKENS,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = await res.text();
      const short = /context window limit/i.test(text)
        ? "413 context overflow"
        : `HTTP ${res.status}`;
      return { ok: false, ms, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, parsed: false, quality: 0, error: short };
    }
    const data = (await res.json()) as any;
    const content: string = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage ?? {};
    const summary = parseSummary(content);
    return {
      ok: true,
      ms,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      parsed: summary !== null,
      quality: summary ? scoreSummary(summary) : 0,
    };
  } catch (err) {
    return {
      ok: false, ms: Date.now() - started, promptTokens: 0, completionTokens: 0,
      reasoningTokens: 0, parsed: false, quality: 0,
      error: err instanceof Error ? err.message.slice(0, 40) : String(err).slice(0, 40),
    };
  }
}

/** Mirrors summarize.ts: strip fences/preamble, then require a <title>. */
function parseSummary(raw: string) {
  let cleaned = (raw || "").trim().replace(/```\s*xml\s*\n?/gi, "").replace(/```/g, "").trim();
  const root = cleaned.match(/(<[a-zA-Z_][\w-]*>[\s\S]*<\/[a-zA-Z_][\w-]*>)/);
  if (root && root[1]) cleaned = root[1].trim();
  const title = getXmlTag(cleaned, "title");
  if (!title) return null;
  return {
    title,
    narrative: getXmlTag(cleaned, "narrative"),
    keyDecisions: getXmlChildren(cleaned, "decisions", "decision"),
    filesModified: getXmlChildren(cleaned, "files", "file"),
    concepts: getXmlChildren(cleaned, "concepts", "concept"),
  };
}

function agg(runs: Run[], price: Price | undefined) {
  const good = runs.filter((r) => r.ok);
  const med = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const pIn = good.length ? good.reduce((a, r) => a + r.promptTokens, 0) / good.length : 0;
  const pOut = good.length ? good.reduce((a, r) => a + r.completionTokens, 0) / good.length : 0;
  const cost = price?.in != null && price?.out != null
    ? (pIn / 1e6) * price.in + (pOut / 1e6) * price.out
    : null;
  return {
    okRate: runs.length ? good.length / runs.length : 0,
    parseRate: good.length ? good.filter((r) => r.parsed).length / good.length : 0,
    medMs: med(good.map((r) => r.ms)),
    quality: good.length ? good.reduce((a, r) => a + r.quality, 0) / good.length : 0,
    reasoning: good.length ? good.reduce((a, r) => a + r.reasoningTokens, 0) / good.length : 0,
    costPerCall: cost,
    error: good.length === 0 ? runs.find((r) => r.error)?.error : undefined,
  };
}

const prices = await loadPrices();
const observations = await loadObservations();

const WORKLOADS: Array<{ name: string; obs: CompressedObservation[] }> = [
  { name: "chunk", obs: observations.slice(0, 60) },
  { name: "full", obs: observations },
];

for (const wl of WORKLOADS) {
  const prompt = buildSummaryPrompt(wl.obs);
  const approxTokens = Math.round(prompt.length / 3.2);
  console.log(`\n${"=".repeat(112)}`);
  console.log(`WORKLOAD "${wl.name}" — ${wl.obs.length} observations, ${prompt.length.toLocaleString()} chars (~${approxTokens.toLocaleString()} tokens), ${REPS} reps`);
  console.log("=".repeat(112));
  console.log(
    "model".padEnd(46) + "ok".padStart(6) + "parse".padStart(7) +
    "p50 ms".padStart(9) + "qual".padStart(7) + "reason".padStart(8) +
    "$/call".padStart(11) + "  note",
  );
  console.log("-".repeat(112));

  const results: Array<{ model: string; a: ReturnType<typeof agg> }> = [];
  for (const model of MODELS) {
    const runs: Run[] = [];
    for (let i = 0; i < REPS; i++) runs.push(await callModel(model, prompt));
    const a = agg(runs, prices.get(model));
    results.push({ model, a });
    const short = model.replace(/^workers-ai\/@cf\//, "").replace(/^deepseek\//, "");
    console.log(
      short.padEnd(46) +
      `${(a.okRate * 100).toFixed(0)}%`.padStart(6) +
      `${(a.parseRate * 100).toFixed(0)}%`.padStart(7) +
      `${a.medMs}`.padStart(9) +
      `${a.quality.toFixed(1)}`.padStart(7) +
      `${a.reasoning.toFixed(0)}`.padStart(8) +
      (a.costPerCall == null ? "n/a".padStart(11) : `$${a.costPerCall.toFixed(5)}`.padStart(11)) +
      "  " + (a.error ?? ""),
    );
  }

  const usable = results.filter((r) => r.a.okRate > 0 && r.a.parseRate > 0.5);
  if (usable.length) {
    const best = [...usable].sort((a, b) => b.a.quality - a.a.quality)[0]!;
    const fastest = [...usable].sort((a, b) => a.a.medMs - b.a.medMs)[0]!;
    const cheapest = [...usable]
      .filter((r) => r.a.costPerCall != null)
      .sort((a, b) => a.a.costPerCall! - b.a.costPerCall!)[0];
    console.log("-".repeat(112));
    console.log(`  best quality : ${best.model}  (${best.a.quality.toFixed(1)})`);
    console.log(`  fastest      : ${fastest.model}  (${fastest.a.medMs} ms)`);
    if (cheapest) console.log(`  cheapest     : ${cheapest.model}  ($${cheapest.a.costPerCall!.toFixed(5)}/call)`);
  } else {
    console.log("-".repeat(112));
    console.log("  no model produced a parseable summary for this workload");
  }
}

console.log(
  `\nprices: Cloudflare model catalogue (live), except deepseek-v4-flash — ${DEEPSEEK_PRICE.note}.` +
  `\ncache:  disabled per request via cf-aig-skip-cache.` +
  `\nqual:   scoreSummary() from src/eval/quality.ts. parse: fraction of successful calls yielding valid summary XML.`,
);
