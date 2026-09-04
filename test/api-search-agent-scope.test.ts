/**
 * `/agentmemory/smart-search` dropped the `?agentId=` query parameter that
 * `/agentmemory/search` honoured. Two failures came out of the one omission:
 *
 *  - a silent scope leak: `?agentId=X` returned cross-agent rows because the
 *    caller's isolation filter never reached `mem::smart-search`;
 *  - an opaque 5xx: under `AGENTMEMORY_AGENT_SCOPE=isolated` the missing id
 *    tripped the fail-closed refusal, which escaped the handler uncaught while
 *    plain search kept working — the reported "smart-search 5xx" symptom.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";

type Handler = (req: unknown) => Promise<{ status_code: number; body: unknown }>;

/**
 * Captures the registered handlers and records what each one forwards to
 * `sdk.trigger`, so a test can assert on the payload the endpoint built.
 */
function harness(triggerImpl?: (call: { function_id: string; payload?: unknown }) => unknown) {
  const handlers = new Map<string, Handler>();
  const triggered: Array<{ function_id: string; payload?: unknown }> = [];
  const sdk = {
    registerFunction: (id: string, fn: Handler) => void handlers.set(id, fn),
    registerTrigger: () => {},
    trigger: async (call: { function_id: string; payload?: unknown }) => {
      triggered.push(call);
      return triggerImpl ? triggerImpl(call) : { mode: "compact", results: [] };
    },
  };
  const kv = {
    get: async () => null,
    set: async <T>(_s: string, _k: string, d: T) => d,
    delete: async () => {},
    list: async () => [],
  };
  registerApiTriggers(sdk as never, kv as never);
  return { handlers, triggered };
}

const body = { query: "auth", limit: 5 };

describe("agentId reaches both search endpoints the same way", () => {
  for (const [label, fn, id] of [
    ["search", "api::search", "mem::search"],
    ["smart-search", "api::smart-search", "mem::smart-search"],
  ] as const) {
    it(`${label} forwards ?agentId= from the query string`, async () => {
      const { handlers, triggered } = harness();
      await handlers.get(fn)!({ body, query_params: { agentId: "agent-a" } });
      expect(triggered[0]!.function_id).toBe(id);
      expect((triggered[0]!.payload as { agentId?: string }).agentId).toBe("agent-a");
    });

    it(`${label} lets the body win over the query string`, async () => {
      const { handlers, triggered } = harness();
      await handlers.get(fn)!({
        body: { ...body, agentId: "from-body" },
        query_params: { agentId: "from-query" },
      });
      expect((triggered[0]!.payload as { agentId?: string }).agentId).toBe("from-body");
    });
  }
});

describe("the fail-closed agent-scope refusal is legible, not a bare 5xx", () => {
  const refusal = () => {
    throw new Error(
      "mem::smart-search: AGENTMEMORY_AGENT_SCOPE=isolated is set but no " +
        "agent id is available. Refusing to read cross-agent rows.",
    );
  };

  it("smart-search answers 400 and names the cause", async () => {
    const { handlers } = harness(refusal);
    const res = await handlers.get("api::smart-search")!({ body });
    expect(res.status_code).toBe(400);
    expect((res.body as { error: string }).error).toContain("isolated");
  });

  it("search answers 400 too — the endpoints must not disagree", async () => {
    const { handlers } = harness(refusal);
    const res = await handlers.get("api::search")!({ body });
    expect(res.status_code).toBe(400);
  });

  it("still lets a genuine server fault escape as a fault", async () => {
    // A blanket catch here would have hidden exactly the class of bug this
    // endpoint already hid once, so only the scope refusal may be converted.
    const { handlers } = harness(() => {
      throw new Error("upstream index unavailable");
    });
    await expect(
      handlers.get("api::smart-search")!({ body }),
    ).rejects.toThrow("upstream index unavailable");
  });
});
