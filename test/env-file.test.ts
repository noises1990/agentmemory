import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseEnvText,
  readEnvFile,
  loadAgentMemoryEnv,
} from "../src/utils/env-file.js";

// ─────────────────────────────────────────────────────────────
// ~/.agentmemory/.env is read by the daemon (config.ts) and, since the
// hook-gate fix, by the hook bundles too. Both go through this module so a
// value can never parse differently on the two sides.
// ─────────────────────────────────────────────────────────────

const dirs: string[] = [];
const touched: string[] = [];

function envFileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "am-env-"));
  dirs.push(dir);
  const path = join(dir, ".env");
  writeFileSync(path, content, "utf-8");
  return path;
}

afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseEnvText", () => {
  it("parses plain key=value pairs", () => {
    expect(parseEnvText("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  it("skips blank lines and # comments", () => {
    expect(parseEnvText("# note\n\nA=1\n   # indented\nB=2")).toEqual({
      A: "1",
      B: "2",
    });
  });

  it("strips surrounding quotes", () => {
    expect(parseEnvText(`A="q"\nB='s'`)).toEqual({ A: "q", B: "s" });
  });

  it("strips a trailing ' #' comment from unquoted values", () => {
    expect(parseEnvText("A=1 # why")).toEqual({ A: "1" });
  });

  it("keeps a bare # inside an unquoted value", () => {
    // Only " #" (space-hash) opens a trailing comment.
    expect(parseEnvText("A=ab#cd")).toEqual({ A: "ab#cd" });
  });

  it("keeps '=' appearing inside the value", () => {
    // Matters for base64 secrets and DSNs.
    expect(parseEnvText("A=a=b=c")).toEqual({ A: "a=b=c" });
  });

  it("ignores lines with no '='", () => {
    expect(parseEnvText("JUSTAKEY\nA=1")).toEqual({ A: "1" });
  });
});

describe("readEnvFile", () => {
  it("returns {} when the file is absent", () => {
    expect(readEnvFile(join(tmpdir(), "definitely-not-here-.env"))).toEqual({});
  });

  it("reads and parses an existing file", () => {
    const p = envFileWith("CONSOLIDATION_ENABLED=true\n# c\nX=1\n");
    expect(readEnvFile(p)).toEqual({ CONSOLIDATION_ENABLED: "true", X: "1" });
  });
});

describe("loadAgentMemoryEnv", () => {
  it("populates process.env from the file", () => {
    const p = envFileWith("AM_TEST_FRESH=fromfile\n");
    touched.push("AM_TEST_FRESH");
    loadAgentMemoryEnv(p);
    expect(process.env["AM_TEST_FRESH"]).toBe("fromfile");
  });

  it("lets the OS environment win over the file", () => {
    // Mirrors config.ts's {...fileEnv, ...process.env} precedence: an
    // explicitly exported var must keep overriding .env in daemon and hooks
    // alike, or the two disagree about the same key.
    const p = envFileWith("AM_TEST_PRECEDENCE=fromfile\n");
    touched.push("AM_TEST_PRECEDENCE");
    process.env["AM_TEST_PRECEDENCE"] = "fromos";
    loadAgentMemoryEnv(p);
    expect(process.env["AM_TEST_PRECEDENCE"]).toBe("fromos");
  });

  it("is a no-op when the file is absent", () => {
    expect(() =>
      loadAgentMemoryEnv(join(tmpdir(), "definitely-not-here-.env")),
    ).not.toThrow();
  });

  it("makes a gate set only in .env read as enabled", () => {
    // The exact regression: session-end.ts gates crystallisation on
    // CONSOLIDATION_ENABLED === "true". The value lived in ~/.agentmemory/.env,
    // hooks never loaded that file, so the branch was permanently dead.
    const p = envFileWith("CONSOLIDATION_ENABLED=true\n");
    touched.push("CONSOLIDATION_ENABLED");
    delete process.env["CONSOLIDATION_ENABLED"];
    loadAgentMemoryEnv(p);
    expect(process.env["CONSOLIDATION_ENABLED"]).toBe("true");
  });
});
