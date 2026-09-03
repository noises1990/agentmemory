import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

vi.mock("../src/functions/audit.js", () => ({ safeAudit: vi.fn() }));

const BM25_SCOPE = "mem:index:bm25";
const BM25_MANIFEST_KEY = "data:manifest";

type Manifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number; path?: string }>;
  chars: number;
};

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

/** State-store scopes holding shard bodies — should be empty in file mode. */
function kvShardScopes(kv: MockKV): string[] {
  return Array.from(kv.store.keys()).filter((s) =>
    s.startsWith(`${BM25_SCOPE}:bm25:`),
  );
}

async function shardFiles(dir: string, kind = "bm25"): Promise<string[]> {
  const base = join(dir, "index-shards", kind);
  const out: string[] = [];
  let generations: string[];
  try {
    generations = await readdir(base);
  } catch {
    return out;
  }
  for (const gen of generations) {
    for (const f of await readdir(join(base, gen))) out.push(`${gen}/${f}`);
  }
  return out;
}

describe("file-backed index shards", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "am-shard-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes shard bodies to disk and keeps them OUT of the state store", async () => {
    const kv = mockKV();
    await new IndexPersistence(kv as never, indexWith(8), null, {
      shardChars: 80,
      dataDir: dir,
      createGeneration: () => "gen_file",
    }).save();

    // The whole point: the engine loads state scopes at boot, so the largest
    // thing this service writes must not live there.
    expect(kvShardScopes(kv)).toHaveLength(0);

    const files = await shardFiles(dir);
    expect(files.length).toBeGreaterThan(1);
    expect(files.every((f) => f.startsWith("gen_file/"))).toBe(true);

    // The manifest stays in the store — it is small, and it is still the
    // single commit point that makes a generation live.
    const manifest = (await kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)) as Manifest;
    expect(manifest.generation).toBe("gen_file");
    expect(manifest.shards.every((s) => typeof s.path === "string")).toBe(true);
  });

  it("round-trips an index through disk", async () => {
    const kv = mockKV();
    await new IndexPersistence(kv as never, indexWith(8), null, {
      shardChars: 80,
      dataDir: dir,
    }).save();

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
      { shardChars: 80, dataDir: dir },
    ).load();

    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.size).toBe(8);
    expect(loaded.bm25!.search("auth").length).toBeGreaterThan(0);
  });

  it("still loads a pre-existing KV manifest, then migrates it to files", async () => {
    const kv = mockKV();

    // A store written before the file shards existed: no `path` anywhere.
    await new IndexPersistence(kv as never, indexWith(8), null, {
      shardChars: 80,
      createGeneration: () => "gen_kv",
    }).save();
    expect(kvShardScopes(kv).length).toBeGreaterThan(0);
    expect(await shardFiles(dir)).toHaveLength(0);

    // Upgrade: same store, now with a dataDir. The old manifest must still
    // load — migration is by manifest field, not a flag day.
    const upgraded = new IndexPersistence(kv as never, new SearchIndex(), null, {
      shardChars: 80,
      dataDir: dir,
      createGeneration: () => "gen_migrated",
    });
    const loaded = await upgraded.load();
    expect(loaded.bm25!.size).toBe(8);

    // The first save after upgrading writes files and the existing
    // previous-generation cleanup drops the KV rows it replaced.
    await new IndexPersistence(kv as never, indexWith(8), null, {
      shardChars: 80,
      dataDir: dir,
      createGeneration: () => "gen_migrated",
    }).save();

    expect(kvShardScopes(kv)).toHaveLength(0);
    expect((await shardFiles(dir)).length).toBeGreaterThan(0);
  });

  it("collects orphaned generations from disk, not just from the store", async () => {
    const kv = mockKV();

    // Seed a generation killed before its manifest published: files on disk
    // plus a ledger entry, exactly as a killed process leaves it.
    const genDir = join(dir, "index-shards", "bm25", "gen_killed");
    await mkdir(genDir, { recursive: true });
    const shards: Array<{ scope: string; key: string; path: string }> = [];
    for (let i = 0; i < 3; i++) {
      const name = `${String(i).padStart(5, "0")}.shard`;
      await writeFile(join(genDir, name), "x".repeat(64), "utf-8");
      shards.push({
        scope: `${BM25_SCOPE}:bm25:gen_killed:${String(i).padStart(5, "0")}`,
        key: "data",
        path: `bm25/gen_killed/${name}`,
      });
    }
    await kv.set(BM25_SCOPE, "data:manifest:generations", {
      v: 1,
      generations: [{ generation: "gen_killed", shards }],
    });

    expect(await shardFiles(dir)).toHaveLength(3);

    await new IndexPersistence(kv as never, new SearchIndex(), null, {
      shardChars: 80,
      dataDir: dir,
    }).load();

    // Deleting only the KV row would have left 2.3 GB of files behind — the
    // exact shape of the VPS failure, moved to a new medium.
    expect(await shardFiles(dir)).toHaveLength(0);
  });

  it("refuses a manifest path that escapes the shard directory", async () => {
    const kv = mockKV();
    await new IndexPersistence(kv as never, indexWith(8), null, {
      shardChars: 80,
      dataDir: dir,
      createGeneration: () => "gen_ok",
    }).save();

    const manifest = (await kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)) as Manifest;
    manifest.shards[0]!.path = "../../../../etc/passwd";
    await kv.set(BM25_SCOPE, BM25_MANIFEST_KEY, manifest);

    // A manifest is data. A traversing path must fail the load, never reach
    // the filesystem.
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
      { shardChars: 80, dataDir: dir },
    ).load();
    expect(loaded.bm25).toBeNull();
  });

  it("leaves no .tmp behind after a successful write", async () => {
    const kv = mockKV();
    await new IndexPersistence(kv as never, indexWith(8), null, {
      shardChars: 80,
      dataDir: dir,
      createGeneration: () => "gen_tmp",
    }).save();

    const files = await shardFiles(dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});
