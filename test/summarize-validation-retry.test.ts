import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: {
    sessions: "sessions",
    summaries: "summaries",
    observations: (sessionId: string) => `obs:${sessionId}`,
    audit: "audit",
  },
}));

vi.mock("../src/eval/schemas.js", () => ({
  SummaryOutputSchema: {},
}));

// The real rule, not an always-valid stub: SummaryOutputSchema requires
// `narrative` to be at least 20 characters. Every validation failure observed
// on the production daemon was this one field, so the regression is only
// meaningful against a validator that actually enforces it.
vi.mock("../src/eval/validator.js", () => ({
  validateOutput: (_schema: unknown, value: { narrative?: string }) =>
    (value.narrative ?? "").length >= 20
      ? { valid: true, result: { errors: [] } }
      : {
          valid: false,
          result: {
            errors: ["narrative: Too small: expected string to have >=20 characters"],
          },
        },
}));

vi.mock("../src/eval/quality.js", () => ({
  scoreSummary: () => 100,
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

import { registerSummarizeFunction } from "../src/functions/summarize.js";
import type {
  CompressedObservation,
  Session,
  MemoryProvider,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

function makeObs(i: number, sessionId: string): CompressedObservation {
  return {
    id: `obs_${i}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "conversation",
    title: `obs ${i}`,
    facts: [`fact ${i}`],
    narrative: `narrative for obs ${i}`,
    concepts: [],
    files: [`src/file_${i}.ts`],
    importance: 5,
  };
}

function makeProvider(responses: string[]): MemoryProvider & { calls: number } {
  let i = 0;
  const provider = {
    name: "test",
    calls: 0,
    compress: async () => "",
    summarize: async () => {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i += 1;
      provider.calls = i;
      return r;
    },
  };
  return provider;
}

/** `<narrative>` is the only field these cases vary. */
function summaryXml(title: string, narrative: string): string {
  return `<summary>
<title>${title}</title>
<narrative>${narrative}</narrative>
<decisions><decision>d1</decision></decisions>
<files><file>src/a.ts</file></files>
<concepts><concept>c1</concept></concepts>
</summary>`;
}

const THIN = "too short";
const FULL = "A narrative comfortably past the twenty character floor.";

async function setup(sessionId: string, provider: MemoryProvider) {
  const sdk = mockSdk();
  const kv = mockKV();
  const session: Session = {
    id: sessionId,
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: 4,
  };
  await kv.set("sessions", sessionId, session);
  for (let i = 0; i < 4; i++) {
    const o = makeObs(i, sessionId);
    await kv.set(`obs:${sessionId}`, o.id, o);
  }
  registerSummarizeFunction(sdk as any, kv as any, provider);
  return { handler: sdk.functions.get("mem::summarize")!, kv };
}

describe("mem::summarize validation retry", () => {
  it("retries a parsed-but-invalid summary and keeps the second attempt", async () => {
    // Both responses parse — each has a <title> — so the old loop broke on
    // attempt 1 and discarded the session. The retry must be driven by
    // validation, not by parseability.
    const provider = makeProvider([
      summaryXml("Thin narrative", THIN),
      summaryXml("Thin narrative", FULL),
    ]);
    const { handler, kv } = await setup("ses_retry", provider);

    const result = await handler({ sessionId: "ses_retry" });

    expect(result.success).toBe(true);
    expect(provider.calls).toBe(2);
    const stored = await kv.get<{ narrative: string }>("summaries", "ses_retry");
    expect(stored?.narrative).toBe(FULL);
  });

  it("still fails, and stores nothing, when both attempts are invalid", async () => {
    const provider = makeProvider([
      summaryXml("Thin narrative", THIN),
      summaryXml("Thin narrative", THIN),
    ]);
    const { handler, kv } = await setup("ses_both_bad", provider);

    const result = await handler({ sessionId: "ses_both_bad" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("validation_failed");
    expect(provider.calls).toBe(2);
    expect(await kv.get("summaries", "ses_both_bad")).toBeNull();
  });

  it("does not spend a second call when the first attempt validates", async () => {
    const provider = makeProvider([summaryXml("Good", FULL)]);
    const { handler } = await setup("ses_good", provider);

    const result = await handler({ sessionId: "ses_good" });

    expect(result.success).toBe(true);
    expect(provider.calls).toBe(1);
  });
});
