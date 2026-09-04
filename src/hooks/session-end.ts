#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAgentMemoryEnv } from "../utils/env-file.js";
import {
  reportCaptureFailure,
  reportCaptureResponse,
} from "./_capture-failure.js";

// Hook processes inherit only the OS environment, never ~/.agentmemory/.env.
// Load it before the module-scope process.env reads below, or a value set only
// in that file (AGENTMEMORY_URL, AGENTMEMORY_SECRET, feature gates) reads as
// undefined and the hook silently takes the disabled branch.
loadAgentMemoryEnv();

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

/**
 * argv token that puts a re-exec of this script into dispatch mode.
 *
 * SessionEnd is the only hook event Claude Code fires while it is tearing the
 * CLI down, and it does not wait for the hook to finish — it aborts the child,
 * which the user sees as `SessionEnd hook [...] failed: Hook cancelled`. The
 * previous shape of this hook fired the REST calls and then held the process
 * open ~1.5s so Node could flush the sockets, which put it squarely inside
 * that abort window every single time. (`stop.ts` has the identical shape and
 * is never cancelled, because Stop fires mid-session with the CLI still alive.)
 *
 * So the work moves to a detached grandchild that outlives the teardown, and
 * the hook itself exits as soon as the spawn is handed to libuv — well under
 * the abort. Measured on Windows: the requests need ~100ms of process life to
 * reach the daemon (a SIGKILL at 20ms loses them, at 100ms they land), and the
 * detached child is no longer racing anything for that time.
 */
const DISPATCH_FLAG = "--agentmemory-dispatch";

/**
 * Fire every session-end REST call. Returns the in-flight promises so the
 * caller decides whether to await them (dispatch mode) or merely let the
 * process linger long enough to flush them (fallback).
 *
 * Each call carries its own AbortSignal.timeout, so none can hang forever.
 */
function fireAll(sessionId: string): Promise<unknown>[] {
  const calls: Promise<unknown>[] = [
    fetch(`${REST_URL}/agentmemory/session/end`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(30000),
    }).then(
      (res) => reportCaptureResponse("session-end:session/end", `${REST_URL}/agentmemory/session/end`, res),
      (err) => reportCaptureFailure("session-end:session/end", `${REST_URL}/agentmemory/session/end`, err),
    ),
  ];

  if (process.env["CONSOLIDATION_ENABLED"] === "true") {
    calls.push(
      fetch(`${REST_URL}/agentmemory/crystals/auto`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ olderThanDays: 0 }),
        signal: AbortSignal.timeout(60000),
      }).then(
        (res) => reportCaptureResponse("session-end:crystals/auto", `${REST_URL}/agentmemory/crystals/auto`, res),
        (err) => reportCaptureFailure("session-end:crystals/auto", `${REST_URL}/agentmemory/crystals/auto`, err),
      ),
    );

    calls.push(
      fetch(`${REST_URL}/agentmemory/consolidate-pipeline`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ tier: "all", force: true }),
        signal: AbortSignal.timeout(120000),
      }).then(
        (res) => reportCaptureResponse("session-end:consolidate-pipeline", `${REST_URL}/agentmemory/consolidate-pipeline`, res),
        (err) => reportCaptureFailure("session-end:consolidate-pipeline", `${REST_URL}/agentmemory/consolidate-pipeline`, err),
      ),
    );
  }

  if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") {
    calls.push(
      fetch(`${REST_URL}/agentmemory/claude-bridge/sync`, {
        method: "POST",
        headers: authHeaders(),
        signal: AbortSignal.timeout(30000),
      }).then(
        (res) => reportCaptureResponse("session-end:claude-bridge/sync", `${REST_URL}/agentmemory/claude-bridge/sync`, res),
        (err) => reportCaptureFailure("session-end:claude-bridge/sync", `${REST_URL}/agentmemory/claude-bridge/sync`, err),
      ),
    );
  }

  return calls;
}

/**
 * Re-exec this same file, detached, to do the REST work after the hook exits.
 *
 * `detached` + `stdio: "ignore"` + `unref()` is what lets it survive the CLI
 * teardown that cancels the hook. `windowsHide` keeps a console window from
 * flashing on every session end on Windows.
 *
 * Spawn failure surfaces asynchronously as an `error` event, not a throw, so
 * `onFailure` re-arms the old inline path rather than losing the calls
 * silently. We never call process.exit() here: letting the loop drain
 * naturally exits in the same tick when the spawn took (the child is unref'd)
 * while still leaving room for that error event to be delivered.
 */
function spawnDispatcher(sessionId: string, onFailure: () => void): void {
  const self = fileURLToPath(import.meta.url);
  const payload = Buffer.from(JSON.stringify({ sessionId }), "utf-8").toString("base64");

  const child = spawn(process.execPath, [self, DISPATCH_FLAG, payload], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });

  child.on("error", onFailure);
  child.unref();
}

/** Old behaviour: fire and hold the process open long enough to flush. */
function fireInline(sessionId: string): void {
  fireAll(sessionId);
  setTimeout(() => process.exit(0), 1500).unref();
}

function decodeDispatchPayload(encoded: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
    return (parsed?.sessionId as string) || "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const flagIdx = process.argv.indexOf(DISPATCH_FLAG);
  if (flagIdx !== -1) {
    // Dispatch mode: detached, nobody is waiting on us, so actually await the
    // calls. The watchdog is unref'd — it never holds the process open by
    // itself, it only fires if a fetch outlives its own AbortSignal and wedges
    // the loop past every per-call timeout.
    setTimeout(() => process.exit(0), 150000).unref();
    await Promise.allSettled(fireAll(decodeDispatchPayload(process.argv[flagIdx + 1] ?? "")));
    return;
  }

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;

  const sessionId = ((data.session_id || data.sessionId) as string) || "unknown";

  spawnDispatcher(sessionId, () => fireInline(sessionId));
}

main().catch(() => process.exit(0));
