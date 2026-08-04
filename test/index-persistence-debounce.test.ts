import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

// ─────────────────────────────────────────────────────────────
// scheduleSave() flush scheduling.
//
// The regression: scheduleSave() was a pure debounce, so every add cleared
// the pending timer and started a new one. A busy daemon indexes faster than
// the 5s debounce, so the flush was deferred forever — the in-memory index
// grew for days while the shards on disk stayed at the last boot-time write,
// and each restart silently discarded the difference.
// ─────────────────────────────────────────────────────────────

const BM25_SCOPE = "mem:index:bm25";
const BM25_MANIFEST_KEY = "data:manifest";

const DEBOUNCE_MS = 5000;
const MAX_DEFER_MS = 60_000;

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

function makeObs(id: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: `Edit ${id}`,
    subtitle: "",
    facts: ["fact"],
    narrative: "narrative",
    concepts: ["c"],
    files: ["src/a.ts"],
    importance: 5,
  };
}

/** Did the index actually reach the KV store? */
async function persisted(kv: ReturnType<typeof mockKV>): Promise<boolean> {
  return (await kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)) !== null;
}

describe("IndexPersistence.scheduleSave", () => {
  let kv: ReturnType<typeof mockKV>;
  let bm25: SearchIndex;
  let persistence: IndexPersistence;

  beforeEach(() => {
    vi.useFakeTimers();
    kv = mockKV();
    bm25 = new SearchIndex();
    persistence = new IndexPersistence(kv as never, bm25, null);
  });

  afterEach(() => {
    persistence.stop();
    vi.useRealTimers();
  });

  it("flushes once the debounce window elapses", async () => {
    bm25.add(makeObs("obs_1"));
    persistence.scheduleSave();

    expect(await persisted(kv)).toBe(false);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    expect(await persisted(kv)).toBe(true);
  });

  it("coalesces a burst of adds into a single flush", async () => {
    const setSpy = vi.spyOn(kv, "set");
    for (let i = 0; i < 5; i++) {
      bm25.add(makeObs(`obs_${i}`));
      persistence.scheduleSave();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(await persisted(kv)).toBe(false);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    expect(await persisted(kv)).toBe(true);

    // One manifest publish, not five.
    const manifestWrites = setSpy.mock.calls.filter(
      (c) => c[1] === BM25_MANIFEST_KEY,
    );
    expect(manifestWrites).toHaveLength(1);
  });

  it("still flushes under a continuous add stream faster than the debounce", async () => {
    // THE regression. Adds every 1s — under DEBOUNCE_MS — sustained well past
    // the ceiling. With a pure debounce this never persists.
    for (let elapsed = 0; elapsed < MAX_DEFER_MS * 2; elapsed += 1000) {
      bm25.add(makeObs(`obs_${elapsed}`));
      persistence.scheduleSave();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(await persisted(kv)).toBe(true);
  });

  it("caps staleness at roughly the defer ceiling", async () => {
    let flushedAt: number | null = null;
    let elapsed = 0;
    for (; elapsed < MAX_DEFER_MS * 2; elapsed += 1000) {
      bm25.add(makeObs(`obs_${elapsed}`));
      persistence.scheduleSave();
      await vi.advanceTimersByTimeAsync(1000);
      if (flushedAt === null && (await persisted(kv))) flushedAt = elapsed;
    }

    expect(flushedAt).not.toBeNull();
    expect(flushedAt!).toBeLessThanOrEqual(MAX_DEFER_MS + DEBOUNCE_MS + 1000);
  });

  it("resumes debouncing normally after a flush", async () => {
    bm25.add(makeObs("obs_a"));
    persistence.scheduleSave();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    expect(await persisted(kv)).toBe(true);

    const setSpy = vi.spyOn(kv, "set");
    bm25.add(makeObs("obs_b"));
    persistence.scheduleSave();
    // Not immediately — the next window must debounce like the first.
    expect(
      setSpy.mock.calls.filter((c) => c[1] === BM25_MANIFEST_KEY),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    expect(
      setSpy.mock.calls.filter((c) => c[1] === BM25_MANIFEST_KEY),
    ).toHaveLength(1);
  });

  it("stop() cancels a pending flush", async () => {
    bm25.add(makeObs("obs_1"));
    persistence.scheduleSave();
    persistence.stop();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(await persisted(kv)).toBe(false);
  });
});
