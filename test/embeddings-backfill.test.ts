import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { VectorIndex } from "../src/state/vector-index.js";
import {
  setVectorIndex,
  setEmbeddingProvider,
  setEmbeddingFailureSink,
  setIndexPersistence,
  getSearchIndex,
  vectorIndexAddGuarded,
} from "../src/functions/search.js";
import { runEmbeddingsBackfill } from "../src/functions/embeddings-backfill.js";
import {
  recordEmbeddingFailure,
  clearEmbeddingFailure,
  listEmbeddingFailures,
} from "../src/state/embedding-status.js";
import { KV } from "../src/state/schema.js";
import { logger } from "../src/logger.js";
import type { EmbeddingProvider } from "../src/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

type MockKV = ReturnType<typeof mockKV>;

function observation(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    timestamp: "2026-08-03T10:00:00.000Z",
    type: "decision" as const,
    title: `title for ${id}`,
    facts: ["a fact"],
    narrative: `narrative for ${id}`,
    concepts: ["backfill"],
    files: [],
    importance: 5,
  };
}

const DIMS = 4;

function workingProvider(name = "test-embedder"): EmbeddingProvider {
  return {
    name,
    dimensions: DIMS,
    embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]),
    embedBatch: async (texts) =>
      texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4])),
  };
}

function failingProvider(message = "API error (429): rate limited"): EmbeddingProvider {
  return {
    name: "broken-embedder",
    dimensions: DIMS,
    embed: async () => {
      throw new Error(message);
    },
    embedBatch: async () => {
      throw new Error(message);
    },
  };
}

/** Wire the KV-backed failure-marker sink exactly as src/index.ts does. */
function wireSink(kv: MockKV): void {
  setEmbeddingFailureSink({
    record: (entry) => recordEmbeddingFailure(kv as never, entry),
    clear: (id) => clearEmbeddingFailure(kv as never, id),
  });
}

async function seed(
  kv: MockKV,
  sessionId: string,
  ids: string[],
): Promise<void> {
  await kv.set(KV.sessions, sessionId, { id: sessionId });
  for (const id of ids) {
    await kv.set(KV.observations(sessionId), id, observation(id, sessionId));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  getSearchIndex().clear();
  setVectorIndex(null);
  setEmbeddingProvider(null);
  setEmbeddingFailureSink(null);
  setIndexPersistence(null);
});

// ---------------------------------------------------------------------------
// 1. The soft-fail path is no longer silent
// ---------------------------------------------------------------------------

