# Per-Task Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each memory task its own LLM model via `AGENTMEMORY_<TASK>_MODEL`, so cheap models serve high-volume work and strong models serve memory that persists.

**Architecture:** A factory in `src/providers/task-router.ts` resolves a model per task name, builds one `ResilientProvider` per distinct model (memoised), and is injected at the 13 existing per-task registration sites in `src/index.ts`. No change to the `MemoryProvider` interface and no edits inside any memory function.

**Tech Stack:** TypeScript (ESM, strict), Vitest, Node >= 20.

**Spec:** `docs/superpowers/specs/2026-07-25-per-task-model-routing-design.md`

**Branch:** `feat/per-task-model-routing` (already created, off `feat/cloudflare-provider`)

## Global Constraints

- Node >= 20. TypeScript strict mode. No `any` unless justified in a comment.
- No code comments that restate what the code does. Comment only non-obvious *why*.
- No dead code, no commented-out imports.
- Tests live in `test/<feature>.test.ts` and are named after behaviour, not implementation.
- **Tests must blank env keys (`process.env[k] = ""`), never `delete` them.** `getMergedEnv()` layers `process.env` over the developer's real `~/.agentmemory/.env`, so a deleted key lets the file's value through and the suite fails on any machine with provider keys configured. See `test/cloudflare-provider.test.ts`.
- Commit with sign-off: `git commit -s`. No attribution trailers.
- Do not touch `CHANGELOG.md`.
- Do not commit to `feat/cloudflare-provider` — that branch is an open upstream PR.
- Baseline before starting: `npm test` shows **1441 passing, 0 failing**. (Earlier runs of this suite showed 5 failures in `test/hook-project.test.ts`; those tests assert `basename(cwd) === "agentmemory"` and only failed while the clone lived at `/tmp/agentmem-full`. The repo now sits at `~/Projects/agentmemory`, so they pass. Any failure you see is a real regression.)
- `npx tsc --noEmit` reports 25 pre-existing errors in unrelated files. Those are the baseline; do not fix them, but add no new ones.

---

### Task 1: The task router

**Files:**
- Create: `src/providers/task-router.ts`
- Test: `test/task-router.test.ts`

**Interfaces:**
- Consumes: `createProvider(config: ProviderConfig): ResilientProvider` and `createFallbackProvider(config: ProviderConfig, fallbackConfig: FallbackConfig): ResilientProvider` from `src/providers/index.ts`; `getEnvVar(key: string): string | undefined` from `src/config.ts`; types `AgentMemoryConfig`, `FallbackConfig`, `ProviderConfig`, `CircuitBreakerState` from `src/types.ts`; `ResilientProvider` from `src/providers/resilient.ts`.
- Produces: `MemoryTask` (union of 13 task names), `ALL_TASKS: MemoryTask[]`, `envVarForTask(task: MemoryTask): string`, `mostDegraded(states: CircuitBreakerState[]): CircuitBreakerState | null`, `TaskProviderFactory` with `providerFor(task: MemoryTask): ResilientProvider`, `allProviders(): ResilientProvider[]`, `routingSummary(): Map<string, MemoryTask[]>`, and `makeTaskProviderFactory(config: AgentMemoryConfig, fallbackConfig: FallbackConfig): TaskProviderFactory`.

- [ ] **Step 1: Write the failing test**

