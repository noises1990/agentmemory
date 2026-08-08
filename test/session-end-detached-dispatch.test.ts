import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { AddressInfo } from "node:net";

/**
 * SessionEnd is the only hook event Claude Code fires while it is tearing the
 * CLI down, and it does not wait for the hook — it aborts it, which surfaces as
 *
 *   SessionEnd hook [node ".../session-end.mjs"] failed: Hook cancelled
 *
 * The hook used to fire its REST calls and then hold the process open ~1.5s so
 * Node could flush the sockets, which parked it inside that abort window on
 * every single exit. The fix moves the REST work into a detached grandchild
 * that outlives the teardown, so the hook itself returns as soon as the spawn
 * is handed off.
 *
 * These tests run the built plugin script — the artifact Claude Code actually
 * invokes, and one that is committed to the repo, so it is always present.
 * Testing the .ts source would not exercise the re-exec at all: the dispatcher
 * re-runs itself with a bare `process.execPath`, which cannot load TypeScript.
 */
const HOOK = "plugin/scripts/session-end.mjs";

/** Old dwell, in ms. Exiting anywhere near this is the bug coming back. */
const OLD_LINGER_MS = 1500;

/** Session id the stub deliberately never answers, to test who is still waiting. */
const HOLD_ID = "hold-the-socket-open";

interface Received {
  path: string;
  body: string;
  sessionId: string;
  at: number;
  socket: Socket;
  res: ServerResponse;
}

describe("session-end hook dispatches through a detached child (Hook cancelled)", () => {
  let server: Server;
  // Never reset between tests. Detached children are, by design, still in
  // flight when a test ends, so a late arrival would otherwise land in the
  // next test's window. Every assertion filters on its own session id instead.
  const received: Received[] = [];
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let sessionId = "";
        try {
          sessionId = JSON.parse(body)?.sessionId ?? "";
        } catch {
          /* non-JSON body — leave blank, no test filters on it */
        }
        received.push({ path: req.url ?? "", body, sessionId, at: Date.now(), socket: req.socket, res });
        // Hold this one open: the socket staying up is the evidence that a
        // process is still there waiting for it.
        if (sessionId === HOLD_ID) return;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });

  /**
   * Run the hook exactly as Claude Code does: `node <script>`, payload on
   * stdin. Feature gates are pinned explicitly rather than left to the
   * developer's ~/.agentmemory/.env — loadAgentMemoryEnv() only fills in keys
   * that are `undefined`, so setting them here keeps the test hermetic.
   */
  function runHook(sessionId: string) {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [HOOK], {
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        ...process.env,
        AGENTMEMORY_URL: baseUrl,
        CONSOLIDATION_ENABLED: "false",
        CLAUDE_MEMORY_BRIDGE: "false",
      },
    });
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: "SessionEnd" }));
    return { child, startedAt };
  }

  const forSession = (sessionId: string) =>
    received.find((r) => r.sessionId === sessionId && r.path === "/agentmemory/session/end");

  async function waitForSession(sessionId: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = forSession(sessionId);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    return undefined;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("ships the built artifact the hook config points at", () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it("exits long before the old 1.5s dwell, so the abort has nothing to cancel", async () => {
    const { child, startedAt } = runHook("exit-latency");
    const [code] = await once(child, "exit");
    const elapsed = Date.now() - startedAt;

    expect(code).toBe(0);
    // Node's own cold start is most of this. The point is that it is nowhere
    // near OLD_LINGER_MS — the hook no longer waits on its own HTTP calls.
    expect(elapsed).toBeLessThan(OLD_LINGER_MS);
  });

  it("keeps the request alive after the hook process is gone", async () => {
    const { child } = runHook(HOLD_ID);
    await once(child, "exit");

    const hit = await waitForSession(HOLD_ID);
    expect(hit, "session/end never reached the stub daemon").toBeDefined();

    // The stub deliberately never answers. Wait past the old 1.5s dwell: the
    // inline version called process.exit(0) at that mark and took its own
    // in-flight socket down with it. The detached dispatcher is on a 30s
    // AbortSignal and is still there.
    //
    // Asserting survival rather than "the request landed after the hook
    // exited" is deliberate — the child boots and fires while the parent is
    // still finishing teardown, so that ordering is a race, not a property.
    await sleep(OLD_LINGER_MS + 700);
    expect(hit!.socket.destroyed, "nothing was left waiting for the response").toBe(false);

    // Let the dispatcher go rather than leaving it parked on its 30s timeout.
    hit!.res.writeHead(200, { "Content-Type": "application/json" });
    hit!.res.end(JSON.stringify({ success: true }));
  });

  it("round-trips the session id through the base64 argv payload", async () => {
    const sessionId = "a6a1fb8a-7e5a-450d-8bfa-484aace7e652";
    const { child } = runHook(sessionId);
    await once(child, "exit");

    const hit = await waitForSession(sessionId);
    expect(hit, "session/end never reached the stub daemon").toBeDefined();
    expect(JSON.parse(hit!.body)).toEqual({ sessionId });
  });

  it("stays silent for SDK child sessions", async () => {
    const sessionId = "sdk-child-session";
    const child = spawn(process.execPath, [HOOK], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, AGENTMEMORY_URL: baseUrl, CONSOLIDATION_ENABLED: "false" },
    });
    child.stdin.end(JSON.stringify({ session_id: sessionId, entrypoint: "sdk-ts" }));
    await once(child, "exit");

    // Give a real dispatcher more than enough time to have shown up. The other
    // tests establish that one arrives well inside this window.
    await sleep(1000);
    expect(forSession(sessionId)).toBeUndefined();
  });
});
