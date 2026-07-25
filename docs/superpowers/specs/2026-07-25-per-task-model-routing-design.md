# Per-task model routing

**Date:** 2026-07-25
**Status:** Approved, not yet implemented
**Branch:** `feat/per-task-model-routing` (off `feat/cloudflare-provider`)

## Problem

Every memory task shares one LLM. `compress` fires on each PostToolUse when
`AGENTMEMORY_AUTO_COMPRESS` is on; `reflect` and `consolidate` run rarely and
produce memories that persist and get recalled for weeks. They have opposite
cost/quality profiles and no way to express that.

Measured on Cloudflare Workers AI, the spread across usable models is ~6.5x on
cost and ~7x on latency for the same prompt. One global model forces a
compromise: overpay on the firehose, or underserve the memories that last.

## Goals

- An independent model per memory task.
- Unset tasks inherit the global default, so zero-config behaviour is unchanged.
- Provider-agnostic mechanism — nothing Cloudflare-specific in the routing.
- Visibility into which model actually served each task.

## Non-goals

Deliberately excluded to keep the change small:

- Per-task `MAX_TOKENS` or timeouts.
- Per-task *providers* (see Future extensions).
- Runtime reconfiguration without restart.
- Boot-time validation of model names.

## Key decision: route at the registration seam

`src/index.ts` already injects the provider into 14 named registration sites:

```ts
registerCompressFunction(sdk, kv, provider, metricsStore);
registerReflectFunctions(sdk, kv, provider);
registerConsolidateFunction(sdk, kv, provider);
// ...
```

Each task already receives its own provider *reference*; they merely happen to
point at one instance. Routing per task therefore means handing each
registration a differently-configured provider — not threading task identity
through `MemoryProvider`.

Alternatives rejected:

- **Add a `task` parameter to `MemoryProvider.compress/summarize`.** Changes the
  interface, all provider implementations, and ~16 call sites, to recover
  information already known at registration.
- **Read `CLOUDFLARE_<TASK>_MODEL` inside `CloudflareProvider`.** Impossible
  without the above; the provider cannot know its caller.

The seam also dissolves a problem that blocked earlier thinking: consolidation
spans both provider methods (`consolidate.ts` calls `compress()`,
`consolidation-pipeline.ts` calls `summarize()`). Because they are separate
registrations, they can take separate models regardless.

## Architecture

New module `src/providers/task-router.ts`:

```ts
export type MemoryTask =
  | "compress" | "summarize" | "consolidate" | "consolidation-pipeline"
  | "graph" | "reflect" | "crystallize" | "skill-extract"
  | "sliding-window" | "query-expansion" | "temporal-graph"
  | "flow-compress" | "compress-file";

export function makeTaskProviderFactory(
  config: AgentMemoryConfig,
  fallbackConfig: FallbackConfig,
): {
  providerFor(task: MemoryTask): ResilientProvider;
  allProviders(): ResilientProvider[];
  routingSummary(): Map<string, MemoryTask[]>;
};
```

Resolution order per task:

1. `AGENTMEMORY_<TASK>_MODEL` (task name upper-cased, `-` → `_`)
2. `config.provider.model` (the existing global default)

Providers are **memoised by resolved model string**. Tasks left on the default
share one instance rather than each constructing their own. Fallback chains are
preserved by routing construction through the existing `createFallbackProvider`
/ `createProvider` pair, so `FALLBACK_PROVIDERS` keeps working per instance.

`src/index.ts` changes from `provider` to `providerFor("<task>")` at 13 sites.
`registerApiTriggers` keeps the plain default provider — it only reads
`provider.circuitState` for health and makes no LLM calls.

## Task map

Thirteen routed tasks. The grouping below is the *recommended starting
configuration* shipped commented-out in `.env.example`, not a construct the code
knows about — the router only ever asks "is this task's var set?".

| Task | Registration site | Recommended |
|-|-|-|
| `summarize` | `registerSummarizeFunction` | strong |
| `reflect` | `registerReflectFunctions` | strong |
| `consolidate` | `registerConsolidateFunction` | strong |
| `consolidation-pipeline` | `registerConsolidationPipelineFunction` | strong |
| `crystallize` | `registerCrystallizeFunction` | strong |
| `skill-extract` | `registerSkillExtractFunctions` | strong |
| `graph` | `registerGraphFunction` | strong |
| `compress` | `registerCompressFunction` | cheap |
| `query-expansion` | `registerQueryExpansionFunction` | cheap |
| `sliding-window` | `registerSlidingWindowFunction` | cheap |
| `flow-compress` | `registerFlowCompressFunction` | cheap |
| `compress-file` | `registerCompressFileFunction` | cheap |
| `temporal-graph` | `registerTemporalGraphFunctions` | cheap |