Create `test/task-router.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  ALL_TASKS,
  envVarForTask,
  makeTaskProviderFactory,
  mostDegraded,
} from "../src/providers/task-router.js";
import type { AgentMemoryConfig, FallbackConfig } from "../src/types.js";

const COMPETING_KEYS = [
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "FALLBACK_PROVIDERS",
];

// Blank rather than delete: getMergedEnv layers process.env over the
// developer's real ~/.agentmemory/.env, so deleting a key lets that file's
// value through.
function clearEnv(keys: string[]): void {
  for (const key of keys) process.env[key] = "";
}

const CONFIG: AgentMemoryConfig = {
  engineUrl: "ws://localhost:49134",
  restPort: 3111,
  streamsPort: 3112,
  provider: {
    provider: "cloudflare",
    model: "@cf/openai/gpt-oss-120b",
    maxTokens: 4096,
  },
  tokenBudget: 2000,
  maxObservationsPerSession: 500,
  compressionModel: "@cf/openai/gpt-oss-120b",
  dataDir: "/tmp/agentmemory-test",
};

const NO_FALLBACK: FallbackConfig = { providers: [] };

describe("envVarForTask", () => {
  it("upper-cases and underscores the task name", () => {
    expect(envVarForTask("compress")).toBe("AGENTMEMORY_COMPRESS_MODEL");
    expect(envVarForTask("skill-extract")).toBe("AGENTMEMORY_SKILL_EXTRACT_MODEL");
    expect(envVarForTask("consolidation-pipeline")).toBe(
      "AGENTMEMORY_CONSOLIDATION_PIPELINE_MODEL",
    );
  });
});

describe("makeTaskProviderFactory", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearEnv([...COMPETING_KEYS, ...ALL_TASKS.map(envVarForTask)]);
    process.env["CLOUDFLARE_API_TOKEN"] = "test-token";
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "test-account";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses the global default model when a task has no override", () => {
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    expect(f.routingSummary().get("@cf/openai/gpt-oss-120b")).toEqual(
      expect.arrayContaining(["summarize", "reflect"]),
    );
  });

  it("routes only the overridden task to its own model", () => {
    process.env["AGENTMEMORY_COMPRESS_MODEL"] = "@cf/meta/llama-3.2-3b-instruct";
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    expect(f.routingSummary().get("@cf/meta/llama-3.2-3b-instruct")).toEqual(["compress"]);
    expect(f.routingSummary().get("@cf/openai/gpt-oss-120b")).not.toContain("compress");
  });

  it("shares one provider instance across tasks on the same model", () => {
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    expect(f.providerFor("summarize")).toBe(f.providerFor("reflect"));
  });

  it("builds a distinct provider for a task on a different model", () => {
    process.env["AGENTMEMORY_COMPRESS_MODEL"] = "@cf/meta/llama-3.2-3b-instruct";
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    expect(f.providerFor("compress")).not.toBe(f.providerFor("summarize"));
  });

  it("treats a blank override as unset", () => {
    process.env["AGENTMEMORY_REFLECT_MODEL"] = "   ";
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    expect(f.providerFor("reflect")).toBe(f.providerFor("summarize"));
  });

  it("creates one provider per distinct model, not one per task", () => {
    process.env["AGENTMEMORY_COMPRESS_MODEL"] = "@cf/meta/llama-3.2-3b-instruct";
    process.env["AGENTMEMORY_QUERY_EXPANSION_MODEL"] = "@cf/meta/llama-3.2-3b-instruct";
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    expect(f.allProviders()).toHaveLength(2);
  });

  it("covers every task at construction so routing is known before first use", () => {
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    const routed = [...f.routingSummary().values()].flat();
    expect(routed.sort()).toEqual([...ALL_TASKS].sort());
  });
});

describe("mostDegraded", () => {
  const closed = { state: "closed", failures: 0, lastFailureAt: null, openedAt: null } as const;
  const halfOpen = { state: "half-open", failures: 3, lastFailureAt: 1, openedAt: 1 } as const;
  const open = { state: "open", failures: 9, lastFailureAt: 2, openedAt: 2 } as const;

  it("returns null when there are no providers", () => {
    expect(mostDegraded([])).toBeNull();
  });

  it("prefers open over half-open over closed", () => {
    expect(mostDegraded([closed, halfOpen, open])?.state).toBe("open");
    expect(mostDegraded([closed, halfOpen])?.state).toBe("half-open");
    expect(mostDegraded([closed, closed])?.state).toBe("closed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/task-router.test.ts`
Expected: FAIL — cannot resolve `../src/providers/task-router.js`.

