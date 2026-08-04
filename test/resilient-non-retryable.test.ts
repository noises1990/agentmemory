import { describe, it, expect, beforeEach } from "vitest";
import { ResilientProvider } from "../src/providers/resilient.js";
import {
  resolveContextWindow,
  resetLearnedContextLimits,
} from "../src/providers/context-windows.js";
import { resetRateLimitStats } from "../src/providers/rate-limit-monitor.js";
import type { MemoryProvider } from "../src/types.js";

const OVERFLOW_413 =
  'Cloudflare API error (413): {"internalCode":5021,"message":"The estimated ' +
  "number of input and maximum output tokens (49534) exceeded this model " +
  'context window limit (32000)."}';

function throwingProvider(model: string, err: () => never): MemoryProvider {
  return {
    name: "stub",
    model,
    compress: async () => err(),
    summarize: async () => err(),
  };
}

describe("ResilientProvider circuit breaker", () => {
  beforeEach(() => {
    resetLearnedContextLimits();
    resetRateLimitStats();
  });

  // The amplification that made a sizing bug look like an outage. The
  // breaker opens after 3 failures in 60s and is shared across the
  // provider, so three oversized summary chunks took compression down with
  // them — one-observation calls that had nothing wrong with them started
  // failing with circuit_breaker_open.
  it("stays closed after repeated context-overflow rejections", async () => {
    const p = new ResilientProvider(
      throwingProvider("m", () => {
        throw new Error(OVERFLOW_413);
      }),
    );

    for (let i = 0; i < 5; i++) {
      await expect(p.summarize("s", "u")).rejects.toThrow(/413/);
    }

    expect(p.circuitState.state).toBe("closed");
    expect(p.circuitState.failures).toBe(0);
  });

  it("still opens on genuine provider failures", async () => {
    const p = new ResilientProvider(
      throwingProvider("m", () => {
        throw new Error("Cloudflare API error (500): upstream down");
      }),
    );

    for (let i = 0; i < 3; i++) {
      await expect(p.summarize("s", "u")).rejects.toThrow();
    }
    expect(p.circuitState.state).toBe("open");
  });

  // A 429 means the provider really is refusing work, so it must still
  // count — the breaker is exactly the right response to being throttled.
  it("still opens on rate limits", async () => {
    const p = new ResilientProvider(
      throwingProvider("m", () => {
        throw new Error('Cloudflare API error (429): {"name":"AiGatewayError"}');
      }),
    );

    for (let i = 0; i < 3; i++) {
      await expect(p.compress("s", "u")).rejects.toThrow();
    }
    expect(p.circuitState.state).toBe("open");
  });

  it("learns the real context limit from the rejection", async () => {
    const model = "some-model-not-in-the-table";
    expect(resolveContextWindow(model)).toBe(32_000); // fallback

    const p = new ResilientProvider(
      throwingProvider(model, () => {
        throw new Error(OVERFLOW_413);
      }),
    );
    await expect(p.summarize("s", "u")).rejects.toThrow();

    // The provider told us what it actually enforces; believe it.
    expect(resolveContextWindow(model)).toBe(32_000);
  });

  it("exposes the wrapped provider's model", () => {
    const p = new ResilientProvider(throwingProvider("deepseek/deepseek-v4-flash", () => {
      throw new Error("x");
    }));
    expect(p.model).toBe("deepseek/deepseek-v4-flash");
  });
});