The split is "does this produce memory that persists and gets recalled later".
Strong tasks run rarely and their output is read for weeks; cheap tasks are
high-volume or transient.

`AGENTMEMORY_GRAPH_MODEL` matches the variable proposed in upstream PR #954, so
the naming stays compatible if that lands.

## Configuration

All thirteen variables are documented in `.env.example`, commented out, with
recommended values filled in:

```bash
# Per-task model routing. Any unset task uses the global provider model.
# AGENTMEMORY_SUMMARIZE_MODEL=@cf/openai/gpt-oss-120b
# AGENTMEMORY_REFLECT_MODEL=@cf/openai/gpt-oss-120b
# ...
# AGENTMEMORY_COMPRESS_MODEL=@cf/meta/llama-3.2-3b-instruct
# AGENTMEMORY_QUERY_EXPANSION_MODEL=@cf/meta/llama-3.2-3b-instruct
```

A middle option, `@cf/openai/gpt-oss-20b`, is noted alongside for tasks that
matter without being durable memory — half the cost of the 120b with correct
file extraction, but less reliable at pulling out decisions (Appendix A).

The fallback is deliberate: without it, adding a task later would stop the
daemon booting until a new variable was set. Inheriting the default is the safer
failure mode.

## Failure modes

**Circuit breakers.** Each distinct model gets its own `ResilientProvider` and
breaker. Because memoisation keys on the model string, the breaker tracks that
model's endpoint — seven tasks on the default discover an outage once, not seven
times.

**Health reporting.** Today `/agentmemory/health` reports the single provider's
`circuitState`. Once `compress` runs on a different provider, that reading would
silently omit the highest-volume path. The factory therefore exposes
`allProviders()`, and health reports the **most degraded** state across them.
Without this the change would ship a health regression.

**Invalid model names.** No boot-time validation: the set of live `@cf/*` models
is only knowable via an API call, and a stale allowlist would block startup on
valid input. Failures surface at call time instead, where they are already
legible — a deprecated model returns HTTP 410, and the truncation error names
the model. A typo in one task's variable fails that task alone.

## Boot visibility

Only deviations from the default are printed, so zero-config output is unchanged:

```
Provider: cloudflare (@cf/openai/gpt-oss-120b)
  ↳ compress, query-expansion, sliding-window,
    flow-compress, compress-file, temporal-graph → @cf/meta/llama-3.2-3b-instruct
```

## Testing

- Unset variable → task provider uses the global default model.
- Set variable → that task moves, and no other task does.
- Two tasks resolving to the same model share one provider instance; different
  models get different instances.
- The `MemoryTask` union is exhaustive over registration sites, checked at
  compile time, so a fourteenth task cannot silently skip routing.
- Health reports the most degraded breaker across providers, not the default's.
- One live check: set `AGENTMEMORY_SUMMARIZE_MODEL`, call
  `/agentmemory/summarize`, confirm the routed model served it.