describe("embedding soft-fail is logged and marked", () => {
  it("marks an observation whose embed throws, instead of dropping it silently", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    setEmbeddingProvider(failingProvider());
    wireSink(kv);

    const ok = await vectorIndexAddGuarded("obs_1", "ses_1", "some text", {
      kind: "observation",
      logId: "obs_1",
    });

    // The save path still soft-fails — that contract is unchanged.
    expect(ok).toBe(false);
    expect(index.size).toBe(0);

    // …but the loss is now both logged and recorded.
    expect(logger.warn).toHaveBeenCalledWith(
      "vector-index add: embed failed — marked for backfill",
      expect.objectContaining({ id: "obs_1", provider: "broken-embedder" }),
    );

    const failures = await listEmbeddingFailures(kv as never);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      id: "obs_1",
      sessionId: "ses_1",
      kind: "observation",
      reason: "embed-error",
      provider: "broken-embedder",
      attempts: 1,
    });
    expect(failures[0]!.error).toContain("429");
    expect(failures[0]!.failedAt).toBeTruthy();
  });

  it("marks a dimension mismatch with its own reason", async () => {
    const kv = mockKV();
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider({
      name: "wrong-dims",
      dimensions: DIMS,
      embed: async () => new Float32Array(1536),
      embedBatch: async (t) => t.map(() => new Float32Array(1536)),
    });
    wireSink(kv);

    await vectorIndexAddGuarded("obs_1", "ses_1", "text", {
      kind: "observation",
      logId: "obs_1",
    });

    const failures = await listEmbeddingFailures(kv as never);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: "dimension-mismatch" });
  });

  it("counts repeated failures on the same id rather than overwriting", async () => {
    const kv = mockKV();
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(failingProvider());
    wireSink(kv);

    for (let i = 0; i < 3; i++) {
      await vectorIndexAddGuarded("obs_1", "ses_1", "text", {
        kind: "observation",
        logId: "obs_1",
      });
    }

    const failures = await listEmbeddingFailures(kv as never);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.attempts).toBe(3);
  });

  it("clears the marker once the id embeds successfully", async () => {
    const kv = mockKV();
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(failingProvider());
    wireSink(kv);

    await vectorIndexAddGuarded("obs_1", "ses_1", "text", {
      kind: "observation",
      logId: "obs_1",
    });
    expect(await listEmbeddingFailures(kv as never)).toHaveLength(1);

    // Provider recovers.
    setEmbeddingProvider(workingProvider());
    const ok = await vectorIndexAddGuarded("obs_1", "ses_1", "text", {
      kind: "observation",
      logId: "obs_1",
    });

    expect(ok).toBe(true);
    expect(await listEmbeddingFailures(kv as never)).toHaveLength(0);
  });

  it("never lets a marker-write failure break the save path", async () => {
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(failingProvider());
    setEmbeddingFailureSink({
      record: async () => {
        throw new Error("KV is down");
      },
      clear: async () => {
        throw new Error("KV is down");
      },
    });

    // Bookkeeping about a failure must not become a failure: a throwing
    // sink turns "the embedder is down" (soft, recoverable) into "the save
    // threw" (hard) and takes the whole observation with it.
    await expect(
      vectorIndexAddGuarded("obs_1", "ses_1", "text", {
        kind: "observation",
        logId: "obs_1",
      }),
    ).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "vector-index add: failed to mark embedding failure",
      expect.objectContaining({ id: "obs_1" }),
    );

    // Same on the success path, where the sink clears rather than records.
    setEmbeddingProvider(workingProvider());
    await expect(
      vectorIndexAddGuarded("obs_2", "ses_1", "text", {
        kind: "observation",
        logId: "obs_2",
      }),
    ).resolves.toBe(true);
  });

  it("recordEmbeddingFailure swallows KV errors so a degraded path stays degraded, not broken", async () => {
    const brokenKv = {
      get: async () => {
        throw new Error("KV is down");
      },
      set: async () => {
        throw new Error("KV is down");
      },
      delete: async () => {
        throw new Error("KV is down");
      },
      list: async () => {
        throw new Error("KV is down");
      },
    };

    await expect(
      recordEmbeddingFailure(brokenKv as never, {
        id: "obs_1",
        sessionId: "ses_1",
        kind: "observation",
        reason: "embed-error",
        provider: "p",
      }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to record embedding-failure marker",
      expect.objectContaining({ id: "obs_1" }),
    );

    await expect(
      clearEmbeddingFailure(brokenKv as never, "obs_1"),
    ).resolves.toBeUndefined();
    await expect(listEmbeddingFailures(brokenKv as never)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The backfill
// ---------------------------------------------------------------------------

describe("embeddings backfill", () => {
  it("finds and embeds observations that have no vector", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    setEmbeddingProvider(workingProvider());
    wireSink(kv);

    await seed(kv, "ses_1", ["obs_1", "obs_2", "obs_3"]);
    // obs_2 already made it into the index on the write path.
    index.add("obs_2", "ses_1", new Float32Array([0.1, 0.2, 0.3, 0.4]));

    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });

    expect(result.success).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.missing).toBe(2);
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(index.size).toBe(3);
    expect(index.has("obs_1")).toBe(true);
    expect(index.has("obs_3")).toBe(true);
  });

  it("also embeds memories that have no vector", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    setEmbeddingProvider(workingProvider());
    wireSink(kv);

    await kv.set(KV.memories, "mem_1", {
      id: "mem_1",
      createdAt: "2026-08-03T10:00:00.000Z",
      updatedAt: "2026-08-03T10:00:00.000Z",
      type: "fact",
      title: "a memory",
      content: "the content",
      concepts: [],
      files: [],
      sessionIds: ["ses_1"],
      strength: 5,
      version: 1,
      isLatest: true,
    });

    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });

    expect(result.missing).toBe(1);
    expect(result.embedded).toBe(1);
    expect(index.has("mem_1")).toBe(true);
  });

  it("clears the failure markers for rows it repairs", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    setEmbeddingProvider(failingProvider());
    wireSink(kv);

    await seed(kv, "ses_1", ["obs_1"]);
    // The write path drops it and marks it.
    await vectorIndexAddGuarded("obs_1", "ses_1", "text", {
      kind: "observation",
      logId: "obs_1",
    });
    expect(await listEmbeddingFailures(kv as never)).toHaveLength(1);

    setEmbeddingProvider(workingProvider());
    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });

    expect(result.embedded).toBe(1);
    expect(await listEmbeddingFailures(kv as never)).toHaveLength(0);
  });

  it("ignores raw observations, which are never embedded on the write path either", async () => {
    const kv = mockKV();
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(workingProvider());

    await kv.set(KV.sessions, "ses_1", { id: "ses_1" });
    await kv.set(KV.observations("ses_1"), "obs_raw", {
      id: "obs_raw",
      sessionId: "ses_1",
      timestamp: "2026-08-03T10:00:00.000Z",
      hookType: "post_tool_use",
      raw: { tool_name: "Bash" },
    });

    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });

    // Counting them would report a gap no backfill could ever close.
    expect(result.scanned).toBe(0);
    expect(result.missing).toBe(0);
  });

  it("repairs the keyword index too, for rows missing from both", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    setEmbeddingProvider(workingProvider());
    wireSink(kv);

    await seed(kv, "ses_1", ["obs_1", "obs_2"]);

    const bm25 = getSearchIndex();
    expect(bm25.has("obs_1")).toBe(false);

    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });

    expect(result.bm25Missing).toBe(2);
    expect(result.bm25Repaired).toBe(2);
    expect(bm25.has("obs_1")).toBe(true);
    expect(bm25.has("obs_2")).toBe(true);
  });

  it("restores the keyword entry even when the embed still fails", async () => {
    const kv = mockKV();
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(failingProvider());
    wireSink(kv);

    await seed(kv, "ses_1", ["obs_1"]);

    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });

    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(1);
    // BM25 costs no provider call, so it must not be hostage to the embed.
    expect(result.bm25Repaired).toBe(1);
    expect(getSearchIndex().has("obs_1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Dry run
// ---------------------------------------------------------------------------

describe("embeddings backfill --dry-run", () => {
  it("counts the gap without writing anything", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    const provider = workingProvider();
    const embedBatch = vi.spyOn(provider, "embedBatch");
    const embed = vi.spyOn(provider, "embed");
    setEmbeddingProvider(provider);
    wireSink(kv);

    await seed(kv, "ses_1", ["obs_1", "obs_2", "obs_3"]);
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3, 0.4]));

    const result = await runEmbeddingsBackfill(kv as never, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.missing).toBe(2);
    expect(result.remaining).toBe(2);

    // Nothing was spent, and nothing was written.
    expect(embedBatch).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(result.embedded).toBe(0);
    expect(result.bm25Repaired).toBe(0);
    expect(index.size).toBe(1);
    expect(getSearchIndex().size).toBe(0);
  });

  it("still reports the gap when no embedding provider is configured", async () => {
    const kv = mockKV();
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(null);

    await seed(kv, "ses_1", ["obs_1"]);

    // A missing provider is exactly when you most want this number.
    const result = await runEmbeddingsBackfill(kv as never, { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.missing).toBe(1);
  });

  it("refuses a real run when no embedding provider is configured", async () => {
    const kv = mockKV();
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(null);
    await seed(kv, "ses_1", ["obs_1"]);

    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("no embedding provider");
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency and resumability
// ---------------------------------------------------------------------------

describe("embeddings backfill is idempotent and resumable", () => {
  it("embeds nothing on a second run", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    const provider = workingProvider();
    setEmbeddingProvider(provider);
    wireSink(kv);

    await seed(kv, "ses_1", ["obs_1", "obs_2"]);

    const first = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });
    expect(first.embedded).toBe(2);

    const embedBatch = vi.spyOn(provider, "embedBatch");
    const second = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });

    expect(second.scanned).toBe(2);
    expect(second.missing).toBe(0);
    expect(second.embedded).toBe(0);
    expect(second.bm25Repaired).toBe(0);
    expect(second.batches).toBe(0);
    expect(embedBatch).not.toHaveBeenCalled();
    // The corpus is unchanged, not double-indexed.
    expect(index.size).toBe(2);
    expect(getSearchIndex().size).toBe(2);
  });

  it("honours --limit and reports the remainder, which the next run picks up", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    setEmbeddingProvider(workingProvider());
    wireSink(kv);

    await seed(kv, "ses_1", ["obs_1", "obs_2", "obs_3", "obs_4", "obs_5"]);

    const first = await runEmbeddingsBackfill(kv as never, {
      limit: 2,
      batchSize: 2,
      delayMs: 0,
    });
    expect(first.missing).toBe(5);
    expect(first.embedded).toBe(2);
    expect(first.remaining).toBe(3);

    const second = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });
    expect(second.missing).toBe(3);
    expect(second.embedded).toBe(3);
    expect(second.remaining).toBe(0);
    expect(index.size).toBe(5);

    const third = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });
    expect(third.missing).toBe(0);
    expect(third.embedded).toBe(0);
  });

  it("stops early rather than burning quota against a provider that keeps refusing", async () => {
    const kv = mockKV();
    setVectorIndex(new VectorIndex());
    const provider = failingProvider();
    const embedBatch = vi.spyOn(provider, "embedBatch");
    setEmbeddingProvider(provider);
    wireSink(kv);

    const ids = Array.from({ length: 40 }, (_, i) => `obs_${i}`);
    await seed(kv, "ses_1", ids);

    const result = await runEmbeddingsBackfill(kv as never, {
      batchSize: 1,
      delayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.stoppedReason).toContain("consecutive batches failed");
    expect(result.embedded).toBe(0);
    // 3 strikes, not 40 — the whole point of the guard.
    expect(embedBatch).toHaveBeenCalledTimes(3);
    expect(result.remaining).toBeGreaterThan(0);

    // Every attempted row keeps its marker for the next run.
    const failures = await listEmbeddingFailures(kv as never);
    expect(failures.length).toBe(3);
  });

  it("reports an error rather than throwing when no vector index exists", async () => {
    const kv = mockKV();
    setVectorIndex(null);

    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("no vector index");
  });

  it("keeps scanning other sessions when one session's observations are unreadable", async () => {
    const kv = mockKV();
    const index = new VectorIndex();
    setVectorIndex(index);
    setEmbeddingProvider(workingProvider());
    wireSink(kv);

    await seed(kv, "ses_ok", ["obs_1"]);
    await kv.set(KV.sessions, "ses_bad", { id: "ses_bad" });

    const realList = kv.list.bind(kv);
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.observations("ses_bad")) throw new Error("scope unreadable");
      return realList<T>(scope);
    }) as typeof kv.list;

    const result = await runEmbeddingsBackfill(kv as never, { delayMs: 0 });

    // A truncated scan would make the gap look smaller than it is.
    expect(result.embedded).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "embeddings-backfill: failed to list session observations",
      expect.objectContaining({ sessionId: "ses_bad" }),
    );
  });
});
