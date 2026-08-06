// Deliberate backfill for rows that have no vector.
//
// `vectorIndexAddGuarded` soft-fails so a downed embedder can't break the
// save path. That is correct, and it is also how a store ends up with far
// fewer vectors than observations — every dropped embed left the row
// searchable by BM25 and invisible to semantic recall, permanently, with
// no way to find it again.
//
// This is the recovery path. It is NOT automatic: re-embedding a large
// corpus is a real spend against the embedding provider and can trip the
// same rate limit that caused the gap, so it only runs when a human (or an
// operator script) asks for it.
//
// Reconciliation is by SCAN, not by marker. The markers written by
// state/embedding-status.ts only cover failures observed since they
// existed; rows dropped before that have none. Comparing ids against the
// live vector index catches both, which is the whole point — the historical
// gap is the reason this exists. Markers are still cleared as ids are
// embedded so their count stays honest.
//
// Idempotent and resumable by construction: the worklist is derived from
// the current index each run, so a second run finds nothing, and a run
// stopped by `limit` or a provider outage simply leaves the rest for the
// next one.

import type { ISdk } from "iii-sdk";
import type { CompressedObservation, Memory, Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  getEmbeddingProvider,
  getVectorIndex,
  getSearchIndex,
  vectorIndexAddBatchGuarded,
  flushIndexSave,
} from "./search.js";
import { memoryToObservation } from "../state/memory-utils.js";
import { clearEmbeddingFailure } from "../state/embedding-status.js";
import { isRateLimitError } from "../providers/rate-limit-monitor.js";
import { logger } from "../logger.js";

export interface BackfillRequest {
  /** Count only. No embed calls, no index writes, no marker changes. */
  dryRun?: boolean;
  /** Stop after this many rows are embedded. Omit for "all of them". */
  limit?: number;
  /** Rows per embedBatch call. Defaults to DEFAULT_BATCH_SIZE. */
  batchSize?: number;
  /** Pause between batches, ms. Defaults to DEFAULT_DELAY_MS. */
  delayMs?: number;
}

export interface BackfillResult {
  success: boolean;
  dryRun: boolean;
  /** Embeddable rows examined (observations with a title, plus memories). */
  scanned: number;
  /** Of those, how many had no vector. */
  missing: number;
  /** Vectors written this run. */
  embedded: number;
  /** Rows the provider still refused. They keep their marker. */
  failed: number;
  /** Missing rows not attempted this run — hit `limit`, or the run stopped. */
  remaining: number;
  batches: number;
  /**
   * Of the missing rows, how many are absent from BM25 as well. A row
   * missing from BOTH indexes was never indexed at all (a lost flush)
   * rather than dropped by the embedder — see the note on bm25Repaired.
   */
  bm25Missing: number;
  /**
   * Keyword-index entries restored this run. Free (no provider call), and
   * done even for rows whose embed fails, because a row missing from BM25
   * is invisible to every search path, not just the semantic one.
   */
  bm25Repaired: number;
  /** Set when the run halted before working the whole list. */
  stoppedReason?: string;
  error?: string;
}

// 32 matches rebuildIndex's default: ~3.5k tokens per request, comfortably
// inside every provider's per-request budget, and close to per-call
// throughput on batch endpoints.
const DEFAULT_BATCH_SIZE = 32;

// A backfill is the one path that deliberately hammers the embedding
// endpoint, and the gap it repairs is usually a rate limit in the first
// place. Pacing between batches by default keeps the recovery from
// re-triggering the failure it exists to fix. Set delayMs: 0 to opt out.
const DEFAULT_DELAY_MS = 250;

// How many consecutive rate-limited batches to absorb before giving up.
// Pushing through a sustained 429 storm burns quota, trips the circuit
// breaker for every other provider call, and embeds nothing. Stopping
// early is safe because the run is resumable.
const MAX_CONSECUTIVE_RATE_LIMITED_BATCHES = 3;

