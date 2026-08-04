import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveReasoningEffort } from "../src/providers/cloudflare.js";

// ─────────────────────────────────────────────────────────────
// Reasoning effort on the Cloudflare provider.
//
// `thinking: disabled` is DeepSeek-shaped and gpt-oss ignores it, so gpt-oss
// kept reasoning by default and spent the whole 8192-token output budget
// thinking — returning content:"" with finish_reason:"length". It reads
// reasoning_effort instead.
// ─────────────────────────────────────────────────────────────

describe("resolveReasoningEffort", () => {
  beforeEach(() => {
    delete process.env["CLOUDFLARE_REASONING_EFFORT"];
  });
  afterEach(() => {
    delete process.env["CLOUDFLARE_REASONING_EFFORT"];
  });

  it("defaults to low so reasoning cannot eat the output budget", () => {
    expect(resolveReasoningEffort()).toBe("low");
  });

  it("honours an explicit medium or high", () => {
    process.env["CLOUDFLARE_REASONING_EFFORT"] = "high";
    expect(resolveReasoningEffort()).toBe("high");
    process.env["CLOUDFLARE_REASONING_EFFORT"] = "medium";
    expect(resolveReasoningEffort()).toBe("medium");
  });

  it("falls back to low on an unrecognised value", () => {
    process.env["CLOUDFLARE_REASONING_EFFORT"] = "maximum";
    expect(resolveReasoningEffort()).toBe("low");
  });

  it("is case and whitespace insensitive", () => {
    process.env["CLOUDFLARE_REASONING_EFFORT"] = "  HIGH  ";
    expect(resolveReasoningEffort()).toBe("high");
  });
});

// ─────────────────────────────────────────────────────────────
// Session-end graph extraction batching.
//
// The live path passed every observation in the session to one call.
// Measured on a real 500-observation session: 417,500 prompt characters,
// ~130k tokens against a 128k window — the input alone did not fit — while
// asking for 2,281 entities in a single response. Both the timeouts and the
// finish_reason=length truncations in the logs trace back to this.
// ─────────────────────────────────────────────────────────────

function makeObs(i: number) {
  return {
    id: `obs_${i}`,
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: `Edit file ${i}`,
    narrative: "n",
    concepts: ["c"],
    files: [`src/f${i}.ts`],
    importance: 5,
  };
}

/**
 * Mirrors the slice loop in events.ts.
 *
 * Note this is a reimplementation, not the real handler: that loop is inline
 * in an sdk trigger and reaching it needs the whole event plumbing. So these
 * cases pin the chunking arithmetic and the prompt-size claim, not the wiring
 * — if the call site regresses to passing the session whole, this stays green.
 * The wiring is covered by reading events.ts, and by the batch counts in the
 * daemon log after a session ends.
 */
async function runBatches(
  observations: unknown[],
  batchSize: number,
  trigger: (payload: { observations: unknown[] }) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < observations.length; i += batchSize) {
    await trigger({ observations: observations.slice(i, i + batchSize) });
  }
}

describe("session-end graph extraction batching", () => {
  it("splits a large session into bounded calls instead of one", async () => {
    const obs = Array.from({ length: 500 }, (_, i) => makeObs(i));
    const calls: number[] = [];
    await runBatches(obs, 10, async (p) => {
      calls.push(p.observations.length);
    });

    expect(calls).toHaveLength(50);
    expect(Math.max(...calls)).toBe(10);
    // Every observation reaches the extractor exactly once.
    expect(calls.reduce((a, b) => a + b, 0)).toBe(500);
  });

  it("handles a final short batch", async () => {
    const obs = Array.from({ length: 25 }, (_, i) => makeObs(i));
    const calls: number[] = [];
    await runBatches(obs, 10, async (p) => {
      calls.push(p.observations.length);
    });

    expect(calls).toEqual([10, 10, 5]);
  });

  it("keeps a batch's prompt far inside the context window", () => {
    // The check that actually matters: reproduce buildGraphExtractionPrompt's
    // shape and confirm a batch is nowhere near the 128k-token window that a
    // whole session blew through at 101.9%.
    const batch = Array.from({ length: 10 }, (_, i) => makeObs(i));
    const items = batch
      .map(
        (o, i) =>
          `[${i + 1}] Type: ${o.type}\nTitle: ${o.title}\nNarrative: ${o.narrative}\nConcepts: ${o.concepts.join(", ")}\nFiles: ${o.files.join(", ")}`,
      )
      .join("\n\n");
    const prompt = `Extract entities and relationships from these observations:\n\n${items}`;
    const estTokens = prompt.length / 3.2;

    expect(estTokens).toBeLessThan(128_000 * 0.1);
  });

  it("does not drop observations when the batch size exceeds the session", async () => {
    const obs = Array.from({ length: 3 }, (_, i) => makeObs(i));
    const calls: number[] = [];
    await runBatches(obs, 10, async (p) => {
      calls.push(p.observations.length);
    });

    expect(calls).toEqual([3]);
  });
});
