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
