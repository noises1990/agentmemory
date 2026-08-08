import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { handleToolCall } from "../src/mcp/standalone.js";
import {
  resetHandleForTests,
  setLivezProbe,
  isConfiguredRemote,
  type LivezProbe,
} from "../src/mcp/rest-proxy.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";

/**
 * Regression suite for the silent-fallback defect: a transient network window
 * made the shim latch onto the process-local InMemoryKV, so memory_save wrote
 * to throwaway RAM and memory_recall answered `[]` with no error reaching the
 * caller. When AGENTMEMORY_URL is explicitly pointed at a real deployment that
 * degradation must be a hard error instead.
 */

const REMOTE = "https://memory.example.com";
const LOCAL = "http://localhost:3111";

type FetchMock = ReturnType<typeof vi.fn>;

function installFetch(handler: (url: string, init?: RequestInit) => Response): FetchMock {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(url.toString(), init),
  );
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

const failingProbe: LivezProbe = async () => {
  throw new Error("ECONNREFUSED 10.0.0.9:443");
};

const status503Probe: LivezProbe = async () => ({
  ok: false,
  status: 503,
  statusText: "Service Unavailable",
});

const okProbe: LivezProbe = async () => ({ ok: true, status: 200, statusText: "OK" });

describe("configured remote AGENTMEMORY_URL never falls back to InMemoryKV", () => {
  const originalFetch = globalThis.fetch;
  let stderr: string[];
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    resetHandleForTests();
    delete process.env["AGENTMEMORY_SECRET"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
    stderr = [];
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
  });

  describe("isConfiguredRemote", () => {
    it("treats unset, localhost, 127.0.0.1 and [::1] as local", () => {
      delete process.env["AGENTMEMORY_URL"];
      expect(isConfiguredRemote()).toBe(false);
      for (const url of [
        "http://localhost:3111",
        "http://127.0.0.1:3111",
        "http://[::1]:3111",
        "https://LOCALHOST:8443",
      ]) {
        process.env["AGENTMEMORY_URL"] = url;
        expect(isConfiguredRemote(), url).toBe(false);
      }
    });

    it("treats real hosts as remote, and an unexpanded placeholder as local", () => {
      for (const url of [REMOTE, "http://10.0.0.9:3111", "http://memory.internal:3111"]) {
        process.env["AGENTMEMORY_URL"] = url;
        expect(isConfiguredRemote(), url).toBe(true);
      }
      // MCP hosts that don't expand ${VAR} pass the literal through; that must
      // resolve to the localhost default rather than a bogus "remote".
      process.env["AGENTMEMORY_URL"] = "${AGENTMEMORY_URL}";
      expect(isConfiguredRemote()).toBe(false);
    });
  });

  it("rejects the tool call, naming the URL and the transport error", async () => {
    process.env["AGENTMEMORY_URL"] = REMOTE;
    setLivezProbe(failingProbe);
    const kv = new InMemoryKV(undefined);

    await expect(
      handleToolCall("memory_save", { content: "must not land in RAM" }, kv),
    ).rejects.toThrow(/memory\.example\.com/);

    resetHandleForTests();
    setLivezProbe(failingProbe);
    await expect(
      handleToolCall("memory_save", { content: "must not land in RAM" }, kv),
    ).rejects.toThrow(/ECONNREFUSED 10\.0\.0\.9:443/);
  });

  it("names the HTTP status when the probe returns a non-200", async () => {
    process.env["AGENTMEMORY_URL"] = REMOTE;
    setLivezProbe(status503Probe);
    await expect(handleToolCall("memory_recall", { query: "anything" })).rejects.toThrow(
      /503 Service Unavailable/,
    );
  });

  it("does NOT return an empty-but-successful recall (the actual incident)", async () => {
    process.env["AGENTMEMORY_URL"] = REMOTE;
    setLivezProbe(failingProbe);
    const kv = new InMemoryKV(undefined);

    const result = await handleToolCall("memory_recall", { query: "launchproof" }, kv)
      .then((r) => ({ ok: true as const, r }))
      .catch((e: Error) => ({ ok: false as const, e }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.e.message).toMatch(/refusing to fall back|Refusing/i);
  });

  it("writes nothing to the local KV when the remote is unreachable", async () => {
    process.env["AGENTMEMORY_URL"] = REMOTE;
    setLivezProbe(failingProbe);
    const kv = new InMemoryKV(undefined);

    await expect(handleToolCall("memory_save", { content: "ghost write" }, kv)).rejects.toThrow();

    const scopes = await kv.list("memories");
    expect(scopes).toEqual([]);
  });

  it("still emits a stderr line so the failure is durably visible", async () => {
    process.env["AGENTMEMORY_URL"] = REMOTE;
    setLivezProbe(failingProbe);
    await expect(handleToolCall("memory_save", { content: "x" })).rejects.toThrow();
    const joined = stderr.join("");
    expect(joined).toMatch(/memory\.example\.com/);
    expect(joined).toMatch(/AGENTMEMORY_FORCE_PROXY/);
  });

  it("surfaces a mid-session proxy call failure instead of answering from local KV", async () => {
    process.env["AGENTMEMORY_URL"] = REMOTE;
    // Probe succeeds, then the real call dies — the transient-network case.
    setLivezProbe(okProbe);
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
    });
    const kv = new InMemoryKV(undefined);

    await expect(
      handleToolCall("memory_recall", { query: "launchproof" }, kv),
    ).rejects.toThrow(/502|Bad Gateway/);
  });
});