- [ ] **Step 3: Write the implementation**

Create `src/providers/task-router.ts`:

```ts
import type {
  AgentMemoryConfig,
  CircuitBreakerState,
  FallbackConfig,
  ProviderConfig,
} from "../types.js";
import type { ResilientProvider } from "./resilient.js";
import { getEnvVar } from "../config.js";
import { createFallbackProvider, createProvider } from "./index.js";

export type MemoryTask =
  | "compress"
  | "summarize"
  | "consolidate"
  | "consolidation-pipeline"
  | "graph"
  | "reflect"
  | "crystallize"
  | "skill-extract"
  | "sliding-window"
  | "query-expansion"
  | "temporal-graph"
  | "flow-compress"
  | "compress-file";

// Record<MemoryTask, true> makes the list exhaustive at compile time: adding a
// task to the union without adding it here is a type error, so a new
// registration site cannot silently skip routing.
const TASK_SET: Record<MemoryTask, true> = {
  compress: true,
  summarize: true,
  consolidate: true,
  "consolidation-pipeline": true,
  graph: true,
  reflect: true,
  crystallize: true,
  "skill-extract": true,
  "sliding-window": true,
  "query-expansion": true,
  "temporal-graph": true,
  "flow-compress": true,
  "compress-file": true,
};

export const ALL_TASKS = Object.keys(TASK_SET) as MemoryTask[];

export function envVarForTask(task: MemoryTask): string {
  return `AGENTMEMORY_${task.replace(/-/g, "_").toUpperCase()}_MODEL`;
}

const DEGRADATION_RANK: Record<CircuitBreakerState["state"], number> = {
  closed: 0,
  "half-open": 1,
  open: 2,
};

export function mostDegraded(
  states: CircuitBreakerState[],
): CircuitBreakerState | null {
  if (states.length === 0) return null;
  return states.reduce((worst, s) =>
    DEGRADATION_RANK[s.state] > DEGRADATION_RANK[worst.state] ? s : worst,
  );
}

export interface TaskProviderFactory {
  providerFor(task: MemoryTask): ResilientProvider;
  allProviders(): ResilientProvider[];
  routingSummary(): Map<string, MemoryTask[]>;
}

export function makeTaskProviderFactory(
  config: AgentMemoryConfig,
  fallbackConfig: FallbackConfig,
): TaskProviderFactory {
  const byModel = new Map<string, ResilientProvider>();
  const tasksByModel = new Map<string, MemoryTask[]>();

  const build = (model: string): ResilientProvider => {
    const providerConfig: ProviderConfig = { ...config.provider, model };
    return fallbackConfig.providers.length > 0
      ? createFallbackProvider(providerConfig, fallbackConfig)
      : createProvider(providerConfig);
  };

  const resolve = (task: MemoryTask): ResilientProvider => {
    const override = getEnvVar(envVarForTask(task))?.trim();
    const model = override || config.provider.model;

    let provider = byModel.get(model);
    if (!provider) {
      provider = build(model);
      byModel.set(model, provider);
    }

    const tasks = tasksByModel.get(model) ?? [];
    if (!tasks.includes(task)) {
      tasks.push(task);
      tasksByModel.set(model, tasks);
    }
    return provider;
  };

  // Resolve every task up front so routingSummary() is complete for the boot
  // log, and so a broken provider config fails at startup rather than on the
  // first background job hours later.
  for (const task of ALL_TASKS) resolve(task);

  return {
    providerFor: resolve,
    allProviders: () => [...byModel.values()],
    routingSummary: () => tasksByModel,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/task-router.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck the new file**

Run: `npx tsc --noEmit 2>&1 | grep -i task-router`
Expected: no output. (`npx tsc --noEmit` overall still reports 25 pre-existing errors in other files — that is the baseline, leave them.)

- [ ] **Step 6: Commit**

```bash
git add src/providers/task-router.ts test/task-router.test.ts
git commit -s -m "feat(providers): add per-task model router

