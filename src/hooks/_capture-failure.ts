import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Durable record of capture POSTs that never reached the daemon.
 *
 * Every hook used to end its fire-and-forget POST with `.catch(() => {})`. That
 * discarded the only evidence that capture was failing, and it hid a real
 * outage: an ambient AGENTMEMORY_URL pointed every hook at a host that no
 * longer resolved, so from 2026-08-08 to 2026-09-04 not one observation was
 * stored. The daemon was healthy the whole time and `agentmemory status`
 * reported a growing-looking session count, because the count was of rows
 * written before the break.
 *
 * A hook may not print to the transcript on every tool use and may not block,
 * so the signal goes to one small file that `agentmemory status` reads back.
 *
 * Deliberately NOT written on the success path: that would be a synchronous
 * file write on every tool call. Recovery is inferred instead — status compares
 * this marker's `lastAt` against the newest observation and reports the failure
 * as resolved when capture has since succeeded.
 */

export const CAPTURE_FAILURE_FILE = join(
  homedir(),
  ".agentmemory",
  "capture-failures.json",
);

export interface CaptureFailureRecord {
  v: 1;
  /** First failure of the current run, ISO. */
  firstAt: string;
  /** Most recent failure, ISO. Status compares this against capture recency. */
  lastAt: string;
  /** Total failures recorded. Approximate under concurrency — see below. */
  count: number;
  /** Per-hook totals, so one broken hook is distinguishable from all of them. */
  byHook: Record<string, number>;
  /** The URL that was tried, which is usually the whole diagnosis. */
  lastUrl: string;
  /** Message only. Never a response body: it can carry a bearer token. */
  lastError: string;
  /**
   * Which client's environment the failing hook ran in, as the NAMES of its
   * marker variables (CLAUDE_*, CODEX_*, DEVIN_*) -- never values. Several
   * agents on one machine run the same hook scripts, and a 401 from a client
   * that still holds a rotated bearer looks identical to one from the client
   * you are sitting in. This is what tells them apart.
   */
  lastClient: string;
}

function clientHint(): string {
  const names = Object.keys(process.env)
    .filter((k) => /^(CLAUDE|CODEX|DEVIN|CURSOR|COPILOT)[_A-Z]*/.test(k))
    .sort();
  return names.length ? names.join(",") : "none";
}

function readRecord(path: string): CaptureFailureRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CaptureFailureRecord;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    // Absent or corrupt: start a fresh run rather than lose the current
    // failure. This catch is the one place a swallow is right — the marker is
    // the diagnostic, so failing to read it must not suppress writing it.
    return null;
  }
}

/**
 * Record one failed capture POST.
 *
 * Never throws: it runs inside the hook's `.catch`, and a hook that crashed
 * while reporting a failure would be worse than the failure. If even the file
 * write fails, it says so on stderr — the last channel available.
 *
 * Concurrency: hooks are separate short-lived processes, so two failing at once
 * can lose an increment in the read-modify-write. That is accepted. The value
 * of this file is "capture is broken, since when, against which URL", and none
 * of those are harmed by an off-by-a-few count.
 */
export function reportCaptureFailure(
  hookType: string,
  url: string,
  err: unknown,
  file: string = CAPTURE_FAILURE_FILE,
): void {
  reportCaptureFailureImpl(hookType, url, err, file);
}

/**
 * Record a capture POST that ARRIVED and was refused.
 *
 * `fetch` rejects only on a transport failure, so a 401 from a wrong or missing
 * AGENTMEMORY_SECRET resolves normally with `ok: false`. Watching just the
 * rejection path would leave that case as silent as the empty catch it
 * replaces — and an auth failure is the likelier of the two to persist unnoticed,
 * because the host is up and nothing times out.
 *
 * The body is never read: it is the daemon's error JSON, and the request that
 * produced it carried a bearer token.
 */