type BackfillJob = {
  id: string;
  sessionId: string;
  text: string;
  context: { kind: "memory" | "observation" | "synthetic"; logId: string };
  /**
   * The row itself, so BM25 can be repaired alongside the vector.
   *
   * Vectors are not the only thing a broken index loses. On the install
   * that motivated this, every row missing a vector was missing its BM25
   * entry too — the indexes had simply never been flushed (fixed in
   * 519ad8a), so the rows were invisible to keyword AND semantic search.
   * Re-embedding alone would have left them half-lost, and BM25 costs
   * nothing to rebuild.
   */
  doc: CompressedObservation;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Walk every embeddable row and return the ones the vector index doesn't
 * hold. Per-session failures are isolated: one unreadable session must not
 * truncate the worklist and make the gap look smaller than it is.
 */
export async function findMissingVectors(
  kv: StateKV,
  has: (id: string) => boolean,
): Promise<{ jobs: BackfillJob[]; scanned: number }> {
  const jobs: BackfillJob[] = [];
  let scanned = 0;

  try {
    const memories = await kv.list<Memory>(KV.memories);
    for (const m of memories) {
      if (!m || m.isLatest === false) continue;
      if (!m.title || !m.content || m.content.trim() === "") continue;
      scanned++;
      if (has(m.id)) continue;
      jobs.push({
        id: m.id,
        sessionId: m.sessionIds?.[0] ?? "memory",
        text: m.title + " " + m.content,
        context: { kind: "memory", logId: m.id },
        doc: memoryToObservation(m),
      });
    }
  } catch (err) {
    logger.warn("embeddings-backfill: failed to list memories", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let sessions: Session[] = [];
  try {
    sessions = await kv.list<Session>(KV.sessions);
  } catch (err) {
    logger.warn("embeddings-backfill: failed to list sessions", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { jobs, scanned };
  }

  for (const session of sessions) {
    if (!session?.id) continue;
    try {
      const observations = await kv.list<CompressedObservation>(
        KV.observations(session.id),
      );
      for (const o of observations) {
        // Raw observations have no title — they aren't embedded on the
        // write path either, so counting them as "missing" would report a
        // gap that no backfill could ever close.
        if (!o?.title) continue;
        scanned++;
        if (has(o.id)) continue;
        jobs.push({
          id: o.id,
          sessionId: o.sessionId ?? session.id,
          text: o.title + " " + (o.narrative || ""),
          context: { kind: "observation", logId: o.id },
          doc: o,
        });
      }
    } catch (err) {
      logger.warn("embeddings-backfill: failed to list session observations", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { jobs, scanned };
}

export async function runEmbeddingsBackfill(
  kv: StateKV,
  request: BackfillRequest = {},
): Promise<BackfillResult> {
  const dryRun = request.dryRun === true;
  const batchSize = positiveInt(request.batchSize, DEFAULT_BATCH_SIZE);
  const delayMs =
    typeof request.delayMs === "number" &&
    Number.isFinite(request.delayMs) &&
    request.delayMs >= 0
      ? request.delayMs
      : DEFAULT_DELAY_MS;
  const limit =
    typeof request.limit === "number" && Number.isInteger(request.limit) && request.limit > 0
      ? request.limit
      : undefined;

  const empty = (error: string): BackfillResult => ({
    success: false,
    dryRun,
    scanned: 0,
    missing: 0,
    embedded: 0,
    failed: 0,
    remaining: 0,
    batches: 0,
    bm25Missing: 0,
    bm25Repaired: 0,
    error,
  });

  const vectorIndex = getVectorIndex();
  if (!vectorIndex) {
    return empty("no vector index is initialised — semantic search is disabled");
  }
  const provider = getEmbeddingProvider();
  // A dry run only needs the index to compute the gap. Requiring a live
  // provider would make the diagnostic unavailable in exactly the
  // situation it's for: a misconfigured embedder.
  if (!provider && !dryRun) {
    return empty("no embedding provider is configured — check credentials and base URL");
  }

  const { jobs, scanned } = await findMissingVectors(kv, (id) =>
    vectorIndex.has(id),
  );
  const missing = jobs.length;

  const bm25 = getSearchIndex();
  const bm25Missing = jobs.reduce((n, job) => (bm25.has(job.id) ? n : n + 1), 0);

  if (dryRun) {
    logger.info("embeddings-backfill: dry run", {
      scanned,
      missing,
      bm25Missing,
      indexed: vectorIndex.size,
      provider: provider?.name ?? "none",
    });
    return {
      success: true,
      dryRun: true,
      scanned,
      missing,
      embedded: 0,
      failed: 0,
      remaining: missing,
      batches: 0,
      bm25Missing,
      bm25Repaired: 0,
    };
  }

  const worklist = limit !== undefined ? jobs.slice(0, limit) : jobs;

  logger.info("embeddings-backfill: starting", {
    scanned,
    missing,
    bm25Missing,
    attempting: worklist.length,
    batchSize,
    delayMs,
    provider: provider?.name ?? "none",
  });

  let embedded = 0;
  let failed = 0;
  let batches = 0;
  let processed = 0;
  let bm25Repaired = 0;
  let consecutiveRateLimited = 0;
  let stoppedReason: string | undefined;

  for (let i = 0; i < worklist.length; i += batchSize) {
    const batch = worklist.slice(i, i + batchSize);

    // Keyword index first, and unconditionally. It needs no provider call,
    // so it must not be hostage to the embed succeeding — a row missing
    // from BM25 is missing from every search path.
    for (const job of batch) {
      if (bm25.has(job.id)) continue;
      try {
        bm25.add(job.doc);
        bm25Repaired++;
      } catch (err) {
        logger.warn("embeddings-backfill: BM25 repair failed", {
          id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let result: { ok: number; fail: number };
    try {
      result = await vectorIndexAddBatchGuarded(batch);
    } catch (err) {
      // vectorIndexAddBatchGuarded swallows provider errors itself, so
      // reaching here means something unexpected broke. Stop rather than
      // spin: the run is resumable.
      stoppedReason = `batch threw: ${err instanceof Error ? err.message : String(err)}`;
      if (isRateLimitError(err)) consecutiveRateLimited++;
      break;
    }
    batches++;
    processed += batch.length;
    embedded += result.ok;
    failed += result.fail;

    // Clear the markers for ids that now have a vector. The batch helper
    // clears on its own success path too; this covers rows that were
    // marked before the sink was wired, or by a previous process.
    if (result.ok > 0) {
      for (const job of batch) {
        if (vectorIndex.has(job.id)) await clearEmbeddingFailure(kv, job.id);
      }
    }

    if (result.ok === 0 && result.fail === batch.length) {
      consecutiveRateLimited++;
      if (consecutiveRateLimited >= MAX_CONSECUTIVE_RATE_LIMITED_BATCHES) {
        stoppedReason =
          `${consecutiveRateLimited} consecutive batches failed entirely — ` +
          `stopping so the run doesn't burn quota against a downed or rate-limited provider. ` +
          `Re-run to resume; already-embedded rows are skipped.`;
        break;
      }
    } else {
      consecutiveRateLimited = 0;
    }

    if (delayMs > 0 && i + batchSize < worklist.length) await sleep(delayMs);
  }

  // The indexes only changed in memory. Flush synchronously rather than
  // scheduling: a backfill is a deliberate one-shot, and losing the whole
  // run to a process exit inside the debounce window would mean paying the
  // provider twice for the same vectors — which is precisely the failure
  // (a deferred flush discarded at restart) that created the gap.
  if (embedded > 0 || bm25Repaired > 0) await flushIndexSave();

  const remaining = missing - processed;
  const result: BackfillResult = {
    success: stoppedReason === undefined,
    dryRun: false,
    scanned,
    missing,
    embedded,
    failed,
    remaining: remaining > 0 ? remaining : 0,
    batches,
    bm25Missing,
    bm25Repaired,
    ...(stoppedReason ? { stoppedReason } : {}),
  };

  logger.info("embeddings-backfill: complete", {
    scanned,
    missing,
    embedded,
    failed,
    bm25Repaired,
    remaining: result.remaining,
    batches,
    indexed: vectorIndex.size,
    ...(stoppedReason ? { stoppedReason } : {}),
  });

  return result;
}

export function registerEmbeddingsBackfillFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::embeddings-backfill", async (data: BackfillRequest) =>
    runEmbeddingsBackfill(kv, data || {}),
  );
}