describe("localhost / zero-config keeps the documented InMemoryKV fallback", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
  });

  it("falls back and round-trips through the local KV when AGENTMEMORY_URL is localhost", async () => {
    process.env["AGENTMEMORY_URL"] = LOCAL;
    setLivezProbe(failingProbe);
    const kv = new InMemoryKV(undefined);

    await handleToolCall("memory_save", { content: "local only" }, kv);
    const recall = await handleToolCall("memory_recall", { query: "local" }, kv);
    const out = JSON.parse(recall.content[0].text);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].content).toBe("local only");
  });

  it("falls back when AGENTMEMORY_URL is unset entirely", async () => {
    delete process.env["AGENTMEMORY_URL"];
    setLivezProbe(failingProbe);
    const kv = new InMemoryKV(undefined);

    await handleToolCall("memory_save", { content: "zero config" }, kv);
    const recall = await handleToolCall("memory_recall", { query: "zero" }, kv);
    expect(JSON.parse(recall.content[0].text).results).toHaveLength(1);
  });

  it("emits the stderr warning on the fallback path", async () => {
    process.env["AGENTMEMORY_URL"] = LOCAL;
    setLivezProbe(failingProbe);
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      await handleToolCall("memory_save", { content: "diag" }, new InMemoryKV(undefined));
    } finally {
      process.stderr.write = origWrite;
    }
    const joined = writes.join("");
    expect(joined).toMatch(/livez probe .* failed/);
    expect(joined).toMatch(/AGENTMEMORY_FORCE_PROXY/);
  });
});

describe("the failed probe does not latch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
    vi.useFakeTimers();
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
  });

  afterEach(() => {
    vi.useRealTimers();
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
  });

  it("recovers automatically once the daemon is reachable again — no restart", async () => {
    process.env["AGENTMEMORY_URL"] = REMOTE;
    let up = false;
    let probes = 0;
    setLivezProbe(async () => {
      probes++;
      if (!up) throw new Error("ECONNREFUSED 10.0.0.9:443");
      return { ok: true, status: 200, statusText: "OK" };
    });
    installFetch((url) => {
      if (url.endsWith("/agentmemory/search")) {
        return new Response(
          JSON.stringify({ mode: "compact", results: [{ id: "m1", content: "from server" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await expect(handleToolCall("memory_recall", { query: "q" })).rejects.toThrow(
      /unreachable/i,
    );
    expect(probes).toBe(1);

    // Inside the negative TTL: re-raise the cached error without re-probing.
    await expect(handleToolCall("memory_recall", { query: "q" })).rejects.toThrow(
      /unreachable/i,
    );
    expect(probes).toBe(1);

    // Daemon comes back; once the short TTL lapses the shim must re-probe and
    // serve from the REST proxy without any process restart.
    up = true;
    await vi.advanceTimersByTimeAsync(4_000);

    const res = await handleToolCall("memory_recall", { query: "q" });
    expect(probes).toBe(2);
    const body = JSON.parse(res.content[0].text);
    expect(body.results[0].content).toBe("from server");
  });
});

describe("AGENTMEMORY_FORCE_PROXY=1 semantics are preserved", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
  });

  it("skips the probe entirely and proxies straight to the configured remote", async () => {
    process.env["AGENTMEMORY_URL"] = REMOTE;
    process.env["AGENTMEMORY_FORCE_PROXY"] = "1";
    const probe = vi.fn(async () => {
      throw new Error("probe should be skipped");
    });
    setLivezProbe(probe);
    const urls: string[] = [];
    installFetch((url) => {
      urls.push(url);
      if (url.endsWith("/agentmemory/remember")) {
        return new Response(JSON.stringify({ id: "m-1", action: "created" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    await handleToolCall("memory_save", { content: "force-proxy remote" });
    expect(probe).not.toHaveBeenCalled();
    expect(urls.some((u) => u.endsWith("/agentmemory/livez"))).toBe(false);
    expect(urls.some((u) => u.endsWith("/agentmemory/remember"))).toBe(true);
  });
});
