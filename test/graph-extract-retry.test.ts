import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerGraphFunction } from "../src/functions/graph.js";
import type { MemoryProvider, CompressedObservation } from "../src/types.js";

// ─────────────────────────────────────────────────────────────
// mem::graph-extract retry.
//
// The regression: a single failed extraction call discarded its batch
// permanently — the handler logged and returned, and nothing re-queued those
// observations, so their nodes and edges were never extracted. About one
// extraction in ten was lost this way, nearly all provider timeouts.
//
// The retry must not be indiscriminate: a rejected payload (413 context
// overflow) cannot succeed on an identical retry, and each wasted attempt
// used to count as provider ill-health against a shared circuit breaker.
// ─────────────────────────────────────────────────────────────

const GRAPH_XML = `
<graph>
  <node type="concept" name="authentication" />
  <node type="file" name="src/auth.ts" />
  <edge source="authentication" target="src/auth.ts" type="implemented_in" />
</graph>
`;

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
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

function makeObs(): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth",
    subtitle: "",
    facts: ["added token check"],
    narrative: "Modified auth middleware",
    concepts: ["authentication"],
    files: ["src/auth.ts"],
    importance: 6,
  };
}

/** Capture the handler registered under mem::graph-extract. */
function registerAndGetHandler(provider: MemoryProvider) {
  let handler: ((data: unknown) => Promise<unknown>) | null = null;
  const sdk = {
    registerFunction: (id: string, fn: (data: unknown) => Promise<unknown>) => {
      if (id === "mem::graph-extract") handler = fn;
    },
    registerTrigger: () => {},
    trigger: vi.fn().mockResolvedValue(undefined),
  };
  registerGraphFunction(sdk as never, mockKV() as never, provider);
  if (!handler) throw new Error("mem::graph-extract was not registered");
  return handler as (data: unknown) => Promise<{
    success: boolean;
    error?: string;
    nodesAdded?: number;
  }>;
}

function providerWith(compress: MemoryProvider["compress"]): MemoryProvider {
  return {
    name: "test",
    model: "test-model",
    compress,
    summarize: vi.fn(),
  } as unknown as MemoryProvider;
}

/** A provider error carrying an HTTP status, as the real ones do. */
function statusError(status: number, message: string): Error {
  return new Error(`API error (${status}): ${message}`);
}

describe("mem::graph-extract retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds on the first attempt without retrying", async () => {
    const compress = vi.fn().mockResolvedValue(GRAPH_XML);
    const handler = registerAndGetHandler(providerWith(compress));

    const result = await handler({ observations: [makeObs()] });

    expect(result.success).toBe(true);
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it("recovers from a transient timeout on the second attempt", async () => {
    // THE regression: this batch used to be discarded outright.
    const compress = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Request to api.cloudflare.com timed out after 60000ms"),
      )
      .mockResolvedValueOnce(GRAPH_XML);
    const handler = registerAndGetHandler(providerWith(compress));

    const result = await handler({ observations: [makeObs()] });

    expect(result.success).toBe(true);
    expect(compress).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget and reports failure", async () => {
    const compress = vi
      .fn()
      .mockRejectedValue(new Error("timed out after 60000ms"));
    const handler = registerAndGetHandler(providerWith(compress));

    const result = await handler({ observations: [makeObs()] });

    expect(result.success).toBe(false);
    expect(compress).toHaveBeenCalledTimes(2);
  });

  it("does not retry a context-overflow rejection", async () => {
    // 413 is a property of the payload. An identical retry fails identically
    // and, before the breaker learned to ignore these, counted as provider
    // ill-health against calls that would have succeeded.
    const compress = vi
      .fn()
      .mockRejectedValue(statusError(413, '{"internalCode":5021}'));
    const handler = registerAndGetHandler(providerWith(compress));

    const result = await handler({ observations: [makeObs()] });

    expect(result.success).toBe(false);
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it("does not retry a malformed-request rejection", async () => {
    const compress = vi.fn().mockRejectedValue(statusError(400, "bad request"));
    const handler = registerAndGetHandler(providerWith(compress));

    const result = await handler({ observations: [makeObs()] });

    expect(result.success).toBe(false);
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit, which is transient", async () => {
    // 429 is deliberately NOT in the non-retryable set.
    const compress = vi
      .fn()
      .mockRejectedValueOnce(statusError(429, "slow down"))
      .mockResolvedValueOnce(GRAPH_XML);
    const handler = registerAndGetHandler(providerWith(compress));

    const result = await handler({ observations: [makeObs()] });

    expect(result.success).toBe(true);
    expect(compress).toHaveBeenCalledTimes(2);
  });
});