Resolves AGENTMEMORY_<TASK>_MODEL per memory task, falling back to the
global provider model, and memoises one ResilientProvider per distinct
model so tasks sharing a model share a circuit breaker."
```

---

### Task 2: Wire the registration sites and boot visibility

**Files:**
- Modify: `src/index.ts` (13 registration calls between lines 243-333; provider construction around lines 165-168; boot log around lines 175-177)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `makeTaskProviderFactory`, `MemoryTask` from Task 1.
- Produces: a `taskProviders` value in `main()` that Task 3 uses for health aggregation via `taskProviders.allProviders()`.

- [ ] **Step 1: Add the factory next to the existing provider construction**

In `src/index.ts`, find:

```ts
  const provider =
    fallbackConfig.providers.length > 0
      ? createFallbackProvider(config.provider, fallbackConfig)
      : createProvider(config.provider);
```

Replace with:

```ts
  const taskProviders = makeTaskProviderFactory(config, fallbackConfig);
  const provider =
    fallbackConfig.providers.length > 0
      ? createFallbackProvider(config.provider, fallbackConfig)
      : createProvider(config.provider);
```

Add the import alongside the existing `./providers/index.js` import:

```ts
import { makeTaskProviderFactory } from "./providers/task-router.js";
```

`provider` is kept — `registerApiTriggers` still takes it, and Task 3 changes that.

- [ ] **Step 2: Add the routing lines to the boot log**

Find:

```ts
  bootLog(
    `Provider: ${config.provider.provider} (${config.provider.model})`,
  );
```

Add immediately after:

```ts
  for (const [model, tasks] of taskProviders.routingSummary()) {
    if (model === config.provider.model) continue;
    bootLog(`  ↳ ${tasks.join(", ")} → ${model}`);
  }
