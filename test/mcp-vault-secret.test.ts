/**
 * An MCP host does not hand a stdio server its environment: Claude Code passes
 * only the configured `env` plus a default set, and strips names that look like
 * credentials. So the shim reads the daemon bearer from the vault when the
 * variable is absent -- and only then.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  resetHandleForTests,
  setLivezProbe,
  setVaultReaderForTests,
  resolveHandle,
} from "../src/mcp/rest-proxy.js";

const originalFetch = globalThis.fetch;
const originalSecret = process.env["AGENTMEMORY_SECRET"];
const originalUrl = process.env["AGENTMEMORY_URL"];

function captureHeaders() {
  const seen: Array<Record<string, string>> = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}

async function proxyCall(): Promise<Array<Record<string, string>>> {
  const seen = captureHeaders();
  const handle = await resolveHandle();
  if (handle.mode !== "proxy") throw new Error("expected proxy mode");
  await handle.call("/agentmemory/livez", { method: "GET" });
  return seen;
}

describe("bearer from the vault when the environment has none", () => {
  beforeEach(() => {
    resetHandleForTests();
    process.env["AGENTMEMORY_URL"] = "http://localhost:3111";
    setLivezProbe(vi.fn(async () => ({ ok: true })));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env["AGENTMEMORY_SECRET"];
    else process.env["AGENTMEMORY_SECRET"] = originalSecret;
    if (originalUrl === undefined) delete process.env["AGENTMEMORY_URL"];
    else process.env["AGENTMEMORY_URL"] = originalUrl;
    setVaultReaderForTests(null);
    resetHandleForTests();
  });

  it("uses the vault entry when AGENTMEMORY_SECRET is absent", async () => {
    delete process.env["AGENTMEMORY_SECRET"];
    setVaultReaderForTests(() => "from-vault");
    const seen = await proxyCall();
    expect(seen[0]!["authorization"]).toBe("Bearer from-vault");
  });

  it("prefers the environment when it is set", async () => {
    process.env["AGENTMEMORY_SECRET"] = "from-env";
    setVaultReaderForTests(() => "from-vault");
    const seen = await proxyCall();
    expect(seen[0]!["authorization"]).toBe("Bearer from-env");
  });

  it("sends no bearer when both are missing -- the server's 401 stays loud", async () => {
    delete process.env["AGENTMEMORY_SECRET"];
    setVaultReaderForTests(() => null);
    const seen = await proxyCall();
    expect(seen[0]!["authorization"]).toBeUndefined();
  });
});
