import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  SessionSummary,
  MemoryProvider,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  SUMMARY_SYSTEM,
  buildSummaryPrompt,
  REDUCE_SYSTEM,
  buildReducePrompt,
  renderObservation,
  OBSERVATION_SEPARATOR,
} from "../prompts/summary.js";
import {
  promptCharBudget,
  resolveContextWindow,
  getMaxOutputTokens,
} from "../providers/context-windows.js";
import { isNonRetryableError } from "../providers/provider-errors.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SummaryOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreSummary } from "../eval/quality.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";

// Concurrent in-flight chunk calls. 6 keeps a 100-chunk session under
// iii's 180s function-invocation timeout at ~8s/call while staying
// inside generous-but-not-unlimited provider rate limits (well below
// OpenAI free tier's 500 RPM). High-throughput providers
// (Novita / DeepInfra / DeepSeek) typically allow 100+ concurrent — set
// SUMMARIZE_CHUNK_CONCURRENCY higher to cover ~1000+ chunk sessions.
const CHUNK_CONCURRENCY_DEFAULT = 6;
// Bail on the merged summary if more than this fraction of chunks fail
// to parse — a half-blind narrative is worse than a clean error.
const MAX_SKIP_RATIO = 0.5;

/**
 * Optional hard ceiling on observations per chunk.
 *
 * There is deliberately no default. Chunking is sized by the model's
 * context window (see buildChunks); SUMMARIZE_CHUNK_SIZE only exists to cap
 * it further. The previous default of 400 was a constant tuned for
 * 128k-window models that silently produced 42-49k-token prompts against a
 * 32k model, failing every summary with HTTP 413 before the provider did
 * any work.
 */
