import { describe, it, expect, vi } from "vitest";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

vi.mock("../src/functions/audit.js", () => ({ safeAudit: vi.fn() }));

const BM25_SCOPE = "mem:index:bm25";
const BM25_MANIFEST_KEY = "data:manifest";
const LEDGER_KEY = "data:manifest:generations";

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
      if (store.get(scope)?.size === 0) store.delete(scope);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from((store.get(scope) ?? new Map()).values()) as T[],
  };
}
type MockKV = ReturnType<typeof mockKV>;

function makeObs(i: number): CompressedObservation {
  return {
    id: `obs_${i}`,
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: `Edit number ${i}`,
    facts: [`fact ${i}`],
    narrative: `A narrative long enough to force more than one shard ${i}`,
    concepts: ["auth", "jwt"],
    files: [`src/file_${i}.ts`],
    importance: 5,
  };
}

function indexWith(count: number): SearchIndex {
  const idx = new SearchIndex();
  for (let i = 0; i < count; i++) idx.add(makeObs(i));
  return idx;
}

/** Every shard scope that currently holds data, in write order. */
function shardScopes(kv: MockKV): string[] {
  return Array.from(kv.store.keys()).filter((s) => s.startsWith(`${BM25_SCOPE}:bm25:`));
}

function ledgerOf(kv: MockKV): { generations: Array<{ generation: string }> } {
  return (kv.store.get(BM25_SCOPE)?.get(LEDGER_KEY) as never) ?? { generations: [] };
}

describe("index generation collection", () => {
  it("records a generation in the ledger before writing shards", async () => {
    const kv = mockKV();
    await new IndexPersistence(kv as never, indexWith(6), null, {
      shardChars: 80,
      createGeneration: () => "gen_1",
    }).save();

    const ledger = ledgerOf(kv);
    expect(ledger.generations.map((g) => g.generation)).toEqual(["gen_1"]);
  });

  // A process that survives a failed publish rolls its own shards back, and
  // that path already worked. The unrecoverable case is a process KILLED
  // mid-save: the rollback never runs, so the shards and the ledger entry
  // are left exactly as written. Seeding that state directly is a faithful
  // reproduction — simulating it through save() only tests the rollback.
  function seedKilledGeneration(kv: MockKV, generation: string, shardCount = 3) {
    const shards: Array<{ scope: string; key: string }> = [];
    for (let i = 0; i < shardCount; i++) {
      const scope = `${BM25_SCOPE}:bm25:${generation}:${String(i).padStart(5, "0")}`;
      kv.store.set(scope, new Map([["data", "x".repeat(64)]]));
      shards.push({ scope, key: "data" });
    }
    const meta = kv.store.get(BM25_SCOPE) ?? new Map();
    const ledger = (meta.get(LEDGER_KEY) as { v: 1; generations: unknown[] }) ?? {
      v: 1,
      generations: [],
    };
    ledger.generations.push({ generation, shards });
    meta.set(LEDGER_KEY, ledger);
    kv.store.set(BM25_SCOPE, meta);
    return shards;
  }

  it("collects a generation orphaned by a kill before the manifest published", async () => {
    const kv = mockKV();
    seedKilledGeneration(kv, "gen_killed");

    const orphaned = shardScopes(kv);
    expect(orphaned).toHaveLength(3);
    expect(orphaned.every((s) => s.includes("gen_killed"))).toBe(true);

    // No manifest exists, so nothing is live and every recorded generation
    // is unreachable. This is precisely what the old manifest-walk cleanup
    // could not see: no manifest ever named these shards.
    await new IndexPersistence(kv as never, new SearchIndex(), null, {
      shardChars: 80,
    }).load();

    expect(shardScopes(kv)).toHaveLength(0);
    expect(ledgerOf(kv).generations).toHaveLength(0);
  });

  it("a kill loop leaves one live generation, not one per kill", async () => {
    const kv = mockKV();

    // Five kills in the publish window, as the VPS saw 411 of.
    for (let i = 0; i < 5; i++) seedKilledGeneration(kv, `gen_killed_${i}`);
    expect(shardScopes(kv)).toHaveLength(15);

    // A boot that then saves successfully.
    const recovered = new IndexPersistence(kv as never, indexWith(6), null, {
      shardChars: 80,
      createGeneration: () => "gen_good",
    });
    await recovered.load();
    await recovered.save();

    const live = shardScopes(kv);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((s) => s.includes("gen_good"))).toBe(true);
    expect(ledgerOf(kv).generations.map((g) => g.generation)).toEqual(["gen_good"]);
  });

  it("never collects the generation the live manifest names", async () => {
    const kv = mockKV();
    const persistence = new IndexPersistence(kv as never, indexWith(6), null, {
      shardChars: 80,
      createGeneration: () => "gen_live",
    });
    await persistence.save();

    const before = shardScopes(kv);
    expect(before.length).toBeGreaterThan(0);

    // A boot that loads a valid index must not delete the shards that index
    // was just read from.
    await persistence.load();

    expect(shardScopes(kv)).toEqual(before);
    expect(ledgerOf(kv).generations.map((g) => g.generation)).toEqual(["gen_live"]);
  });

  it("survives a missing or malformed ledger without deleting anything", async () => {
    const kv = mockKV();
    await new IndexPersistence(kv as never, indexWith(6), null, {
      shardChars: 80,
      createGeneration: () => "gen_live",
    }).save();
    const before = shardScopes(kv);

    kv.store.get(BM25_SCOPE)!.set(LEDGER_KEY, { v: 99, garbage: true });

    const p = new IndexPersistence(kv as never, new SearchIndex(), null, {
      shardChars: 80,
    });
    await expect(p.load()).resolves.toBeDefined();

    // An unreadable ledger means "nothing known to collect", never "collect
    // everything" — the shards are still there.
    expect(shardScopes(kv)).toEqual(before);
  });

  it("keeps the index loadable after a collection", async () => {
    const kv = mockKV();
    const persistence = new IndexPersistence(kv as never, indexWith(6), null, {
      shardChars: 80,
      createGeneration: () => "gen_live",
    });
    await persistence.save();

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
      { shardChars: 80 },
    ).load();

    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.size).toBe(6);
  });
});
