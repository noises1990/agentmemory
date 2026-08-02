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

  it("modelFor reports the model an overridden task actually resolved to", () => {
    process.env["AGENTMEMORY_COMPRESS_MODEL"] = "@cf/meta/llama-3.2-3b-instruct";
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    expect(f.modelFor("compress")).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(f.modelFor("summarize")).toBe("@cf/openai/gpt-oss-120b");
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

  // The fixtures above all place the worst state LAST, so they pass for a
  // function with no ordering logic at all (`return states.at(-1)`). These put
  // the worst first and in the middle so only real ranking survives.
  it("picks the worst regardless of position in the array", () => {
    expect(mostDegraded([open, halfOpen, closed])?.state).toBe("open");
    expect(mostDegraded([halfOpen, open, closed])?.state).toBe("open");
    expect(mostDegraded([halfOpen, closed])?.state).toBe("half-open");
    expect(mostDegraded([closed, open, closed])?.state).toBe("open");
  });

  // failures counts do not correlate with degradation rank, so a
  // `max by failures` implementation cannot pass this.
  it("ranks by state, not by failure count", () => {
    const openFewFailures = { state: "open", failures: 1, lastFailureAt: 5, openedAt: 5 } as const;
    const closedManyFailures = {
      state: "closed",
      failures: 99,
      lastFailureAt: 4,
      openedAt: null,
    } as const;
    expect(mostDegraded([closedManyFailures, openFewFailures])?.state).toBe("open");
    expect(mostDegraded([openFewFailures, closedManyFailures])?.state).toBe("open");
  });
});

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

  // D7: health reported a bare CircuitBreakerState with no attribution, so one
  // typo'd task model made `agentmemory status` print "Circuit: open" with no
  // way to tell which model was broken. Routing state must carry its label.
  it("attributes each breaker state to the model it belongs to", () => {
    process.env["AGENTMEMORY_COMPRESS_MODEL"] = "@cf/meta/llama-3.2-3b-instruct";
    const f = makeTaskProviderFactory(CONFIG, NO_FALLBACK);
    const states = f.providerStates();
    expect(states).toHaveLength(2);
    expect(states.map((s) => s.model).sort()).toEqual(
      ["@cf/meta/llama-3.2-3b-instruct", "@cf/openai/gpt-oss-120b"].sort(),
    );
    for (const s of states) expect(s.state.state).toBe("closed");
  });
});

// D3: noop and agent-sdk are constructed with no ProviderConfig at all, so they
// physically cannot honour a per-task model. The router used to build one
// provider per distinct model STRING regardless, producing N identical
// NoopProviders and reporting routes that can never take effect. noop is the
// default whenever no LLM key is present, so this is the common path.
describe("providers that ignore the model", () => {
  const originalEnv = process.env;
  const NOOP_CONFIG: AgentMemoryConfig = {
    ...CONFIG,
    provider: { provider: "noop", model: "@cf/openai/gpt-oss-120b", maxTokens: 4096 },
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    clearEnv([...COMPETING_KEYS, ...ALL_TASKS.map(envVarForTask)]);
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not build a second provider for an override the provider cannot honour", () => {
    process.env["AGENTMEMORY_COMPRESS_MODEL"] = "gpt-4o-mini";
    const f = makeTaskProviderFactory(NOOP_CONFIG, NO_FALLBACK);
    expect(f.allProviders()).toHaveLength(1);
    expect(f.providerFor("compress")).toBe(f.providerFor("summarize"));
  });

  it("does not claim a task resolved to a model the provider discards", () => {
    process.env["AGENTMEMORY_COMPRESS_MODEL"] = "gpt-4o-mini";
    const f = makeTaskProviderFactory(NOOP_CONFIG, NO_FALLBACK);
    expect(f.modelFor("compress")).not.toBe("gpt-4o-mini");
  });
});
