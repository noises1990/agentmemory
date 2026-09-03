import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV, generateId } from "./schema.js";
import { IndexShardStore } from "./index-shard-store.js";
import { logger } from "../logger.js";
import { safeAudit } from "../functions/audit.js";

const DEBOUNCE_MS = 5000;
/**
 * Ceiling on how long a stream of adds may defer the flush.
 *
 * scheduleSave() was a pure debounce: every call cleared the pending timer
 * and started a new one. Under a busy agent, observations arrive faster than
 * DEBOUNCE_MS indefinitely, so the flush was rescheduled forever and the
 * index never reached disk — the in-memory index grew for days while the
 * shards on disk stayed at the last boot-time write, and every restart threw
 * the difference away. Past this bound we stop resetting and let the pending
 * timer fire, capping staleness at roughly MAX_DEFER_MS + DEBOUNCE_MS.
 */
const MAX_DEFER_MS = 60_000;
const FAILURE_LOG_THROTTLE_MS = 60_000;
const INDEX_PERSISTENCE_FUNCTION_ID = "mem::index-persistence";
const BM25_KEY = "data";
const BM25_MANIFEST_KEY = "data:manifest";
const BM25_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:bm25:`;
const VECTOR_KEY = "vectors";
const VECTOR_MANIFEST_KEY = "vectors:manifest";
const VECTOR_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:vectors:`;
const INDEX_SHARD_KEY = "data";
const DEFAULT_INDEX_SHARD_CHARS = 2_000_000;

type IndexShardManifest = {
  v: 1;
  generation?: string;
  /**
   * `path` present means the shard body lives on disk, not in the state
   * store. Absent means a pre-file-store manifest, which still loads from KV
   * — that is the whole migration: old manifests keep working, and the first
   * save after upgrading writes files and lets the existing
   * previous-generation cleanup drop the KV rows it replaced.
   */
  shards: Array<{ scope: string; key: string; chars: number; path?: string }>;
  chars: number;
};

/**
 * Write-ahead record of every generation whose shards may exist on disk.
 *
 * Why this is needed: shards are written BEFORE the manifest that references
 * them is published. A process killed in that window leaves shards that no
 * manifest ever named, and the state store has no scope enumeration, so
 * nothing can find them again — they are unreachable and permanent.
 *
 * The previous cleanup only walked the shards listed in the manifest read at
 * the start of the save, so it collected exactly one generation back on the
 * clean path and could not see a crash-orphaned one at all.
 *
 * Measured on the VPS, 2026-09-02: 413 generations on disk, 1,305 shard
 * files, 2.34 GB. The live manifest referenced 2 shards, 7.4 MB. The other
 * 94% was 411 generations orphaned by 411 OOM kills, and the engine loaded
 * the whole scope at boot — reaching the 3 GB cap in 15 seconds, before
 * doing any work. Each crash added a generation, so the load grew every
 * cycle and the spiral could not converge.
 *
 * The ledger is the intent log that makes them reachable: an entry is
 * written before the shards, so a crash at any point leaves a record the
 * next boot can collect.
 */
type IndexGenerationLedger = {
  v: 1;
  generations: Array<{
    generation: string;
    // Carries `path` for the same reason the manifest does: the collector has
    // to know whether a shard body is a file or a state-store row, and the
    // ledger is the only record that survives a kill before the publish.
    shards: Array<{ scope: string; key: string; path?: string }>;
  }>;
};

/** Ledger entries retained before older ones are force-collected. */
const MAX_LEDGER_ENTRIES = 256;

type IndexPersistenceOptions = {
  shardChars?: number;
  createGeneration?: () => string;
  /**
   * Directory for file-backed shards. Unset keeps shards in the state store,
   * which is the pre-existing behaviour and what the older tests exercise.
   */
  dataDir?: string;
};

function shardChars(options: IndexPersistenceOptions): number {
  const configured = options.shardChars;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_INDEX_SHARD_CHARS;
  }
  const wholeChars = Math.floor(configured);
  return wholeChars >= 1 ? wholeChars : DEFAULT_INDEX_SHARD_CHARS;
}

function createIndexGeneration(): string {
  return generateId("idx");
}

function statePath(scope: string, key: string): string {
  return `${scope}/${key}`;
}

