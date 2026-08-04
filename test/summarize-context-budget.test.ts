import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: {
    sessions: "sessions",
    summaries: "summaries",
    observations: (sessionId: string) => `obs:${sessionId}`,
    audit: "audit",
  },
}));

vi.mock("../src/eval/schemas.js", () => ({ SummaryOutputSchema: {} }));
vi.mock("../src/eval/validator.js", () => ({
  validateOutput: () => ({ valid: true, result: { errors: [] } }),
}));
vi.mock("../src/eval/quality.js", () => ({ scoreSummary: () => 100 }));
vi.mock("../src/functions/audit.js", () => ({ safeAudit: vi.fn() }));

import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { resetLearnedContextLimits } from "../src/providers/context-windows.js";
import type {
  CompressedObservation,
  Session,
  MemoryProvider,
} from "../src/types.js";

const SMALL_WINDOW_MODEL = "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8"; // 32k
const HUGE_WINDOW_MODEL = "deepseek/deepseek-v4-flash"; // 1,048,576

/** ~2 KB per observation, so a few dozen overflow a 32k window. */
function makeFatObs(i: number, sessionId: string): CompressedObservation {
  return {
    id: `obs_${i}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "conversation",
    title: `observation ${i}`,
    facts: [`fact ${i}: ${"x".repeat(400)}`, `fact ${i}b: ${"y".repeat(400)}`],
    narrative: `narrative ${i}: ${"z".repeat(1000)}`,
    concepts: [],
    files: [`src/file_${i}.ts`],
    importance: 5,
  };
}

function summaryXml(title: string): string {
  return `<summary><title>${title}</title><narrative>n</narrative><decisions><decision>d</decision></decisions><files><file>f.ts</file></files><concepts></concepts></summary>`;
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

function makeProvider(
  model: string,
  respond: (userPrompt: string, callIndex: number) => string,
): MemoryProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "test",
    model,
    prompts,
    compress: async () => "",
    summarize: async (_system: string, user: string) => {
      const out = respond(user, prompts.length);
      prompts.push(user);
      return out;
    },
  };
}

async function setup(sessionId: string, obsCount: number, provider: MemoryProvider) {
  const sdk = mockSdk();
  const kv = mockKV();
  const session: Session = {
    id: sessionId,
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: obsCount,
  };
  await kv.set("sessions", sessionId, session);
  for (let i = 0; i < obsCount; i++) {
    const o = makeFatObs(i, sessionId);
    await kv.set(`obs:${sessionId}`, o.id, o);
  }
  registerSummarizeFunction(sdk as any, kv as any, provider);
  return { handler: sdk.functions.get("mem::summarize")!, kv };
}

describe("mem::summarize sizes prompts against the model's context window", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    resetLearnedContextLimits();
    delete process.env.SUMMARIZE_CHUNK_SIZE;
    delete process.env.SUMMARIZE_CHUNK_CONCURRENCY;
    delete process.env.AGENTMEMORY_CONTEXT_WINDOW;
    delete process.env.MAX_TOKENS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // The regression. 40 observations is far below the old hardcoded 400, so
  // this session took the "single call" path and sent ~90k characters to a
  // 32k-window model — HTTP 413, every time, before the provider did any
  // work. Chunking must now be driven by the window, not by a count.
  it("chunks a session that fits the old 400-observation rule but not the window", async () => {
    const provider = makeProvider(SMALL_WINDOW_MODEL, () => summaryXml("part"));
    const { handler } = await setup("s1", 40, provider);

    const res = await handler({ sessionId: "s1" });
    expect(res.success).toBe(true);
    // >1 call means it chunked (N chunks + 1 reduce).
    expect(provider.prompts.length).toBeGreaterThan(1);
  });

  it("keeps every chunk's prompt inside the derived budget", async () => {
    const provider = makeProvider(SMALL_WINDOW_MODEL, () => summaryXml("part"));
    await (await setup("s2", 60, provider)).handler({ sessionId: "s2" });

    // 32k window − 4k output − 1.5k overhead, at 80% of 3.2 chars/token.
    const budget = Math.floor((32_000 - 4096 - 1500) * 0.8 * 3.2);
    for (const p of provider.prompts) {
      expect(p.length).toBeLessThanOrEqual(budget + 5_000); // reduce prompt is small
    }
  });

  // Same session, bigger model: the window is the variable, so a 1M-token
  // model should swallow it whole rather than paying for a reduce step.
  it("uses a single call for the same session on a million-token model", async () => {
    const provider = makeProvider(HUGE_WINDOW_MODEL, () => summaryXml("whole"));
    const { handler } = await setup("s3", 40, provider);

    const res = await handler({ sessionId: "s3" });
    expect(res.success).toBe(true);
    expect(provider.prompts).toHaveLength(1);
  });

  it("respects SUMMARIZE_CHUNK_SIZE as a further cap, never as a floor", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "5";
    const provider = makeProvider(HUGE_WINDOW_MODEL, () => summaryXml("part"));
    await (await setup("s4", 40, provider)).handler({ sessionId: "s4" });

    // 40 observations capped at 5 each = 8 chunks + 1 reduce.
    expect(provider.prompts).toHaveLength(9);
  });
});

describe("mem::summarize retry policy", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    resetLearnedContextLimits();
    delete process.env.SUMMARIZE_CHUNK_SIZE;
    delete process.env.AGENTMEMORY_CONTEXT_WINDOW;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("does not retry a chunk that failed with a context overflow", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "10"; // force 4 chunks from 40 obs
    let calls = 0;
    const provider = makeProvider(HUGE_WINDOW_MODEL, () => {
      calls++;
      throw new Error(
        'Cloudflare API error (413): {"internalCode":5021,"message":"exceeded this model context window limit (32000)"}',
      );
    });
    const { handler } = await setup("s5", 40, provider);

    const res = await handler({ sessionId: "s5" });
    expect(res.success).toBe(false);
    // 4 chunks, one attempt each. The old code retried every failure, so
    // this was 8 — eight identical oversized requests, all doomed.
    expect(calls).toBe(4);
  });

  it("still retries a transient failure once", async () => {
    process.env.SUMMARIZE_CHUNK_SIZE = "10";
    let calls = 0;
    const provider = makeProvider(HUGE_WINDOW_MODEL, () => {
      calls++;
      throw new Error("Cloudflare API error (500): upstream blew up");
    });
    const { handler } = await setup("s6", 40, provider);

    await handler({ sessionId: "s6" });
    expect(calls).toBe(8); // 4 chunks x 2 attempts
  });
});
