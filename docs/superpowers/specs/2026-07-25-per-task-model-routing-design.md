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

## Appendix: benchmark data

Measured 2026-07-25 against live Workers AI using the real `SUMMARY_SYSTEM`
prompt and `buildSummaryPrompt`, over a 3-observation session (605 chars).
`neurons` as reported by the API.

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

All eight produced valid XML against the required tag set, so format compliance
did not discriminate. Selection came down to cost, stability and latency.

`@cf/openai/gpt-oss-120b` was chosen for the strong recommendation: cheapest
large model, tightest cost variance of any model tested (a 2.4 neuron spread
across five runs, against 41.6 for GLM 5.2 and 383.6 for Nemotron), and fastest
of the large models. `@cf/meta/llama-3.2-3b-instruct` was chosen for the cheap
recommendation: lowest cost, lowest latency, and unlike the current 8B default it
obeys the "no additional text" instruction.

Caveats: one prompt, one small session, and title quality was assessed
subjectively. Sufficient to separate tiers, not to rank models on nuance.

Reproduce with `bench-models.ts` (untracked working-tree script).
