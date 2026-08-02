import { SUMMARY_SYSTEM, buildSummaryPrompt } from "./src/prompts/summary.js";

const ACCOUNT = process.env["CLOUDFLARE_ACCOUNT_ID"]!;
const TOKEN = process.env["CLOUDFLARE_API_TOKEN"]!;
const URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`;

const MODELS = [
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/openai/gpt-oss-20b",
  "@cf/openai/gpt-oss-120b",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/zai-org/glm-5.2",
  "@cf/moonshotai/kimi-k2.6",
];
const RUNS = 3;

// The XML contract SUMMARY_SYSTEM demands. A model that misses these produces
// a summary the daemon cannot parse, which matters more than prose quality.
const REQUIRED = ["summary", "title", "narrative", "decisions", "files", "concepts"];

async function observations() {
  const res = await fetch("http://localhost:3111/agentmemory/observations?sessionId=" + process.env["SID"]);
  const json = (await res.json()) as { observations: any[] };
  return json.observations.map((o) => ({
    type: o.type ?? "edit",
    title: o.subtitle ?? o.title ?? "",
    facts: o.facts ?? [],
    narrative: o.narrative ?? "",
    files: o.files ?? [],
    concepts: o.concepts ?? [],
  }));
}

function grade(text: string) {
  const missing = REQUIRED.filter((t) => !new RegExp(`<${t}>`).test(text));
  const title = /<title>([\s\S]*?)<\/title>/.exec(text)?.[1]?.trim() ?? "";
  const decisions = (text.match(/<decision>/g) ?? []).length;
  const concepts = (text.match(/<concept>/g) ?? []).length;
  const files = (text.match(/<file>/g) ?? []).length;
  const preamble = !/^\s*<summary>/.test(text); // "no additional text" was instructed
  return { missing, title, decisions, concepts, files, preamble };
}

async function main() {
  const obs = await observations();
  const userPrompt = buildSummaryPrompt(obs);
  console.log(`prompt built from ${obs.length} real observations (${userPrompt.length} chars)\n`);

  const rows: any[] = [];
  for (const model of MODELS) {
    for (let run = 1; run <= RUNS; run++) {
      const t0 = Date.now();
      try {
        const res = await fetch(URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            max_tokens: 4096,
            messages: [
              { role: "system", content: SUMMARY_SYSTEM },
              { role: "user", content: userPrompt },
            ],
          }),
        });
        const ms = Date.now() - t0;
        if (!res.ok) {
          rows.push({ model, run, err: `HTTP ${res.status}`, ms });
          continue;
        }
        const d: any = await res.json();
        const msg = d.choices?.[0]?.message ?? {};
        const text = msg.content ?? d.choices?.[0]?.text ?? "";
        rows.push({
          model,
          run,
          ms,
          neurons: d.usage?.neurons ?? null,
          out: d.usage?.completion_tokens ?? null,
          finish: d.choices?.[0]?.finish_reason,
          empty: !text || !text.trim(),
          ...grade(text || ""),
          sample: (text || "").slice(0, 0),
          _title: grade(text || "").title,
        });
      } catch (e) {
        rows.push({ model, run, err: (e as Error).message.slice(0, 40), ms: Date.now() - t0 });
      }
    }
  }

  console.log(
    "MODEL".padEnd(45) + "RUN  " + "OK   " + "NEURONS".padStart(9) + "OUT".padStart(6) + "SEC".padStart(7) + " DECS" + " CONC" + " FILES" + "  NOTES",
  );
  for (const r of rows) {
    if (r.err) {
      console.log(`${r.model.padEnd(45)}${String(r.run).padEnd(5)}ERR  ${r.err}`);
      continue;
    }
    const ok = r.empty ? "EMPTY" : r.missing.length === 0 ? "yes  " : "NO   ";
    console.log(
      r.model.padEnd(45) +
        String(r.run).padEnd(5) +
        ok +
        String(r.neurons?.toFixed(1) ?? "?").padStart(9) +
        String(r.out ?? "?").padStart(6) +
        (r.ms / 1000).toFixed(1).padStart(7) +
        String(r.decisions ?? 0).padStart(5) +
        String(r.concepts ?? 0).padStart(5) +
        String(r.files ?? 0).padStart(6) +
        "  " +
        (r.missing.length ? r.missing.join(",") : (r.preamble ? "(prose before <summary>)" : "-")),
    );
  }

  console.log("\n--- titles produced (run 1) ---");
  for (const r of rows.filter((x) => x.run === 1 && !x.err)) {
    console.log(`  ${r.model.padEnd(45)} ${JSON.stringify((r._title || "").slice(0, 70))}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
