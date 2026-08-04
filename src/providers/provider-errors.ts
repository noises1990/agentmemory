/**
 * Classification of provider errors by whether retrying can possibly help.
 *
 * Why this exists: `ResilientProvider` used to treat every thrown error as
 * evidence the provider was unwell, and `summarizeChunkWithRetry` used to
 * retry every failure once. Both are right for a timeout or a 5xx. Both are
 * actively harmful for a context-window overflow.
 *
 * A 413 is a property of the *payload*, not the provider. The second attempt
 * sends the identical oversized prompt and fails identically, and each of
 * those failures feeds the circuit breaker. Three oversized summary chunks
 * were enough to open a breaker shared with compression, so a sizing bug in
 * one code path took down a healthy one — compress calls, one observation
 * each, started failing with `circuit_breaker_open`.
 *
 * Rate limits are deliberately NOT in this set: a 429 is transient, retrying
 * is reasonable, and it genuinely does indicate the provider is refusing
 * work, so it should still count toward the breaker.
 */

/** HTTP statuses where an identical retry cannot succeed. */
const NON_RETRYABLE_STATUSES = [400, 401, 403, 404, 413, 422];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusOf(err: unknown): number | null {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  // Providers that build the message by hand — the Cloudflare provider
  // throws `Cloudflare API error (413): {...}` — carry the status only in
  // the text. Anchored on the parenthesised form so a token count that
  // happens to contain "413" cannot be mistaken for a status.
  const parenthesised = /API error \((\d{3})\)/.exec(messageOf(err));
  return parenthesised ? Number(parenthesised[1]) : null;
}

/**
 * True when the request exceeded the model's context window.
 *
 * Cloudflare reports this as HTTP 413 with `internalCode: 5021` and a
 * message naming both the estimate and the limit. Other providers use 400
 * with prose, so the text patterns are checked independently of status.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (!err) return false;
  const message = messageOf(err);
  if (/\binternalCode"?\s*:\s*5021\b/.test(message)) return true;
  if (/context (window|length) limit/i.test(message)) return true;
  if (/exceeded this model context window/i.test(message)) return true;
  if (/maximum context length/i.test(message)) return true;
  if (/context_length_exceeded|string_above_max_length/i.test(message)) return true;
  return statusOf(err) === 413;
}

/**
 * True when retrying the identical request cannot succeed, so the caller
 * should give up immediately and the breaker should not count it.
 */
export function isNonRetryableError(err: unknown): boolean {
  if (!err) return false;
  if (isContextOverflowError(err)) return true;
  const status = statusOf(err);
  return status !== null && NON_RETRYABLE_STATUSES.includes(status);
}

/**
 * Extract the model's real context window from an overflow error.
 *
 * The provider tells us the exact limit it enforced, which beats any table
 * we could ship: it reflects the deployment, not the model card. Used to
 * correct the configured window at runtime after the first overflow.
 */
export function contextLimitFromError(err: unknown): number | null {
  const m = /context window limit \(?(\d[\d,]*)\)?/i.exec(messageOf(err));
  if (!m || !m[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