/** Ledger lives beside its manifest, so bm25 and vectors stay independent. */
function ledgerKey(manifestKey: string): string {
  return `${manifestKey}:generations`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isValidShardDescriptor(
  shard: unknown,
): shard is IndexShardManifest["shards"][number] {
  if (!shard || typeof shard !== "object") return false;
  const candidate = shard as {
    scope?: unknown;
    key?: unknown;
    chars?: unknown;
    path?: unknown;
  };
  if (candidate.path !== undefined) {
    if (typeof candidate.path !== "string" || candidate.path.length === 0) {
      return false;
    }
  }
  return (
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    Number.isInteger(candidate.chars) &&
    candidate.chars >= 0
  );
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest currently-unflushed add was scheduled; 0 when idle. */
  private pendingSince = 0;
  private lastFailureLogAt = 0;

  /** Set only when a dataDir is configured; null keeps shards in the store. */
  private readonly shardStore: IndexShardStore | null;

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private options: IndexPersistenceOptions = {},
  ) {
    this.shardStore = options.dataDir
      ? new IndexShardStore(options.dataDir)
      : null;
  }

  scheduleSave(): void {
    const now = Date.now();
    if (this.timer) {
      // Past the ceiling, leave the pending timer alone so it actually
      // fires; resetting again is what let a busy daemon defer the flush
      // indefinitely. See MAX_DEFER_MS.
      if (now - this.pendingSince >= MAX_DEFER_MS) return;
      clearTimeout(this.timer);
    } else {
      this.pendingSince = now;
    }
    // setTimeout discards the returned promise, so any rejection inside
    // save() would surface as unhandledRejection and crash the process
    // under sustained iii-engine write timeouts (issue #204). Funnel
    // rejections through logFailure() instead.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingSince = 0;
      this.save().catch((err) => this.logFailure(err));
    }, DEBOUNCE_MS);
  }

  async save(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingSince = 0;
    try {
      await this.saveBm25Index(this.bm25.serialize());
      if (this.vector) {
        await this.saveVectorIndex(this.vector.serialize());
      }
    } catch (err) {
      this.logFailure(err);
    }
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    let bm25: SearchIndex | null = null;
    let vector: VectorIndex | null = null;

    const bm25Data = await this.loadBm25Data();
    if (bm25Data && typeof bm25Data === "string") {
      bm25 = SearchIndex.deserialize(bm25Data);
    }

    const vecData = await this.loadVectorData();
    if (vecData && typeof vecData === "string") {
      vector = VectorIndex.deserialize(vecData);
    }

    // Collect at boot, not only on save. A save-time sweep never runs when
    // the process is being killed before it can save — which is exactly the
    // condition that produces orphans, so the leak compounds fastest in the
    // case the save-time sweep cannot reach. Boot is the one moment a
    // crash-looping process reliably gets to.
    await this.collectAtBoot();

    return { bm25, vector };
  }

  /**
   * Delete every generation except the ones the live manifests name.
   *
   * Reads each manifest for its generation rather than assuming, so a boot
   * that loaded a valid index never collects the shards that index came
   * from. When a manifest is missing or unreadable the generation is
   * undefined, and collectOrphanedGenerations then keeps nothing — correct,
   * because with no live manifest every recorded generation is unreachable.
   */
  private async collectAtBoot(): Promise<void> {
    for (const manifestKey of [BM25_MANIFEST_KEY, VECTOR_MANIFEST_KEY]) {
      const manifest = await this.kv
        .get<IndexShardManifest>(KV.bm25Index, manifestKey)
        .catch(() => null);
      await this.collectOrphanedGenerations(manifestKey, manifest?.generation);
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingSince = 0;
  }

  private logFailure(err: unknown): void {
    const now = Date.now();
    // Throttle: persistence failures under load arrive in bursts
    // (iii-engine queue pressure). Logging every debounce flush adds
    // noise without information.
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("index persistence: failed to save BM25/vector index", {
      code,
      message,
      hint:
        code === "TIMEOUT"
          ? "iii-engine state::set timed out; recent index updates remain in memory and will retry on the next debounce flush"
          : undefined,
    });
  }

  private async saveBm25Index(serialized: string): Promise<void> {
    await this.saveShardedIndex(
      serialized,
      BM25_MANIFEST_KEY,
      BM25_KEY,
      BM25_SHARD_SCOPE_PREFIX,
    );
  }

  private async saveVectorIndex(serialized: string): Promise<void> {
    await this.saveShardedIndex(
      serialized,
      VECTOR_MANIFEST_KEY,
      VECTOR_KEY,
      VECTOR_SHARD_SCOPE_PREFIX,
    );
  }

  private async saveShardedIndex(
    serialized: string,
    manifestKey: string,
    legacyKey: string,
    scopePrefix: string,
  ): Promise<void> {
    const previous = await this.kv
      .get<IndexShardManifest>(KV.bm25Index, manifestKey)
      .catch(() => null);
    const generation =
      this.options.createGeneration?.() ?? createIndexGeneration();
    const chunkChars = shardChars(this.options);
    const shards: IndexShardManifest["shards"] = [];
    const chunks: string[] = [];

    // `kind` separates bm25 from vector shards on disk, mirroring the scope
    // prefix they already use in the store.
    const kind = scopePrefix.endsWith(":vectors:") ? "vectors" : "bm25";

    for (let offset = 0; offset < serialized.length; offset += chunkChars) {
      const shardIndex = shards.length;
      const scope = `${scopePrefix}${generation}:${String(shardIndex).padStart(
        5,
        "0",
      )}`;
      const chunk = serialized.slice(offset, offset + chunkChars);
      shards.push({
        scope,
        key: INDEX_SHARD_KEY,
        chars: chunk.length,
        // scope/key stay populated even for file shards so a manifest keeps
        // one shape, and so the ledger and audit trail read the same either
        // way. `path` is what decides where the body actually lives.
        ...(this.shardStore
          ? { path: this.shardStore.shardPath(kind, generation, shardIndex) }
          : {}),
      });
      chunks.push(chunk);
    }

    // Write-ahead: record this generation before a single shard lands, so a
    // kill between here and the manifest publish still leaves something the
    // boot collector can find. Deliberately not fatal — failing to record
    // the intent is a leak risk, not a correctness one, and refusing to save
    // the index because the ledger write failed would be the worse trade.
    await this.recordGeneration(manifestKey, generation, shards);

    const writeResults = await Promise.allSettled(
      shards.map(async (shard, index) => {
        const chunk = chunks[index] ?? "";
        if (shard.path && this.shardStore) {
          await this.shardStore.write(shard.path, chunk);
        } else {
          await this.kv.set(shard.scope, shard.key, chunk);
        }
        await this.auditIndexPersistence("shard_write", [
          statePath(shard.scope, shard.key),
        ], {
          scope: shard.scope,
          key: shard.key,
          manifestKey,
          generation,
          chars: chunk.length,
        });
      }),
    );
    const failedWrite = writeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedWrite) {
      await this.deleteShards(shards, "shard_write_rollback");
      throw failedWrite.reason;
    }

    const nextManifest: IndexShardManifest = {
      v: 1,
      generation,
      shards,
      chars: serialized.length,
    };
    try {
      await this.kv.set<IndexShardManifest>(
        KV.bm25Index,
        manifestKey,
        nextManifest,
      );
      await this.auditIndexPersistence("manifest_publish", [
        statePath(KV.bm25Index, manifestKey),
      ], {
        manifestKey,
        generation,
        chars: serialized.length,
        shards: shards.length,
        result: "committed",
      });
    } catch (err) {
      if (await this.isManifestPublished(manifestKey, nextManifest)) {
        await this.auditIndexPersistence("manifest_publish", [
          statePath(KV.bm25Index, manifestKey),
        ], {
          manifestKey,
          generation,
          chars: serialized.length,
          shards: shards.length,
          result: "committed_after_error",
          error: errorMessage(err),
        });
      } else {
        await this.deleteShards(shards, "manifest_publish_rollback");
      }
      throw err;
    }

    await this.deleteKey(KV.bm25Index, legacyKey, "legacy_cleanup");
    if (previous?.v === 1 && Array.isArray(previous.shards)) {
      const currentShardIds = new Set(
        shards.map((shard) => `${shard.scope}\0${shard.key}`),
      );
      for (const shard of previous.shards) {
        if (currentShardIds.has(`${shard.scope}\0${shard.key}`)) continue;
        await this.deleteShards([shard], "previous_generation_cleanup");
      }
    }

    // Collect anything the manifest walk above cannot see: generations
    // orphaned by a kill between shard write and manifest publish.
    await this.collectOrphanedGenerations(manifestKey, generation);
  }

  /**
   * Add a generation to the ledger before its shards are written.
   *
   * Never throws. A ledger write failure means a future leak, which a later
   * collection cannot fix — but refusing to persist the index because
   * bookkeeping failed trades a real loss for a hypothetical one.
   */
  private async recordGeneration(
    manifestKey: string,
    generation: string,
    shards: IndexShardManifest["shards"],
  ): Promise<void> {
    try {
      const ledger = await this.readLedger(manifestKey);
      const entries = ledger.generations.filter(
        (entry) => entry.generation !== generation,
      );
      entries.push({
        generation,
        shards: shards.map((shard) => ({
          scope: shard.scope,
          key: shard.key,
          ...(shard.path ? { path: shard.path } : {}),
        })),
      });
      await this.kv.set<IndexGenerationLedger>(
        KV.bm25Index,
        ledgerKey(manifestKey),
        // Newest kept, so an overflowing ledger drops the oldest entries —
        // the ones most likely already collected by an earlier sweep.
        { v: 1, generations: entries.slice(-MAX_LEDGER_ENTRIES) },
      );
    } catch (err) {
      logger.warn("index persistence: failed to record generation in ledger", {
        manifestKey,
        generation,
        error: errorMessage(err),
      });
    }
  }

  private async readLedger(manifestKey: string): Promise<IndexGenerationLedger> {
    const raw = await this.kv
      .get<IndexGenerationLedger>(KV.bm25Index, ledgerKey(manifestKey))
      .catch(() => null);
    if (!raw || raw.v !== 1 || !Array.isArray(raw.generations)) {
      return { v: 1, generations: [] };
    }
    // Defensive: one malformed entry must not abort the sweep for the rest.
    return {
      v: 1,
      generations: raw.generations.filter(
        (entry) =>
          entry &&
          typeof entry.generation === "string" &&
          Array.isArray(entry.shards),
      ),
    };
  }

  /**
   * Delete every generation the ledger knows about except the live one, then
   * shrink the ledger to match.
   *
   * `keepGeneration` is the generation the current manifest names. It is
   * passed in rather than re-read so a collection running straight after a
   * publish cannot race its own manifest write and delete what it just
   * wrote.
   */
  async collectOrphanedGenerations(
    manifestKey: string,
    keepGeneration: string | undefined,
  ): Promise<{ collected: number; shards: number }> {
    let collected = 0;
    let shards = 0;
    try {
      const ledger = await this.readLedger(manifestKey);
      const survivors: IndexGenerationLedger["generations"] = [];

      for (const entry of ledger.generations) {
        if (keepGeneration && entry.generation === keepGeneration) {
          survivors.push(entry);
          continue;
        }
        for (const shard of entry.shards) {
          await this.deleteShard(shard, "orphan_generation_gc");
          shards++;
        }
        collected++;
      }

      if (collected > 0) {
        await this.kv.set<IndexGenerationLedger>(
          KV.bm25Index,
          ledgerKey(manifestKey),
          { v: 1, generations: survivors },
        );
        logger.info("index persistence: collected orphaned generations", {
          manifestKey,
          collected,
          shards,
          kept: keepGeneration ?? null,
        });
      }
    } catch (err) {
      logger.warn("index persistence: generation collection failed", {
        manifestKey,
        error: errorMessage(err),
      });
    }
    return { collected, shards };
  }

  private async auditIndexPersistence(
    action: string,
    targetIds: string[],
    details: Record<string, unknown>,
  ): Promise<void> {
    await safeAudit(
      this.kv,
      "index_persist",
      INDEX_PERSISTENCE_FUNCTION_ID,
      targetIds,
      { action, ...details },
    );
  }

  private async deleteKey(
    scope: string,
    key: string,
    reason: string,
  ): Promise<void> {
    let result = "deleted";
    let error: string | undefined;
    try {
      await this.kv.delete(scope, key);
    } catch (err) {
      result = "failed";
      error = errorMessage(err);
    }
    await this.auditIndexPersistence("delete", [statePath(scope, key)], {
      scope,
      key,
      reason,
      result,
      error,
    });
  }

  private async deleteShards(
    shards: IndexShardManifest["shards"],
    reason: string,
  ): Promise<void> {
    for (const shard of shards) {
      await this.deleteShard(shard, reason);
    }
  }

  /**
   * Delete one shard from wherever its body actually lives.
   *
   * A shard written before the file store existed has no `path` and is
   * removed from the state store; anything with a `path` is a file. Getting
   * this wrong in either direction leaks: deleting only the KV row leaves the
   * file, and deleting only the file leaves the row.
   */
  private async deleteShard(
    shard: { scope: string; key: string; path?: string },
    reason: string,
  ): Promise<void> {
    if (shard.path && this.shardStore) {
      try {
        await this.shardStore.remove(shard.path);
      } catch (err) {
        logger.warn("index persistence: failed to remove shard file", {
          path: shard.path,
          reason,
          error: errorMessage(err),
        });
      }
      return;
    }
    await this.deleteKey(shard.scope, shard.key, reason);
  }

  private async isManifestPublished(
    manifestKey: string,
    expected: IndexShardManifest,
  ): Promise<boolean> {
    const published = await this.kv
      .get<IndexShardManifest>(KV.bm25Index, manifestKey)
      .catch(() => null);
    if (
      published?.v !== 1 ||
      published.generation !== expected.generation ||
      published.chars !== expected.chars ||
      !Array.isArray(published.shards) ||
      published.shards.length !== expected.shards.length
    ) {
      return false;
    }
    return published.shards.every((shard, index) => {
      const expectedShard = expected.shards[index];
      if (!expectedShard) return false;
      return (
        shard.scope === expectedShard.scope &&
        shard.key === expectedShard.key &&
        shard.chars === expectedShard.chars
      );
    });
  }

  private async loadBm25Data(): Promise<string | null> {
    return this.loadShardedData(BM25_KEY, BM25_MANIFEST_KEY, "BM25");
  }

  private async loadVectorData(): Promise<string | null> {
    return this.loadShardedData(VECTOR_KEY, VECTOR_MANIFEST_KEY, "vector");
  }

  private async loadShardedData(
    legacyKey: string,
    manifestKey: string,
    label: string,
  ): Promise<string | null> {
    const manifest = await this.readIndexValue<IndexShardManifest>(
      KV.bm25Index,
      manifestKey,
      label,
      "manifest",
    );
    if (!manifest.ok) return null;
    // #797: some iii-state adapters return `undefined` (not `null`) for
    // a missing key. The previous `value !== null` check passed
    // undefined through to loadManifestData, which then crashed on
    // `manifest.v` with TypeError. Treat both null and undefined as
    // "no manifest" and fall through to the legacy path. The shape
    // check stays so a malformed-but-present row still fails closed.
    if (
      manifest.value != null &&
      typeof manifest.value === "object"
    ) {
      return this.loadManifestData(manifest.value, label);
    }

    const legacy = await this.readIndexValue<string>(
      KV.bm25Index,
      legacyKey,
      label,
      "legacy",
    );
    if (!legacy.ok) return null;
    if (legacy.value && typeof legacy.value === "string") return legacy.value;
    return null;
  }

  private async readIndexValue<T>(
    scope: string,
    key: string,
    label: string,
    source: "manifest" | "legacy",
  ): Promise<{ ok: true; value: T | null } | { ok: false }> {
    try {
      return { ok: true, value: await this.kv.get<T>(scope, key) };
    } catch (err) {
      logger.warn(`index persistence: ${label} ${source} read failed`, {
        scope,
        key,
        message: errorMessage(err),
      });
      return { ok: false };
    }
  }

  private async loadManifestData(
    manifest: IndexShardManifest,
    label: string,
  ): Promise<string | null> {
    if (
      manifest.v !== 1 ||
      !Array.isArray(manifest.shards) ||
      manifest.shards.length === 0 ||
      !Number.isInteger(manifest.chars) ||
      manifest.chars < 0
    ) {
      logger.warn(`index persistence: ${label} shard manifest invalid`);
      return null;
    }
    for (const shard of manifest.shards) {
      if (!isValidShardDescriptor(shard)) {
        logger.warn(`index persistence: ${label} shard manifest invalid`);
        return null;
      }
    }
    const loadedShards = await Promise.all(
      manifest.shards.map(async (shard) => ({
        shard,
        chunk:
          shard.path && this.shardStore
            ? await this.shardStore.read(shard.path).catch(() => null)
            : await this.kv
                .get<string>(shard.scope, shard.key)
                .catch(() => null),
      })),
    );
    const chunks: string[] = [];
    let chars = 0;
    for (const { shard, chunk } of loadedShards) {
      if (typeof chunk !== "string") {
        logger.warn(`index persistence: ${label} shard missing`, {
          scope: shard.scope,
          key: shard.key,
        });
        return null;
      }
      if (chunk.length !== shard.chars) {
        logger.warn(`index persistence: ${label} shard length mismatch`, {
          scope: shard.scope,
          key: shard.key,
          expected: shard.chars,
          actual: chunk.length,
        });
        return null;
      }
      chunks.push(chunk);
      chars += chunk.length;
    }
    if (chars !== manifest.chars) {
      logger.warn(`index persistence: ${label} total length mismatch`, {
        expected: manifest.chars,
        actual: chars,
      });
      return null;
    }
    return chunks.join("");
  }
}
