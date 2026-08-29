import type { Memory } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  getSearchIndex,
  vectorIndexRemove,
  scheduleIndexSave,
} from "./search.js";
import { logger } from "../logger.js";

/**
 * Retire a memory: mark it non-latest, persist it, and take it out of the
 * search indexes.
 *
 * This exists as one funnel because the third step kept being forgotten, and
 * forgetting it is invisible until someone reads a stale answer.
 *
 * `isLatest` governs KV reads. It does not govern search. The BM25 index is
 * persisted to disk and restored on boot, and the KV-driven rebuild only ADDS
 * entries missing from the restored index — see rebuildIndex in search.ts,
 * which skips `isLatest === false` on the way in but never removes what is
 * already there. So a memory indexed while it was live stays searchable
 * forever after being superseded, and `search` happily returns a current
 * memory and its retracted predecessor side by side with nothing to say which
 * is which.
 *
 * Found on the launchproof dossier pilot, 2026-08-29: a cold boot returned
 * the current dossier at rank 1 and a superseded one at rank 2. The same hole
 * was open in mem::remember, mem::consolidate, mem::evolve, mem::auto-forget
 * and mem::heal, all of which demoted a memory and left it indexed.
 *
 * Indexing failures are logged, not thrown: the demotion itself is the
 * correctness-critical part and must not be rolled back because an index
 * write failed. A stale index entry is recoverable; a memory left flagged
 * live is not.
 */
export async function demoteMemory(
  kv: StateKV,
  memory: Memory,
  reason: string,
): Promise<void> {
  memory.isLatest = false;
  memory.updatedAt = new Date().toISOString();
  await kv.set(KV.memories, memory.id, memory);
  unindexMemory(memory.id, reason);
  scheduleIndexSave();
}

/**
 * Remove one memory from both search indexes.
 *
 * Split out for callers that persist the row themselves (a read-modify-write
 * under their own lock, say) but still owe the indexes an update.
 */
export function unindexMemory(memoryId: string, reason: string): void {
  try {
    getSearchIndex().remove(memoryId);
    vectorIndexRemove(memoryId);
  } catch (err) {
    logger.warn("Failed to unindex memory", {
      memoryId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