```

With no overrides set the loop body never runs, so zero-config boot output is unchanged.

- [ ] **Step 3: Replace `provider` with `providerFor(...)` at the 13 task sites**

Make exactly these substitutions in `src/index.ts`. Leave line 372 (`registerApiTriggers`) alone — Task 3 handles it.

```ts
registerCompressFunction(sdk, kv, taskProviders.providerFor("compress"), metricsStore);
registerSummarizeFunction(sdk, kv, taskProviders.providerFor("summarize"), metricsStore);
registerConsolidateFunction(sdk, kv, taskProviders.providerFor("consolidate"));
registerGraphFunction(sdk, kv, taskProviders.providerFor("graph"));
registerConsolidationPipelineFunction(sdk, kv, taskProviders.providerFor("consolidation-pipeline"));
registerFlowCompressFunction(sdk, kv, taskProviders.providerFor("flow-compress"));
registerCrystallizeFunction(sdk, kv, taskProviders.providerFor("crystallize"));
registerReflectFunctions(sdk, kv, taskProviders.providerFor("reflect"));
registerSkillExtractFunctions(sdk, kv, taskProviders.providerFor("skill-extract"));
registerSlidingWindowFunction(sdk, kv, taskProviders.providerFor("sliding-window"));
registerQueryExpansionFunction(sdk, taskProviders.providerFor("query-expansion"));
registerTemporalGraphFunctions(sdk, kv, taskProviders.providerFor("temporal-graph"));
registerCompressFileFunction(sdk, kv, taskProviders.providerFor("compress-file"));
```

Note `registerQueryExpansionFunction` takes `(sdk, provider)` with no `kv`, and `registerGraphFunction` sits inside an `if` block — keep both shapes as they are.

- [ ] **Step 4: Verify no task site was missed**

Run: `grep -nE "register[A-Za-z]+\(sdk, (kv, )?provider" src/index.ts`
Expected: no output. Every remaining bare `provider` reference should be the `registerApiTriggers` call and the boot log.

- [ ] **Step 5: Build and run the full suite**

Run: `npm run build && npm test 2>&1 | tail -4`
Expected: build succeeds; 1436 passing, 5 failing (the pre-existing `hook-project` failures only).

- [ ] **Step 6: Document all 13 variables in `.env.example`**

Add after the existing Cloudflare LLM block (the one ending with `CLOUDFLARE_TIMEOUT_MS`):

```bash
# -----------------------------------------------------------------------------
# Per-task model routing
# -----------------------------------------------------------------------------
# Each memory task can run on its own model. Any task left unset uses the
# provider's global model above. Values are passed through to whichever
# provider is active, so these are not Cloudflare-specific.
#
# Durable memory — output is stored and recalled later, so extraction quality
# matters more than cost. These run rarely.
# AGENTMEMORY_SUMMARIZE_MODEL=@cf/openai/gpt-oss-120b
# AGENTMEMORY_REFLECT_MODEL=@cf/openai/gpt-oss-120b
# AGENTMEMORY_CONSOLIDATE_MODEL=@cf/openai/gpt-oss-120b
# AGENTMEMORY_CONSOLIDATION_PIPELINE_MODEL=@cf/openai/gpt-oss-120b
# AGENTMEMORY_CRYSTALLIZE_MODEL=@cf/openai/gpt-oss-120b
# AGENTMEMORY_SKILL_EXTRACT_MODEL=@cf/openai/gpt-oss-120b
# AGENTMEMORY_GRAPH_MODEL=@cf/openai/gpt-oss-120b
#
# High-volume or transient — compress fires on every tool use when
# AGENTMEMORY_AUTO_COMPRESS is on, and query-expansion on every search.
# AGENTMEMORY_COMPRESS_MODEL=@cf/meta/llama-3.2-3b-instruct
# AGENTMEMORY_QUERY_EXPANSION_MODEL=@cf/meta/llama-3.2-3b-instruct
# AGENTMEMORY_SLIDING_WINDOW_MODEL=@cf/meta/llama-3.2-3b-instruct
# AGENTMEMORY_FLOW_COMPRESS_MODEL=@cf/meta/llama-3.2-3b-instruct
# AGENTMEMORY_COMPRESS_FILE_MODEL=@cf/meta/llama-3.2-3b-instruct
# AGENTMEMORY_TEMPORAL_GRAPH_MODEL=@cf/meta/llama-3.2-3b-instruct
#
# Middle option: @cf/openai/gpt-oss-20b costs about half the 120b and extracts
# file lists just as accurately, but is less consistent at pulling out
# decisions. Suitable for tasks that matter without being durable memory.
```

- [ ] **Step 7: Commit**

```bash
git add src/index.ts .env.example
git commit -s -m "feat(providers): route each memory task through its own model

