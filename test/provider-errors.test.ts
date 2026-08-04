import { describe, it, expect, beforeEach } from "vitest";
import {
  isContextOverflowError,
  isNonRetryableError,
  contextLimitFromError,
} from "../src/providers/provider-errors.js";
import {
  resolveContextWindow,
  noteContextLimit,
  resetLearnedContextLimits,
  promptCharBudget,
} from "../src/providers/context-windows.js";

// The real 413 the Cloudflare gateway returned for a 439-observation
// session summarised with llama-3.1-8b-instruct-fp8 (32k window).
const REAL_413 =
  'Cloudflare API error (413): {"name":"AiError","internalCode":5021,' +
  '"httpCode":413,"message":"AiError: Ai: The estimated number of input and ' +
  'maximum output tokens (42481) exceeded this model context window limit ' +
  '(32000). (87064f8a)","description":"The estimated number of input and ' +
  'maximum output tokens (42481) exceeded this model context window limit (32000)."}';

const REAL_429 =
  'Cloudflare API error (429): {"name":"AiGatewayError","internalCode":2003,' +
  '"message":"Too many requests"}';

describe("provider error classification", () => {
  it("recognises a real Cloudflare context overflow", () => {
    const err = new Error(REAL_413);
    expect(isContextOverflowError(err)).toBe(true);
    expect(isNonRetryableError(err)).toBe(true);
  });

  it("extracts the enforced limit from the 413", () => {
    expect(contextLimitFromError(new Error(REAL_413))).toBe(32000);
  });

  it("recognises OpenAI-style context overflow prose", () => {
    const err = new Error(
      "This model's maximum context length is 8192 tokens, however you requested 9000",
    );
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("reads a numeric status field when the provider sets one", () => {
    expect(isNonRetryableError({ status: 413 })).toBe(true);
    expect(isNonRetryableError({ statusCode: 401 })).toBe(true);
  });

  // The whole point of the split: a 429 is transient, so it must stay
  // retryable AND keep counting toward the circuit breaker. Misclassifying
  // it here would mean a genuinely overloaded provider never trips the
  // breaker at all.
  it("does NOT treat rate limits as non-retryable", () => {
    const err = new Error(REAL_429);
    expect(isContextOverflowError(err)).toBe(false);
    expect(isNonRetryableError(err)).toBe(false);
  });

  it("does not treat 5xx or network errors as non-retryable", () => {
    expect(isNonRetryableError(new Error("Cloudflare API error (500): oops"))).toBe(false);
    expect(isNonRetryableError(new Error("This operation was aborted"))).toBe(false);
    expect(isNonRetryableError(new Error("fetch failed"))).toBe(false);
  });

  it("is not fooled by a token count containing a status-like number", () => {
    // "413" appears as part of a token count, not as a status.
    const err = new Error("Cloudflare API error (500): used 41300 tokens");
    expect(isNonRetryableError(err)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isNonRetryableError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
  });
});

describe("context windows", () => {
  beforeEach(() => {
    resetLearnedContextLimits();
    delete process.env["AGENTMEMORY_CONTEXT_WINDOW"];
  });

  it("resolves the window that caused the outage", () => {
    expect(
      resolveContextWindow("workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8"),
    ).toBe(32_000);
  });

  it("resolves DeepSeek V4 Flash's million-token window", () => {
    expect(resolveContextWindow("deepseek/deepseek-v4-flash")).toBe(1_048_576);
  });

  it("prefers the longest matching key", () => {
    // "llama-3.2-3b-instruct" must not be shadowed by a shorter substring.
    expect(resolveContextWindow("workers-ai/@cf/meta/llama-3.2-3b-instruct")).toBe(80_000);
  });

  it("falls back conservatively for an unknown model", () => {
    expect(resolveContextWindow("some/model-nobody-has-heard-of")).toBe(32_000);
  });

  it("honours an explicit env override above everything", () => {
    process.env["AGENTMEMORY_CONTEXT_WINDOW"] = "12345";
    expect(resolveContextWindow("deepseek/deepseek-v4-flash")).toBe(12345);
  });

  it("prefers a limit learned from a real 413 over the table", () => {
    const model = "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8";
    noteContextLimit(model, 16_000);
    expect(resolveContextWindow(model)).toBe(16_000);
  });

  it("reserves the output budget out of the window", () => {
    const small = promptCharBudget("@cf/meta/llama-3.1-8b-instruct-fp8", 4096);
    const large = promptCharBudget("deepseek-v4-flash", 4096);
    expect(large).toBeGreaterThan(small * 20);
    // A 32k window minus 4k output must not yield a budget that implies
    // more than 32k tokens of prompt.
    expect(small / 3.2).toBeLessThan(32_000);
  });

  it("never returns a non-positive budget even if output exceeds the window", () => {
    expect(promptCharBudget("@cf/google/gemma-7b-it-lora", 100_000)).toBeGreaterThan(0);
  });
});
