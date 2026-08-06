// Persistent markers for rows whose embedding call failed.
//
// `vectorIndexAddGuarded` (src/functions/search.ts) soft-fails on purpose:
// a downed embedder must not break the save path. The cost is that the
// failure is invisible — the observation persists, BM25 keeps working, and
// semantic recall quietly degrades with nothing to query afterwards. That
// is how a live store reached 2,651 vectors for 4,203 observations without
// a single surfaced error.
//
// These helpers add the missing half: every soft-failed embed writes a
// marker keyed by the row id, and every successful (re-)embed clears it.
// The scope is therefore a live worklist of known-unembedded ids AND a
// count. Deliberately additive — no field is added to CompressedObservation
// or Memory, so there is no schema migration and no rewrite of existing
// rows.
//
// The markers are a fast path, not the source of truth. Rows that were
// dropped before this existed have no marker, so `mem::embeddings-backfill`
// reconciles by scanning ids against the vector index instead of trusting
// the scope. See src/functions/embeddings-backfill.ts.

import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import { logger } from "../logger.js";

export type EmbeddingFailureKind = "memory" | "observation" | "synthetic";

export interface EmbeddingFailure {
  id: string;
  sessionId: string;
  kind: EmbeddingFailureKind;
  /** Why the embed did not land: provider threw, or returned a bad shape. */
  reason: "embed-error" | "dimension-mismatch";
  provider: string;
  /** ISO timestamp of the most recent failure for this id. */
  failedAt: string;
  /** How many times this id has failed, across the marker's lifetime. */
  attempts: number;
  /** Provider error message, truncated. Absent for dimension mismatches. */
  error?: string;
}

// Provider errors can carry an entire HTML error page or a multi-KB JSON
// body. The marker exists to name the cause, not to archive it.
const MAX_ERROR_CHARS = 300;

export function truncateError(message: string): string {
  return message.length <= MAX_ERROR_CHARS
    ? message
    : message.slice(0, MAX_ERROR_CHARS) + "…";
}

/**
 * Record (or refresh) the marker for a row whose embedding failed.
 *
 * Never throws: this runs inside an already-degraded path, and a KV write
 * failure here must not convert a soft-failed embed into a failed save.
 * Increments `attempts` when a marker already exists so a permanently
 * failing id is distinguishable from a one-off blip.
 */
export async function recordEmbeddingFailure(
  kv: StateKV,
  entry: Omit<EmbeddingFailure, "failedAt" | "attempts">,
): Promise<void> {
  try {
    const existing = await kv.get<EmbeddingFailure>(
      KV.embeddingFailures,
      entry.id,
    );
    const attempts =
      existing && Number.isFinite(existing.attempts) ? existing.attempts + 1 : 1;
    await kv.set<EmbeddingFailure>(KV.embeddingFailures, entry.id, {
      ...entry,
      failedAt: new Date().toISOString(),
      attempts,
    });
  } catch (err) {
    logger.error("Failed to record embedding-failure marker", {
      id: entry.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Drop the marker for a row that now has a vector.
 *
 * Never throws, for the same reason as above — and a stale marker is
 * harmless: the backfill reconciles against the vector index, so a marker
 * for an already-embedded id is skipped, not re-embedded.
 */
export async function clearEmbeddingFailure(
  kv: StateKV,
  id: string,
): Promise<void> {
  try {
    await kv.delete(KV.embeddingFailures, id);
  } catch (err) {
    logger.error("Failed to clear embedding-failure marker", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Every known-unembedded row. Returns [] rather than throwing. */
export async function listEmbeddingFailures(
  kv: StateKV,
): Promise<EmbeddingFailure[]> {
  try {
    const rows = await kv.list<EmbeddingFailure>(KV.embeddingFailures);
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === "string") : [];
  } catch (err) {
    logger.error("Failed to list embedding-failure markers", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
