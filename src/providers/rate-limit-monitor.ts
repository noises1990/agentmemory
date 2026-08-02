import { logger } from "../logger.js";

/**
 * Rolling record of provider rate-limit (HTTP 429) responses.
 *
 * Why this exists: a rate limit does not reduce spend, it converts spend
 * into failures — and agentmemory's failures are mostly silent by design.
 * Compression falls back to a synthetic summary, and
 * `vectorIndexAddGuarded` soft-fails so a downed embedder cannot break the
 * save path. The result is an install that looks healthy while quietly
 * losing summary quality and vector coverage.
 *
 * Worse, the damage is not proportional. A handful of 429s trips the
 * circuit breaker, which then fails EVERY provider call — including graph
 * extraction and session summaries — until it recovers. Being slightly
 * over the limit costs far more than "slightly".
 *
 * So: count them, and make `diagnose` and `doctor` say so out loud.
 */

/** How far back the counters look. */
const WINDOW_MS = 15 * 60 * 1000;

/** Hard cap on retained timestamps, so a sustained storm can't grow memory. */
const MAX_EVENTS = 2000;

export type RateLimitScope = "gateway" | "provider";

type Event = { at: number; scope: RateLimitScope };

let events: Event[] = [];
let totalCalls = 0;

export interface RateLimitStats {
  /** 429s seen inside the window. */
  limited: number;
  /** Provider calls seen inside the window (successes + failures). */
  calls: number;
  /** Fraction of calls rejected, 0 when no calls were made. */
  ratio: number;
  /** Epoch ms of the most recent 429, or null. */
  lastLimitedAt: number | null;
  /**
   * Where the limit came from, when we can tell. "gateway" means a rule
   * on the caller's own AI Gateway — something they can raise or remove.
   * "provider" means the upstream account quota, which they cannot.
   */
  scope: RateLimitScope | null;
  windowMs: number;
}

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  if (events.length && events[0]!.at >= cutoff) return;
  events = events.filter((e) => e.at >= cutoff);
}

/**
 * True when an error represents an upstream rate-limit rejection.
 *
 * Providers surface this differently — a `status`/`statusCode` field, or
 * a message the provider built by hand (the Cloudflare provider throws
 * `Cloudflare API error (429): {...}`) — so both shapes are checked.
 * The bare-429 match is anchored to avoid matching an unrelated 4290.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "object") {
    const status = (err as { status?: unknown; statusCode?: unknown });
    if (status.status === 429 || status.statusCode === 429) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/\b429\b/.test(message)) return true;
  return /\brate[ _-]?limit(ed|ing)?\b/i.test(message);
}

/**
 * Distinguish a limit the operator controls from one they don't.
 *
 * Cloudflare's AI Gateway returns `"name":"AiGatewayError"` with internal
 * code 2003 for a rule configured on the gateway itself. That is a dial in
 * the dashboard. An account-level Workers AI quota is not, and telling
 * someone to "raise the limit" in that case sends them looking for a
 * setting that does not exist.
 */
export function rateLimitScope(err: unknown): RateLimitScope {
  const message = err instanceof Error ? err.message : String(err);
  return /AiGatewayError|ai[ -]?gateway/i.test(message) ? "gateway" : "provider";
}

/** Minimum gap between log warnings, so a storm doesn't flood the log. */
const LOG_THROTTLE_MS = 5 * 60 * 1000;
let lastWarnedAt = 0;

/** Record one provider call and whether it was rate-limited. */
export function recordProviderCall(err?: unknown): void {
  const now = Date.now();
  prune(now);
  totalCalls += 1;
  if (err === undefined || !isRateLimitError(err)) return;

  const scope = rateLimitScope(err);
  if (events.length >= MAX_EVENTS) events.shift();
  events.push({ at: now, scope });

  // One line when it starts, then at most one every 5 minutes. Without
  // the throttle a sustained storm writes a line per dropped embedding.
  if (now - lastWarnedAt < LOG_THROTTLE_MS) return;
  lastWarnedAt = now;
  logger.warn("provider rate-limited (HTTP 429)", {
    inLastMinutes: Math.round(WINDOW_MS / 60_000),
    rejected: events.length,
    scope,
    action:
      scope === "gateway"
        ? "Raise or remove the request limit on your AI Gateway — this is your own rule, not an account quota."
        : "Upstream account quota — reduce request volume or raise the plan limit.",
    impact:
      "Compression falls back to synthetic summaries and embeddings are dropped, degrading semantic recall.",
  });
}

export function getRateLimitStats(): RateLimitStats {
  const now = Date.now();
  prune(now);
  const limited = events.length;
  // totalCalls is a lifetime counter; the ratio is only meaningful against
  // it when nothing has been pruned, so report the conservative view:
  // limited events over calls, clamped to 1.
  const calls = Math.max(totalCalls, limited);
  return {
    limited,
    calls,
    ratio: calls > 0 ? Math.min(1, limited / calls) : 0,
    lastLimitedAt: limited > 0 ? events[events.length - 1]!.at : null,
    scope: limited > 0 ? events[events.length - 1]!.scope : null,
    windowMs: WINDOW_MS,
  };
}

/** Test seam. */
export function resetRateLimitStats(): void {
  events = [];
  totalCalls = 0;
  lastWarnedAt = 0;
}
