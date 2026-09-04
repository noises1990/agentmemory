/**
 * A 401 from a *localhost* daemon used to take the "no daemon yet" local-KV
 * path, so an authentication failure was reported to the agent as an empty
 * memory. That is how an unset AGENTMEMORY_SECRET read as "no memories"
 * estate-wide instead of as a broken credential: the daemon was healthy and
 * held 1832 observations the whole time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../src/mcp/transport.js", () => ({
  createStdioTransport: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock("../src/config.js", () => ({
  getStandalonePersistPath: vi.fn(() => "/tmp/test-auth-nofallback.json"),
}));

import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { handleToolCall } from "../src/mcp/standalone.js";
import { resetHandleForTests, setLivezProbe } from "../src/mcp/rest-proxy.js";

const originalFetch = globalThis.fetch;
const originalUrl = process.env["AGENTMEMORY_URL"];

/** Localhost: the only configuration where the local-KV path is allowed. */
function useLocalhost() {
  process.env["AGENTMEMORY_URL"] = "http://localhost:3111";
}

/** Probe succeeds, so the shim enters proxy mode and the CALL is what fails. */
function respondWith(status: number, statusText: string) {
  setLivezProbe(vi.fn(async () => ({ ok: true })));
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ error: statusText.toLowerCase() }), {
      status,
      statusText,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("an auth failure is never reported as an empty memory", () => {
  beforeEach(() => {
    resetHandleForTests();
    useLocalhost();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env["AGENTMEMORY_URL"];
    else process.env["AGENTMEMORY_URL"] = originalUrl;
    resetHandleForTests();
  });

  for (const [status, text] of [[401, "Unauthorized"], [403, "Forbidden"]] as const) {
    it(`throws on ${status} from localhost rather than answering []`, async () => {
      respondWith(status, text);
      const kv = new InMemoryKV();
      const call = handleToolCall("memory_recall", { query: "auth" }, kv);
      await expect(call).rejects.toThrow(/refused by the agentmemory server/);
      // The specific regression: a resolved promise carrying an empty result
      // set is exactly what made this invisible for a month.
      await expect(call).rejects.toThrow(/AGENTMEMORY_SECRET/);
    });
  }

  it("still takes the local path when the daemon is simply not there", async () => {
    // The documented zero-config case must keep working: a connection error is
    // "no daemon yet", not a refusal, so blocking it would break first-run.
    setLivezProbe(vi.fn(async () => ({ ok: false, reason: "connect ECONNREFUSED" })));
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3111");
    }) as unknown as typeof fetch;

    const kv = new InMemoryKV();
    const res = await handleToolCall("memory_recall", { query: "auth" }, kv);
    expect(res.content[0]!.type).toBe("text");
  });
});
