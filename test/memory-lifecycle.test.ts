import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: { memories: "mem:memories" },
}));

const bm25Remove = vi.fn();
const vectorRemove = vi.fn();
const saveScheduled = vi.fn();
vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ remove: bm25Remove }),
  vectorIndexRemove: (id: string) => vectorRemove(id),
  scheduleIndexSave: () => saveScheduled(),
}));

import { demoteMemory, unindexMemory } from "../src/functions/memory-lifecycle.js";
import type { Memory } from "../src/types.js";

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
    delete: async () => {},
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from((store.get(scope) ?? new Map()).values()) as T[],
  };
}

function makeMemory(): Memory {
  return {
    id: "mem_1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    type: "fact",
    title: "old fact",
    content: "the old fact",
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 7,
    version: 1,
    isLatest: true,
  };
}

describe("demoteMemory", () => {
  beforeEach(() => {
    bm25Remove.mockClear();
    vectorRemove.mockClear();
    saveScheduled.mockClear();
  });

  it("marks non-latest, persists, and removes from BOTH search indexes", async () => {
    const kv = mockKV();
    const memory = makeMemory();
    await kv.set("mem:memories", memory.id, memory);

    await demoteMemory(kv as any, memory, "test");

    const stored = await kv.get<Memory>("mem:memories", "mem_1");
    expect(stored?.isLatest).toBe(false);
    // isLatest alone is not enough: the BM25 index is persisted and restored
    // on boot, and the KV rebuild only ADDS missing entries — a memory left
    // indexed stays searchable forever after being superseded.
    expect(bm25Remove).toHaveBeenCalledWith("mem_1");
    expect(vectorRemove).toHaveBeenCalledWith("mem_1");
    expect(saveScheduled).toHaveBeenCalled();
  });

  it("stamps updatedAt so the demotion is visible to recency ordering", async () => {
    const kv = mockKV();
    const memory = makeMemory();
    await kv.set("mem:memories", memory.id, memory);

    await demoteMemory(kv as any, memory, "test");

    const stored = await kv.get<Memory>("mem:memories", "mem_1");
    expect(stored?.updatedAt).not.toBe("2026-08-01T00:00:00.000Z");
  });

  it("does not roll the demotion back when unindexing throws", async () => {
    bm25Remove.mockImplementationOnce(() => {
      throw new Error("index unavailable");
    });
    const kv = mockKV();
    const memory = makeMemory();
    await kv.set("mem:memories", memory.id, memory);

    await expect(
      demoteMemory(kv as any, memory, "test"),
    ).resolves.toBeUndefined();

    // A stale index entry is recoverable. A memory left flagged live is not,
    // so the demotion must survive an index failure.
    const stored = await kv.get<Memory>("mem:memories", "mem_1");
    expect(stored?.isLatest).toBe(false);
  });

  it("unindexMemory swallows index errors for callers that persist themselves", () => {
    vectorRemove.mockImplementationOnce(() => {
      throw new Error("vector index down");
    });
    expect(() => unindexMemory("mem_9", "test")).not.toThrow();
  });
});
