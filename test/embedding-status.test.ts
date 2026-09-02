import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: { embeddingFailures: "mem:emb-failures" },
}));

import {
  recordEmbeddingFailure,
  clearEmbeddingFailure,
  listEmbeddingFailures,
} from "../src/state/embedding-status.js";

/** Counts mutations separately from reads — the whole point of the fix. */
function countingKV() {
  const store = new Map<string, Map<string, unknown>>();
  const counts = { get: 0, set: 0, delete: 0 };
  return {
    counts,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      counts.get++;
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      counts.set++;
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      counts.delete++;
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from((store.get(scope) ?? new Map()).values()) as T[],
  };
}

const ENTRY = {
  id: "obs_1",
  sessionId: "ses_1",
  kind: "observation" as const,
  reason: "embed-error" as const,
  provider: "cloudflare",
};

describe("embedding failure markers", () => {
  let kv: ReturnType<typeof countingKV>;
  beforeEach(() => {
    kv = countingKV();
  });

  it("clearing a row that never failed performs NO write", async () => {
    // This runs on every successful embed. An unconditional delete made each
    // one a state-store mutation on mem:emb-failures, which the engine
    // broadcasts to every registered state trigger — the event storm that
    // OOM-killed the VPS engine on every rebuildIndex pass.
    await clearEmbeddingFailure(kv as any, "never-failed");

    expect(kv.counts.delete).toBe(0);
    expect(kv.counts.set).toBe(0);
    expect(kv.counts.get).toBe(1);
  });

  it("clearing a row that did fail still removes the marker", async () => {
    await recordEmbeddingFailure(kv as any, ENTRY);
    expect(await listEmbeddingFailures(kv as any)).toHaveLength(1);

    await clearEmbeddingFailure(kv as any, ENTRY.id);

    expect(kv.counts.delete).toBe(1);
    expect(await listEmbeddingFailures(kv as any)).toHaveLength(0);
  });

  it("a corpus-wide pass with no failures costs zero mutations", async () => {
    // The shape of a rebuildIndex run on a healthy corpus: every row embeds,
    // so every row calls clear. Before the fix this was one delete per row.
    for (let i = 0; i < 500; i++) {
      await clearEmbeddingFailure(kv as any, `obs_${i}`);
    }
    expect(kv.counts.delete).toBe(0);
    expect(kv.counts.set).toBe(0);
  });

  it("counts attempts so a permanently failing id is distinguishable", async () => {
    await recordEmbeddingFailure(kv as any, ENTRY);
    await recordEmbeddingFailure(kv as any, ENTRY);
    await recordEmbeddingFailure(kv as any, ENTRY);

    const rows = await listEmbeddingFailures(kv as any);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(3);
  });

  it("never throws when the store is broken", async () => {
    const broken = {
      get: async () => {
        throw new Error("store down");
      },
      set: async () => {
        throw new Error("store down");
      },
      delete: async () => {
        throw new Error("store down");
      },
      list: async () => {
        throw new Error("store down");
      },
    };
    // These run inside an already-degraded path; a store failure here must
    // not convert a soft-failed embed into a failed save.
    await expect(
      recordEmbeddingFailure(broken as any, ENTRY),
    ).resolves.toBeUndefined();
    await expect(
      clearEmbeddingFailure(broken as any, ENTRY.id),
    ).resolves.toBeUndefined();
    await expect(listEmbeddingFailures(broken as any)).resolves.toEqual([]);
  });
});