Injects a per-task provider at the 13 registration sites in index.ts and
documents all 13 AGENTMEMORY_<TASK>_MODEL variables. With nothing set,
behaviour and boot output are unchanged."
```

---

### Task 3: Stop health reporting from lying

**Files:**
- Modify: `src/triggers/api.ts` (parameter at line ~143, circuit breaker read at line ~256)
- Modify: `src/index.ts` (the `registerApiTriggers` call at line ~372)
- Test: `test/task-router.test.ts` (extend)

**Interfaces:**
- Consumes: `mostDegraded`, `TaskProviderFactory` from Task 1.
- Produces: nothing new; `registerApiTriggers` changes its last parameter from a single provider to `ResilientProvider[]`.

**Why:** today `/agentmemory/health` reports the one global provider's `circuitState`. Once `compress` runs on a different provider, the busiest path's breaker becomes invisible — health would read "closed" while the highest-volume model is failing.

- [ ] **Step 1: Write the failing test**

Append to `test/task-router.test.ts`:

```ts
describe("health aggregation across routed providers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearEnv([...COMPETING_KEYS, ...ALL_TASKS.map(envVarForTask)]);
    process.env["CLOUDFLARE_API_TOKEN"] = "test-token";
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "test-account";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("exposes every distinct provider so health can inspect all of them", () => {
    process.env["AGENTMEMORY_COMPRESS_MODEL"] = "@cf/meta/llama-3.2-3b-instruct";
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    const states = f.allProviders().map((p) => p.circuitState);
    expect(states).toHaveLength(2);
    expect(mostDegraded(states)?.state).toBe("closed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/task-router.test.ts -t "health aggregation"`
Expected: FAIL — `f.allProviders()` returns 2 but the assertion on `circuitState` cannot run until providers expose it, or the test errors on the import of `mostDegraded` if Task 1 was skipped.

If it passes immediately, that is fine — it is a guard test for the wiring below; proceed.

- [ ] **Step 3: Change the `registerApiTriggers` signature**

In `src/triggers/api.ts`, find:

```ts
  provider?: ResilientProvider | { circuitState?: unknown },
```

Replace with:

```ts
  providers?: ResilientProvider[],
```

- [ ] **Step 4: Aggregate in the health payload**

In the same file, find:

```ts
      const circuitBreaker =
        provider && "circuitState" in provider ? provider.circuitState : null;
```

Replace with:

```ts
      // Report the worst breaker across every routed model, not just the
      // default one — the highest-volume task often runs on a different model.
      const circuitBreaker = mostDegraded(
        (providers ?? []).map((p) => p.circuitState),
      );
```

Add the import:

```ts
import { mostDegraded } from "../providers/task-router.js";
```

- [ ] **Step 5: Update the call site**

In `src/index.ts`, find:

```ts
  registerApiTriggers(sdk, kv, secret, metricsStore, provider);
```

Replace with:

```ts
  registerApiTriggers(sdk, kv, secret, metricsStore, taskProviders.allProviders());
```

- [ ] **Step 6: Delete the now-unused global provider**

Tasks 2 and 3 replace all 14 uses of the `provider` const (13 task sites plus
`registerApiTriggers`), leaving only its declaration. Delete it:

```ts
  const provider =
    fallbackConfig.providers.length > 0
      ? createFallbackProvider(config.provider, fallbackConfig)
      : createProvider(config.provider);
```

Then drop `createFallbackProvider` and `createProvider` from the
`./providers/index.js` import in `src/index.ts` if nothing else uses them.

Verify with:

```bash
grep -nE "\bprovider\b" src/index.ts | grep -vE "taskProviders|config\.provider|embeddingProvider|imageEmbeddingProvider|providers/|Provider:|provider had|active provider|embedding provider|embedding-provider|LLM provider"
```

Expected: no output. Then `npx tsc --noEmit 2>&1 | grep -E "src/index\.ts|src/triggers/api\.ts"` — expected: no output.

- [ ] **Step 7: Confirm no other callers exist**

Run: `grep -rn "registerApiTriggers" src/ test/`
Expected: exactly two hits — the import and the call, both in `src/index.ts`. There are no test callers, so nothing else needs updating. If this grep ever returns more, update each to pass an array.

- [ ] **Step 8: Build and run the full suite**

Run: `npm run build && npm test 2>&1 | tail -4`
Expected: build succeeds; 1436+ passing, still exactly 5 failing.

- [ ] **Step 9: Commit**

```bash
git add src/triggers/api.ts src/index.ts test/task-router.test.ts
git commit -s -m "fix(health): report the worst breaker across routed providers

With per-task routing the default provider's circuit state no longer
represents the busiest path. Health now aggregates every distinct
provider and reports the most degraded state."
```

---

### Task 4: Live end-to-end verification

**Files:** none modified — this task proves the feature against real Workers AI.

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing.

**Prerequisite:** `~/.agentmemory/.env` must contain a working `CLOUDFLARE_API_TOKEN` with the **Account → Workers AI → Read** permission, plus `CLOUDFLARE_ACCOUNT_ID`. Without it this task cannot run.

- [ ] **Step 1: Configure a split and restart**

Add to `~/.agentmemory/.env`:

```bash
CLOUDFLARE_MODEL=@cf/openai/gpt-oss-120b
AGENTMEMORY_COMPRESS_MODEL=@cf/meta/llama-3.2-3b-instruct
AGENTMEMORY_QUERY_EXPANSION_MODEL=@cf/meta/llama-3.2-3b-instruct
```

Run:

```bash
cd ~/Projects/agentmemory && node dist/cli.mjs stop && node dist/cli.mjs
```

- [ ] **Step 2: Confirm the boot log shows the split**

`bootLog` output is gated behind `--verbose`, so start with `node dist/cli.mjs --verbose` for this step or you will see nothing at all — not even the existing `Provider:` line.

Expected in the boot output:

```
Provider: cloudflare (@cf/openai/gpt-oss-120b)
  ↳ compress, query-expansion → @cf/meta/llama-3.2-3b-instruct
```

If the arrow lines are absent, the overrides are not being read — check the variable names against `envVarForTask`.

- [ ] **Step 3: Confirm health still reports a breaker**

Run:

```bash
curl -s http://localhost:3111/agentmemory/health | python3 -m json.tool | head -12
```

Expected: a `circuitBreaker` object with `"state": "closed"` — not `null`. A `null` here means Task 3's aggregation is receiving an empty array.

- [ ] **Step 4: Prove the strong model actually served summarize**

```bash
npx tsx seed-large-session.ts
curl -s -X POST http://localhost:3111/agentmemory/summarize \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"largebench_001"}' | python3 -m json.tool | head -20
```

Expected: a summary whose `keyDecisions` array has 3-5 entries and `filesModified` has 8. Per the spec's Appendix A, `llama-3.2-3b` produces 1 decision and an incorrect file count on this session, so a result in that shape means summarize was wrongly routed to the cheap model.

- [ ] **Step 5: Confirm zero-config is unchanged**

Comment out all three variables added in Step 1, restart, and re-run Step 2. Expected: no arrow lines in the boot log, and `Provider:` reads whatever the global default is. This is the compatibility guarantee from the spec.

- [ ] **Step 6: Commit nothing, report findings**

This task produces no commit. Report which steps passed and paste the boot log and summarize output.

---

## Self-Review

**Spec coverage.** Architecture → Task 1. Task map (13 tasks) → Task 1 `TASK_SET` + Task 2 wiring. Configuration/`.env.example` → Task 2 Step 6. Circuit breakers and memoisation → Task 1 Steps 3-4. Health aggregation → Task 3. Invalid model names (no boot validation) → satisfied by omission; no task adds validation. Boot visibility → Task 2 Step 2. Testing (all six bullets) → Task 1 Steps 1-4 and Task 3 Step 1, plus Task 4 Step 4 for the live check. Compatibility → Task 4 Step 5. Future extensions → out of scope, no task. The middle-option note → Task 2 Step 6.

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code it needs, and every verification step states the exact command and its expected output.

**Type consistency.** `MemoryTask`, `ALL_TASKS`, `envVarForTask`, `mostDegraded`, `TaskProviderFactory`, `makeTaskProviderFactory`, `providerFor`, `allProviders`, `routingSummary` are spelled identically in Tasks 1, 2 and 3. `CircuitBreakerState` matches `src/types.ts:219`. `registerApiTriggers`' parameter is renamed `provider` → `providers` in Task 3 Step 3 and every consumer is updated in Steps 5 and 7.

**Verified against the codebase.** `registerApiTriggers` has exactly one caller
(`src/index.ts:372`) and no test callers, so Task 3's signature change is
contained. The `provider` const has exactly 14 uses — the 13 task sites plus
that call — so after Tasks 2 and 3 it is genuinely dead and Task 3 Step 6
deletes it outright rather than conditionally.

**One known risk.** Task 2 changes 13 call sites by hand. Step 4's grep is the
guard: if any site still matches `register…(sdk, kv, provider`, a task was
missed and would silently keep using the default model — the failure would be
invisible at runtime, since the default is a valid provider.
