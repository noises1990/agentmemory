/**
 * The hooks' capture POST used to end in `.catch(() => {})`. That discarded the
 * only evidence capture was failing, and it hid a real 27-day outage: an
 * ambient AGENTMEMORY_URL pointed every hook at a host that no longer resolved,
 * so nothing was stored between 2026-08-08 and 2026-09-04 while the daemon
 * stayed healthy and `status` reported a reassuring session count.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reportCaptureFailure,
  reportCaptureResponse,
  type CaptureFailureRecord,
} from "../src/hooks/_capture-failure.js";

let dir: string;
let file: string;

const read = (): CaptureFailureRecord =>
  JSON.parse(readFileSync(file, "utf-8")) as CaptureFailureRecord;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "am-capture-"));
  file = join(dir, "capture-failures.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a failed capture leaves a diagnosable trace", () => {
  it("records the URL and the cause — the URL is usually the whole diagnosis", () => {
    reportCaptureFailure(
      "post-tool-use:observe",
      "https://clawnet.tail8cfd57.ts.net/agentmemory/observe",
      new Error("fetch failed"),
      file,
    );
    const rec = read();
    expect(rec.count).toBe(1);
    expect(rec.lastUrl).toContain("clawnet");
    expect(rec.lastError).toBe("fetch failed");
    expect(rec.byHook["post-tool-use:observe"]).toBe(1);
  });

  it("keeps firstAt across repeats, so the outage has a start date", () => {
    reportCaptureFailure("stop:summarize", "http://x/y", new Error("a"), file);
    const first = read().firstAt;
    reportCaptureFailure("stop:summarize", "http://x/y", new Error("b"), file);
    reportCaptureFailure("notification:observe", "http://x/y", new Error("c"), file);

    const rec = read();
    expect(rec.firstAt).toBe(first);
    expect(rec.count).toBe(3);
    expect(rec.byHook).toEqual({ "stop:summarize": 2, "notification:observe": 1 });
    expect(rec.lastError).toBe("c");
  });

  it("catches a REFUSED post, not just an unreachable one", () => {
    // fetch resolves on 401, so watching only the rejection path would leave a
    // wrong AGENTMEMORY_SECRET as silent as the empty catch it replaces.
    reportCaptureResponse(
      "post-tool-use:observe",
      "http://localhost:3111/agentmemory/observe",
      { ok: false, status: 401, statusText: "Unauthorized" },
      file,
    );
    expect(read().lastError).toBe("HTTP 401 Unauthorized");
  });

  it("writes nothing when the post succeeded", () => {
    reportCaptureResponse("x:y", "http://localhost:3111", { ok: true, status: 200, statusText: "OK" }, file);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("starts a fresh run rather than losing the failure when the file is corrupt", () => {
    writeFileSync(file, "{ not json", "utf-8");
    reportCaptureFailure("x:y", "http://h", new Error("boom"), file);
    expect(read().count).toBe(1);
  });

  it("never throws, and never leaves a .tmp behind", () => {
    expect(() =>
      reportCaptureFailure("x:y", "http://h", new Error("boom"), file),
    ).not.toThrow();
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("does not throw when the marker cannot be written at all", () => {
    // A hook that crashed while reporting a failure would be worse than the
    // failure it was reporting.
    const unwritable = join(dir, "no", "such", "dir", "\0bad");
    expect(() =>
      reportCaptureFailure("x:y", "http://h", new Error("boom"), unwritable),
    ).not.toThrow();
  });
});