Tests follow the existing convention: `test/task-router.test.ts`, named after
behaviour, with env keys blanked rather than deleted (see
`test/cloudflare-provider.test.ts` — `getMergedEnv` layers `process.env` over
`~/.agentmemory/.env`, so deleting a key lets the file's value through).

## Compatibility

With no variables set, behaviour is identical to today: one provider, one model,
one breaker, unchanged boot output.

## Future extensions

**Per-task provider, not just model.** The factory already builds each provider
from a full `ProviderConfig`, so allowing `AGENTMEMORY_<TASK>_PROVIDER` — running
`reflect` on Anthropic while `compress` stays on Cloudflare — is an additional
field in that config, not a redesign. Deferred because it needs a decision on
per-task credentials.

## Appendix A: model selection benchmark — realistic session

Measured 2026-07-25 against live Workers AI using the real `SUMMARY_SYSTEM`
prompt and `buildSummaryPrompt`, over a seeded 21-observation session
(5,054 chars) representing a multi-file billing refactor. Three runs each.
`neurons` as reported by the API. The session touches exactly 8 files, so the
file count is an objective accuracy check rather than a taste judgement.

| Model | neurons | sec | decisions | concepts | files (8 = correct) |
|-|-|-|-|-|-|
| `@cf/meta/llama-3.2-3b-instruct` | 14.0–15.1 | 1.2 | 1, 1, 1 | 2–3 | 8, 9, 7 |
| `@cf/openai/gpt-oss-20b` | 45.9–57.8 | 3.8–6.8 | 1, 4, 4 | 5–8 | 8, 8, 8 |
| `@cf/openai/gpt-oss-120b` | 103–112 | 4.5–6.6 | 4, 4, 4 | 7–8 | 8, 8, 8 |
| `@cf/google/gemma-4-26b-a4b-it` | 51.5–56.7 | 12.1–13.7 | 3, 4, 3 | 5–6 | 8, 8, 8 |
| `@cf/zai-org/glm-5.2` | 389.7–396.1 | 5.4–9.6 | 4, 5, 4 | 8–9 | 8, 8, 8 |
| `@cf/moonshotai/kimi-k2.6` | 379.2–584.6 | 18.0–30.6 | 5, 5, 4 | 8 | 8, 8, 8 |

**Strong tier — `@cf/openai/gpt-oss-120b`.** The only model with zero variance on
decision extraction (4/4/4) and correct file lists every run, at roughly a
quarter of GLM 5.2's cost and a fifth of Kimi K2.6's. GLM buys one extra concept
for 3.6x the price; Kimi buys one extra decision for 4.6x the price and 18–31s
of latency.

**Cheap tier — `@cf/meta/llama-3.2-3b-instruct`.** Fastest and cheapest by a wide
margin, but at realistic input it extracts 2–3 concepts against the 120b's 7–8,
never more than one decision, and produced *incorrect* file lists (9 and 7
against a true 8 — one hallucinated, one dropped). Appropriate for `compress`,
which summarises a single observation, and disqualifying for anything durable.
This is the concrete justification for the tier split.

**Documented middle option — `@cf/openai/gpt-oss-20b`.** Half the cost of the
120b with perfect file accuracy, but decision extraction swung 1, 4, 4 across
three runs. Reasonable for tasks that matter without being durable memory;
listed in `.env.example` as an alternative users can assign per task.

**Rejected.** `gemma-4-26b-a4b-it`: cheaper than the 120b but 2.5x slower with
fewer concepts; its 256k context is the only reason to reach for it.
`kimi-k2.6` / `kimi-k2.7-code`: frontier 1T-parameter models whose extraction
matched the 120b's while costing 4-5x and taking 18–31s.
`nemotron-3-120b-a12b`: 3.6x run-to-run cost variance.
`llama-3.3-70b-instruct-fp8-fast`: vaguest titles, and see the context table.

Cost scaled ~2.8x for every model as input grew ~8x, so the ranking is not an
artifact of prompt size.

## Appendix B: context windows

Checked because it nearly bit us — `llama-3.3-70b-instruct-fp8-fast` was a
serious candidate on cost before this was known.

| Model | Context |
|-|-|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 24k |
| `@cf/meta/llama-3.2-3b-instruct` | 80k |
| `@cf/openai/gpt-oss-120b`, `gpt-oss-20b` | 128k |
| `@cf/google/gemma-4-26b-a4b-it` | 256k |
| `@cf/moonshotai/kimi-k2.6`, `@cf/zai-org/glm-5.2` | 262k |

24k would constrain `summarize` and `consolidation-pipeline` on long sessions.
The selected models — 128k strong, 80k cheap — have ample headroom.

## Appendix C: small-session benchmark (superseded)

The first pass used a 3-observation session (605 chars). Retained because it is
what disqualified the original default and surfaced the format issue; Appendix A
supersedes it for model selection.

| Model | neurons | out tok | sec | Notes |
|-|-|-|-|-|
| `@cf/meta/llama-3.2-3b-instruct` | 5.9 / 6.3 | 137 | 0.9 | clean XML |
| `@cf/meta/llama-3.1-8b-instruct-fp8` | 9.2 / 9.6 | 167 | 8.8 | prose before `<summary>` |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 18.6 / 23.9 | 558 | 5.6–10.3 | clean |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 21.2 / 21.9 | 194 | 3.1 | prose before `<summary>` |
| `@cf/openai/gpt-oss-120b` | 37.4–39.8 (5 runs) | ~370 | 2.2–6.4 | clean, most stable |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 44.8–46.5 (5 runs) | ~174 | 2.8–6.5 | vaguest titles |
| `@cf/zai-org/glm-5.2` | 129.0–170.6 (5 runs) | 211–227 | 2.7–5.1 | needs MAX_TOKENS ≥ 4096 |
| `@cf/nvidia/nemotron-3-120b-a12b` | 528.5 / 144.9 / 150.8 | 944–3764 | 8.4–32.2 | 3.6x run-to-run variance |

Every model produced valid XML against the required tag set, so format
compliance never discriminated at either session size. Two findings from this
pass still stand:

- `@cf/meta/llama-3.1-8b-instruct-fp8`, the provider's default at the time, was
  the slowest model tested (8.8s) and one of only two that emitted prose before
  `<summary>` despite the prompt forbidding it. The daemon's parser tolerates
  the preamble, but it is the model disobeying the instruction.
- Small sessions do not separate models. Every candidate looked adequate at 605
  characters; the 3B's concept and file-accuracy failures only appeared at
  realistic size. Do not select models on short prompts.

Reproduce with `bench-models.ts` and `seed-large-session.ts` (untracked
working-tree scripts).
