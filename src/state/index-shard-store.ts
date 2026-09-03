import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { logger } from "../logger.js";

/**
 * File-backed storage for serialized index shards.
 *
 * Why the index does not belong in the state store: the iii engine loads a
 * whole scope into memory at startup, and the BM25/vector index is by far the
 * largest thing agentmemory writes — it is a serialized blob measured in tens
 * to hundreds of megabytes, sharded only so individual state writes stay a
 * sane size. Everything else in the store is small rows.
 *
 * Measured on the VPS, 2026-09-02: with a 312 MB store the engine held 2,398
 * MB of anonymous memory against a 3 GB cap, and before the orphaned
 * generations were removed the same scope held 2.34 GB and put the engine at
 * its ceiling in 15 seconds from boot. The index is the one item whose size
 * is unbounded by anything the user does.
 *
 * Shards on disk are read by exactly one process, are written whole, and are
 * never queried — none of what a KV buys is being used. The manifest stays in
 * the state store: it is small, and keeping it there preserves the existing
 * atomicity story, where the manifest publish is the single commit point that
 * makes a generation live.
 *
 * Migration is by manifest field, not by flag day. A shard descriptor written
 * before this existed has no `path`, so it still loads from KV; the first save
 * after upgrading writes files and the existing previous-generation cleanup
 * removes the KV rows it replaced. No migration step, no dual-write window.
 */
export class IndexShardStore {
  /** Absolute directory holding every shard file. */
  private readonly baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = resolve(dataDir, "index-shards");
  }

  /**
   * Relative path for one shard, recorded in the manifest.
   *
   * Relative rather than absolute so a store that is moved or restored to a
   * different path — a restic restore into a new prefix, say — still resolves.
   */
  shardPath(kind: string, generation: string, index: number): string {
    return `${kind}/${generation}/${String(index).padStart(5, "0")}.shard`;
  }

  private absolute(relPath: string): string | null {
    const abs = resolve(this.baseDir, relPath);
    // Refuse anything that escapes the shard directory. The path comes from a
    // manifest, and a manifest is data — treating it as trusted input is how a
    // corrupt or tampered row turns into an arbitrary file delete.
    if (abs !== this.baseDir && !abs.startsWith(this.baseDir + sep)) {
      logger.warn("index shard store: refusing path outside the shard dir", {
        relPath,
      });
      return null;
    }
    return abs;
  }

  /**
   * Write one shard.
   *
   * Writes a temp file and renames it. rename is atomic within a filesystem,
   * so a reader never sees a partially written shard, and a process killed
   * mid-write leaves a `.tmp` that the next collection removes rather than a
   * truncated shard that would fail the length check on load.
   */
  async write(relPath: string, content: string): Promise<void> {
    const abs = this.absolute(relPath);
    if (!abs) throw new Error(`invalid shard path: ${relPath}`);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, abs);
  }

  /** Read one shard, or null when it is missing or unreadable. */
  async read(relPath: string): Promise<string | null> {
    const abs = this.absolute(relPath);
    if (!abs) return null;
    try {
      return await readFile(abs, "utf-8");
    } catch {
      return null;
    }
  }

  /** Remove one shard. Missing is success — collection must be idempotent. */
  async remove(relPath: string): Promise<void> {
    const abs = this.absolute(relPath);
    if (!abs) return;
    await rm(abs, { force: true });
    await rm(`${abs}.tmp`, { force: true });
  }

  /**
   * Remove a whole generation's directory.
   *
   * Cheaper than unlinking shard by shard, and it also takes the `.tmp` files
   * left by a kill mid-write, which no manifest or ledger records.
   */
  async removeGeneration(kind: string, generation: string): Promise<void> {
    const abs = this.absolute(`${kind}/${generation}`);
    if (!abs) return;
    await rm(abs, { recursive: true, force: true });
  }
}
