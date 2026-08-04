import { getEnvVar } from "../config.js";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the provider";
  }
}

export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
  /**
   * Env var to name in the timeout message, e.g. "CLOUDFLARE_TIMEOUT_MS".
   * Defaults to the global knob.
   */
  timeoutHint?: string,
): Promise<Response> {
  const parsed =
    timeoutMs ??
    Number.parseInt(getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS") ?? "60000", 10);
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;

  const ctl = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, ctl.signal])
    : ctl.signal;
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal })
    .catch((err: unknown) => {
      // A raw AbortError reaches the caller as "This operation was aborted",
      // which names neither the timeout, its duration, nor the knob to change
      // — it surfaced in daemon logs as an unactionable graph-extraction
      // failure. This is the only layer that knows the bound actually fired,
      // so translate here rather than in each provider's catch.
      //
      // Gated on OUR controller: when the caller passed its own signal and
      // that is what aborted, the rejection is the caller's business and
      // passes through untouched.
      if (ctl.signal.aborted) {
        const knob = timeoutHint ?? "AGENTMEMORY_LLM_TIMEOUT_MS";
        throw new Error(
          `Request to ${hostOf(url)} timed out after ${ms}ms — set ${knob} ` +
            `to raise the bound or check the provider status.`,
        );
      }
      throw err;
    })
    .finally(() => clearTimeout(t));
}