export function reportCaptureResponse(
  hookType: string,
  url: string,
  res: { ok: boolean; status: number; statusText: string; text?: () => Promise<string> },
  file: string = CAPTURE_FAILURE_FILE,
): void {
  if (res.ok) return;
  const head = `HTTP ${res.status} ${res.statusText || ""}`.trim();
  // For a 4xx the daemon's error JSON names the rejected field ("project is
  // required"), and that is the whole diagnosis -- a 400 with no reason cost a
  // day on 2026-09-05. Only the `error` string is kept, capped, and only for
  // 4xx: it is the server's own message about our request, never an echo of it.
  if (res.status >= 400 && res.status < 500 && typeof res.text === "function") {
    res.text().then(
      (body) => {
        let reason = "";
        try { reason = String((JSON.parse(body) as { error?: unknown }).error ?? ""); } catch { /* not JSON */ }
        reportCaptureFailureImpl(hookType, url, new Error(reason ? `${head}: ${reason.slice(0, 120)}` : head), file);
      },
      () => reportCaptureFailureImpl(hookType, url, new Error(head), file),
    );
    return;
  }
  reportCaptureFailureImpl(hookType, url, new Error(head), file);
}

export const CAPTURE_SKIP_FILE = join(homedir(), ".agentmemory", "capture-skips.log");
const CAPTURE_SKIP_CAP_BYTES = 64 * 1024;

/**
 * Record a hook that decided NOT to post -- an unparsable payload, or a
 * payload it classifies as an SDK child context. Those returns are by design,
 * but from the outside they are indistinguishable from a hook that never ran:
 * no observation, no failure marker, nothing. On 2026-09-05 a whole session
 * captured nothing while the daemon was healthy and the marker was quiet,
 * and there was no way to tell which return it was without patching the
 * bundle by hand.
 *
 * Bounded: appends until the file reaches CAPTURE_SKIP_CAP_BYTES, then stops.
 * The value of the log is the first few lines after a change, not a stream.
 * Payload contents are never written -- only key names and the fields that
 * decide the skip.
 */
export function reportCaptureSkip(
  hookType: string,
  reason: string,
  detail: Record<string, string | number | boolean | null>,
  file: string = CAPTURE_SKIP_FILE,
): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch { /* absent: first line */ }
    if (size >= CAPTURE_SKIP_CAP_BYTES) return;
    writeFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), hook: hookType, reason, ...detail }) + "\n",
      { flag: "a" },
    );
  } catch {
    // Diagnostic only; a hook must never fail because its breadcrumb could not be written.
  }
}

/** The fields that decide an SDK-child skip, as names and flags -- never payload contents. */
export function describeHookPayload(data: unknown): Record<string, string | number | boolean | null> {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  return {
    keys: obj ? Object.keys(obj).sort().join(",") : "",
    entrypoint: obj && typeof obj["entrypoint"] === "string" ? (obj["entrypoint"] as string) : null,
    sdkChildEnv: process.env["AGENTMEMORY_SDK_CHILD"] ?? null,
    sessionPrefix: obj ? String(obj["session_id"] ?? obj["sessionId"] ?? "").slice(0, 8) : "",
    client: Object.keys(process.env).filter((k) => /^(CLAUDE|CODEX|DEVIN)[_A-Z]*/.test(k)).sort().join(","),
  };
}

function reportCaptureFailureImpl(
  hookType: string,
  url: string,
  err: unknown,
  file: string,
): void {
  try {
    const now = new Date().toISOString();
    const prev = readRecord(file);
    const record: CaptureFailureRecord = {
      v: 1,
      firstAt: prev?.firstAt ?? now,
      lastAt: now,
      count: (prev?.count ?? 0) + 1,
      byHook: { ...(prev?.byHook ?? {}) },
      lastUrl: url,
      lastError: err instanceof Error ? err.message : String(err),
      lastClient: clientHint(),
    };
    record.byHook[hookType] = (record.byHook[hookType] ?? 0) + 1;

    mkdirSync(join(file, ".."), { recursive: true });
    // Temp + rename: status may read this while a hook writes it, and a
    // half-written file would read as corrupt and reset the run.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
    renameSync(tmp, file);
  } catch (writeErr) {
    process.stderr.write(
      `[agentmemory] capture failed for ${hookType} against ${url}, and the failure marker at ${file} could not be written: ${
        writeErr instanceof Error ? writeErr.message : String(writeErr)
      }\n`,
    );
  }
}