function getChunkSizeCap(): number {
  const raw = process.env.SUMMARIZE_CHUNK_SIZE;
  if (!raw) return Number.POSITIVE_INFINITY;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

/**
 * Split observations so that each chunk's rendered prompt fits the model's
 * context window, measuring each observation with the same renderer the
 * prompt builder uses.
 *
 * A single observation larger than the whole budget still gets its own
 * chunk: it will probably fail, but isolating it means it fails alone
 * instead of poisoning a chunk full of usable neighbours.
 */
function buildChunks(
  compressed: CompressedObservation[],
  model: string,
): CompressedObservation[][] {
  const budget = promptCharBudget(model, getMaxOutputTokens());
  const cap = getChunkSizeCap();
  const sep = OBSERVATION_SEPARATOR.length;

  const chunks: CompressedObservation[][] = [];
  let current: CompressedObservation[] = [];
  let currentChars = 0;

  for (const obs of compressed) {
    const cost = renderObservation(obs, current.length).length + sep;
    const wouldOverflow = currentChars + cost > budget;
    if (current.length > 0 && (wouldOverflow || current.length >= cap)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(obs);
    currentChars += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function getChunkConcurrency(): number {
  const raw = process.env.SUMMARIZE_CHUNK_CONCURRENCY;
  if (!raw) return CHUNK_CONCURRENCY_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_CONCURRENCY_DEFAULT;
}

// One chunk call with retry-once. Returns null when both attempts fail —
// whether by parse failure, provider 4xx (content rejected by upstream
// filters), or transient network/5xx errors that didn't recover on retry.
// All failure modes are equivalent at this layer: the chunk is unusable,
// skip it and let the caller decide via the skip-ratio bailout whether
// the overall summary is still trustworthy. Errors that affect every
// chunk (auth, model down) will trip the bailout naturally.
async function summarizeChunkWithRetry(
  provider: MemoryProvider,
  chunk: CompressedObservation[],
  sessionId: string,
  project: string,
  idx: number,
  total: number,
): Promise<SessionSummary | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const xml = await provider.summarize(
        SUMMARY_SYSTEM,
        buildSummaryPrompt(chunk),
      );
      const parsed = parseSummaryXml(xml, sessionId, project, chunk.length);
      if (parsed) return parsed;
      logger.warn("Summarize chunk parse failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
      });
    } catch (err) {
      logger.warn("Summarize chunk LLM call failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      // Retrying a rejected payload re-sends the identical prompt for an
      // identical rejection. It cannot succeed, it doubles the latency of
      // an already-failing summary, and — before the breaker learned to
      // ignore these — each wasted attempt counted as provider ill-health.
      if (isNonRetryableError(err)) return null;
    }
  }
  return null;
}

// Returns the final summary XML string. Observations are packed into as few
// chunks as the model's context window allows; a session that fits in one
// chunk is a single call. Larger sessions are processed in parallel batches,
// each chunk retried once on parse failure, persistently-bad chunks skipped,
// and remaining partials merged via a reduce call.
async function produceSummaryXml(
  provider: MemoryProvider,
  compressed: CompressedObservation[],
  sessionId: string,
  project: string,
): Promise<{
  response: string;
  mode: "single" | "chunked";
  chunks: number;
  skipped?: number;
}> {
  const model = provider.model ?? "";
  const chunks = buildChunks(compressed, model);

  if (chunks.length <= 1) {
    const response = await provider.summarize(
      SUMMARY_SYSTEM,
      buildSummaryPrompt(compressed),
    );
    return { response, mode: "single", chunks: 1 };
  }

  const concurrency = getChunkConcurrency();
  logger.info("Summarize chunking session", {
    sessionId,
    chunks: chunks.length,
    contextWindow: resolveContextWindow(model),
    model: model || "unknown",
    chunkSizes: chunks.map((c) => c.length),
    concurrency,
    totalObservations: compressed.length,
  });

  // Sparse array preserves chunk → index mapping after parallel resolution,
  // so the reduce step sees partials in chronological order even when some
  // were skipped.
  const partialByIdx: Array<SessionSummary | null> = new Array(chunks.length).fill(null);
  for (let batchStart = 0; batchStart < chunks.length; batchStart += concurrency) {
    const batch = chunks.slice(batchStart, batchStart + concurrency);
    await Promise.all(
      batch.map(async (chunk, j) => {
        const idx = batchStart + j;
        partialByIdx[idx] = await summarizeChunkWithRetry(
          provider,
          chunk,
          sessionId,
          project,
          idx,
          chunks.length,
        );
      }),
    );
  }

  const skipped = partialByIdx.filter((p) => p === null).length;

  if (skipped > Math.floor(chunks.length * MAX_SKIP_RATIO)) {
    throw new Error(
      `too_many_chunks_skipped: ${skipped}/${chunks.length} chunks failed to parse after retry`,
    );
  }
  if (skipped > 0) {
    logger.warn("Summarize chunks partially skipped", {
      sessionId,
      skipped,
      total: chunks.length,
    });
  }

  // Chunks are no longer uniform — they are packed to fill the context
  // window — so ranges are accumulated from the real chunk lengths rather
  // than multiplied out from a fixed size.
  const rangeStart: number[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    rangeStart.push(offset);
    offset += chunk.length;
  }

  const reduceInput = partialByIdx.flatMap((p, idx) =>
    p === null
      ? []
      : [
          {
            title: p.title,
            narrative: p.narrative,
            keyDecisions: p.keyDecisions,
            filesModified: p.filesModified,
            concepts: p.concepts,
            obsRangeStart: rangeStart[idx]! + 1,
            obsRangeEnd: rangeStart[idx]! + chunks[idx]!.length,
          },
        ],
  );
  const response = await provider.summarize(
    REDUCE_SYSTEM,
    buildReducePrompt(reduceInput),
  );
  return { response, mode: "chunked", chunks: chunks.length, skipped };
}

// #783: many LLMs (DeepSeek, GPT variants, some Anthropic responses)
// wrap structured XML in markdown code fences or add conversational
// text before/after. Strip those wrappers before the tag regex so a
// well-formed summary doesn't get silently dropped as parse_failed.
function stripXmlWrappers(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.trim();
  // ```xml ... ``` or ``` ... ``` fences (anywhere in the payload).
  cleaned = cleaned.replace(/```\s*xml\s*\n?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.trim();
  // If preamble / postamble surrounds the XML root, peel it off.
  const rootMatch = cleaned.match(
    /(<[a-zA-Z_][a-zA-Z0-9_-]*>[\s\S]*<\/[a-zA-Z_][a-zA-Z0-9_-]*>)/,
  );
  if (rootMatch && rootMatch[1]) return rootMatch[1].trim();
  return cleaned;
}

function parseSummaryXml(
  xml: string,
  sessionId: string,
  project: string,
  obsCount: number,
): SessionSummary | null {
  const cleaned = stripXmlWrappers(xml);
  const title = getXmlTag(cleaned, "title");
  if (!title) return null;

  return {
    sessionId,
    project,
    createdAt: new Date().toISOString(),
    title,
    narrative: getXmlTag(cleaned, "narrative"),
    keyDecisions: getXmlChildren(cleaned, "decisions", "decision"),
    filesModified: getXmlChildren(cleaned, "files", "file"),
    concepts: getXmlChildren(cleaned, "concepts", "concept"),
    observationCount: obsCount,
  };
}

export function registerSummarizeFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction("mem::summarize", 
    async (data: { sessionId: string } | undefined) => {
      const startMs = Date.now();
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();

      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        logger.warn("Session not found for summarize", {
          sessionId,
        });
        return { success: false, error: "session_not_found" };
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const compressed = observations.filter((o) => o.title);

      if (compressed.length === 0) {
        logger.info("No observations to summarize", {
          sessionId,
        });
        return { success: false, error: "no_observations" };
      }

      if (provider.name === "noop") {
        logger.info("Summarize skipped — no LLM provider configured", {
          sessionId,
        });
        return {
          success: false,
          error: "no_provider",
          reason:
            "No LLM provider key set; Summarize is a no-op. Set ANTHROPIC_API_KEY (or OPENAI/CLOUDFLARE/GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env to enable.",
        };
      }

      try {
        // #783: chunk-level produceSummaryXml retries internally, but
        // the final merge used to parse once and bail. Wrap the
        // produce-and-parse pair in the same 2-attempt loop so a
        // markdown-wrapped or otherwise wrapped response gets a
        // second roll-of-the-dice instead of dropping the summary.
        let summary: SessionSummary | null = null;
        let response = "";
        let mode = "single";
        let chunks = 1;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const produced = await produceSummaryXml(
            provider,
            compressed,
            sessionId,
            session.project,
          );
          response = produced.response;
          mode = produced.mode;
          chunks = produced.chunks;
          if (!response || !response.trim()) {
            logger.warn("Empty provider response on summarize", {
              sessionId,
              provider: provider.name,
              mode,
              chunks,
              observationCount: compressed.length,
              attempt,
            });
            continue;
          }
          summary = parseSummaryXml(
            response,
            sessionId,
            session.project,
            compressed.length,
          );
          if (summary) break;
          logger.warn("Failed to parse summary XML", { sessionId, attempt });
        }

        if (!response || !response.trim()) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return { success: false, error: "empty_provider_response" };
        }

        if (!summary) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return { success: false, error: "parse_failed" };
        }

        const summaryForValidation = {
          title: summary.title,
          narrative: summary.narrative,
          keyDecisions: summary.keyDecisions,
          filesModified: summary.filesModified,
          concepts: summary.concepts,
        };
        const validation = validateOutput(
          SummaryOutputSchema,
          summaryForValidation,
          "mem::summarize",
        );

        if (!validation.valid) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.warn("Summary validation failed", {
            sessionId,
            errors: validation.result.errors,
          });
          return { success: false, error: "validation_failed" };
        }

        const qualityScore = scoreSummary(summaryForValidation);

        await kv.set(KV.summaries, sessionId, summary);
        await safeAudit(kv, "compress", "mem::summarize", [sessionId], {
          title: summary.title,
          observationCount: compressed.length,
        });

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::summarize",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Session summarized", {
          sessionId,
          title: summary.title,
          decisions: summary.keyDecisions.length,
          qualityScore,
          valid: validation.valid,
        });

        return { success: true, summary, qualityScore };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::summarize", latencyMs, false);
        }
        logger.error("Summarize failed", {
          sessionId,
          error: msg,
        });
        return { success: false, error: msg };
      }
    },
  );
}
