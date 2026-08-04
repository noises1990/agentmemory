import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { recordProviderCall } from "./rate-limit-monitor.js";
import { isNonRetryableError, contextLimitFromError } from "./provider-errors.js";
import { noteContextLimit } from "./context-windows.js";

export class ResilientProvider implements MemoryProvider {
  private breaker = new CircuitBreaker();
  name: string;

  constructor(private inner: MemoryProvider) {
    this.name = `resilient(${inner.name})`;
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  private async call(fn: () => Promise<string>): Promise<string> {
    if (!this.breaker.isAllowed) {
      throw new Error("circuit_breaker_open");
    }
    try {
      const result = await fn();
      this.breaker.recordSuccess();
      recordProviderCall();
      return result;
    } catch (err) {
      // A breaker exists to stop hammering a provider that is unwell. A
      // rejected *payload* — 413 context overflow, 400 malformed — says
      // nothing about the provider's health, and counting it here let a
      // sizing bug in summarize open a breaker shared with compression:
      // three oversized chunks, and one-observation compress calls that
      // would have succeeded started failing with circuit_breaker_open.
      if (!isNonRetryableError(err)) {
        this.breaker.recordFailure();
      } else {
        // The 413 names the limit the deployment actually enforces, which
        // beats any table we ship. Remember it so the next chunking pass
        // sizes against the real number.
        const limit = contextLimitFromError(err);
        if (limit !== null && this.inner.model) {
          noteContextLimit(this.inner.model, limit);
        }
      }
      // Recorded before rethrowing: callers above this point swallow the
      // error (compression falls back to a synthetic summary), so this is
      // the last place a 429 is still distinguishable from any other
      // failure.
      recordProviderCall(err);
      throw err;
    }
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.compress(systemPrompt, userPrompt));
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.summarize(systemPrompt, userPrompt));
  }

  get circuitState(): CircuitBreakerState {
    return this.breaker.getState();
  }
}
