import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildCompressionPrompt,
  compressionBudget,
} from "../src/prompts/compression.js";
import { promptCharBudget } from "../src/providers/context-windows.js";

const ORIGINAL = { ...process.env };

describe("compression prompt budget", () => {
  beforeEach(() => {
    delete process.env["AGENTMEMORY_COMPRESS_MAX_CHARS"];
    delete process.env["AGENTMEMORY_CONTEXT_WINDOW"];
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("defaults to the legacy 4k/4k/2k limits when given no budget", () => {
    expect(compressionBudget()).toEqual({
      input: 4_000,
      output: 4_000,
      userPrompt: 2_000,
    });
  });

  // The real defect: compression truncated tool output at 4 KB regardless of
  // the model, so a 128k-window model saw the first page of a 60 KB command
  // result and everything after it was gone from memory permanently.
  it("grows the limits when the model has room", () => {
    const b = compressionBudget(promptCharBudget("deepseek-v4-flash", 8192));
    expect(b.output).toBeGreaterThan(40_000);
    expect(b.input).toBeGreaterThan(30_000);
  });

  it("never shrinks below the legacy limits on a tiny window", () => {
    const b = compressionBudget(promptCharBudget("@cf/google/gemma-7b-it-lora", 8192));
    expect(b.input).toBeGreaterThanOrEqual(4_000);
    expect(b.output).toBeGreaterThanOrEqual(4_000);
    expect(b.userPrompt).toBeGreaterThanOrEqual(2_000);
  });

  // A 1M window says what fits, not what is worth paying for. Compression is
  // the highest-volume call in the system, so the budget is capped
  // independently of the window.
  it("caps the budget well below a million-token window", () => {
    const b = compressionBudget(promptCharBudget("deepseek-v4-flash", 8192));
    expect(b.input + b.output + b.userPrompt).toBeLessThanOrEqual(100_000);
  });

  it("honours AGENTMEMORY_COMPRESS_MAX_CHARS", () => {
    process.env["AGENTMEMORY_COMPRESS_MAX_CHARS"] = "20000";
    const b = compressionBudget(promptCharBudget("deepseek-v4-flash", 8192));
    expect(b.input + b.output + b.userPrompt).toBeLessThanOrEqual(20_000);
  });

  it("actually truncates at the budget it was given", () => {
    // 40k fits the capped output share (45% of 100k) but is 10x the legacy
    // 4k limit — so it survives whole under the new budget and is cut under
    // the old one. That difference is the entire point of the change.
    const big = "x".repeat(40_000);
    const legacy = buildCompressionPrompt({
      hookType: "PostToolUse",
      toolName: "Bash",
      toolOutput: big,
      timestamp: "2026-08-02T00:00:00Z",
    });
    expect(legacy).toContain("[...truncated]");
    expect(legacy.length).toBeLessThan(6_000);

    const roomy = buildCompressionPrompt(
      {
        hookType: "PostToolUse",
        toolName: "Bash",
        toolOutput: big,
        timestamp: "2026-08-02T00:00:00Z",
      },
      compressionBudget(promptCharBudget("deepseek-v4-flash", 8192)),
    );
    expect(roomy).not.toContain("[...truncated]");
    expect(roomy.length).toBeGreaterThan(40_000);
  });
});
