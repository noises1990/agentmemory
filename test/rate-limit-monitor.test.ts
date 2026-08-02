import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isRateLimitError,
  rateLimitScope,
  recordProviderCall,
  getRateLimitStats,
  resetRateLimitStats,
} from "../src/providers/rate-limit-monitor.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// A rate limit does not reduce spend, it converts spend into failures --
// and agentmemory swallows those failures by design (synthetic compression
// fallback, soft-failing vector adds). Without this counter the only
// symptom is that recall slowly gets worse, with nothing anywhere saying
// why.

describe("isRateLimitError", () => {
  beforeEach(() => resetRateLimitStats());

  it("recognises the shape the Cloudflare provider actually throws", () => {
    const err = new Error(
      'Cloudflare API error (429): {"success":false,"error":[{"code":2003,' +
        '"message":"Rate limited"}],"name":"AiGatewayError","httpCode":429}',
    );
    expect(isRateLimitError(err)).toBe(true);
  });

  it("recognises a numeric status field", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it("recognises a prose rate-limit message without a status code", () => {
    expect(isRateLimitError(new Error("Too many requests: rate limited"))).toBe(
      true,
    );
    expect(isRateLimitError(new Error("rate-limit exceeded"))).toBe(true);
  });

  it("does not fire on unrelated failures", () => {
    expect(isRateLimitError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isRateLimitError(new Error("API error (500): server blew up"))).toBe(
      false,
    );
    expect(isRateLimitError(new Error("circuit_breaker_open"))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });

  it("does not match a 429 embedded in a longer number", () => {
    expect(isRateLimitError(new Error("processed 4290 records"))).toBe(false);
  });
});

describe("rateLimitScope", () => {
  // Telling someone to "raise the limit" when the limit is an account
  // quota sends them hunting for a setting that does not exist.
  it("attributes an AI Gateway rule to the gateway", () => {
    const err = new Error('429 {"name":"AiGatewayError","internalCode":2003}');
    expect(rateLimitScope(err)).toBe("gateway");
  });

  it("attributes anything else to the upstream provider", () => {
    expect(rateLimitScope(new Error("429 Too Many Requests"))).toBe("provider");
  });
});

describe("rate limit stats", () => {
  beforeEach(() => resetRateLimitStats());

  const limitErr = () =>
    new Error('Cloudflare API error (429): {"name":"AiGatewayError"}');

  it("stays silent when nothing has been rejected", () => {
    recordProviderCall();
    recordProviderCall();
    const stats = getRateLimitStats();
    expect(stats.limited).toBe(0);
    expect(stats.ratio).toBe(0);
    expect(stats.lastLimitedAt).toBeNull();
    expect(stats.scope).toBeNull();
  });

  it("counts rejections and reports the scope", () => {
    recordProviderCall();
    recordProviderCall(limitErr());
    const stats = getRateLimitStats();
    expect(stats.limited).toBe(1);
    expect(stats.scope).toBe("gateway");
    expect(stats.lastLimitedAt).toBeGreaterThan(0);
  });

  it("ignores failures that are not rate limits", () => {
    recordProviderCall(new Error("ECONNREFUSED"));
    recordProviderCall(new Error("circuit_breaker_open"));
    expect(getRateLimitStats().limited).toBe(0);
  });

  it("reports a ratio that reflects how much traffic is being rejected", () => {
    for (let i = 0; i < 3; i++) recordProviderCall();
    recordProviderCall(limitErr());
    const stats = getRateLimitStats();
    expect(stats.calls).toBe(4);
    expect(stats.ratio).toBeCloseTo(0.25, 5);
  });

  it("never reports a ratio above 1", () => {
    recordProviderCall(limitErr());
    recordProviderCall(limitErr());
    expect(getRateLimitStats().ratio).toBeLessThanOrEqual(1);
  });

  it("resets cleanly between runs", () => {
    recordProviderCall(limitErr());
    resetRateLimitStats();
    const stats = getRateLimitStats();
    expect(stats.limited).toBe(0);
    expect(stats.calls).toBe(0);
  });
});
