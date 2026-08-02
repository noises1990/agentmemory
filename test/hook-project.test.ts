import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveProject } from "../src/hooks/_project.js";

describe("resolveProject — hook project basename resolver", () => {
  const originalEnv = process.env.AGENTMEMORY_PROJECT_NAME;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_PROJECT_NAME;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTMEMORY_PROJECT_NAME;
    } else {
      process.env.AGENTMEMORY_PROJECT_NAME = originalEnv;
    }
  });

  it("AGENTMEMORY_PROJECT_NAME env wins over everything", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "my-override";
    expect(resolveProject("/var/log")).toBe("my-override");
    expect(resolveProject(process.cwd())).toBe("my-override");
  });

  it("trims whitespace on env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "  spaced  ";
    expect(resolveProject("/var/log")).toBe("spaced");
  });

  it("ignores empty env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "   ";
    const repoBasename = "agentmemory";
    expect(resolveProject(process.cwd())).toBe(repoBasename);
  });

  it("returns git toplevel basename when cwd is inside a repo", () => {
    const top = resolveProject(process.cwd());
    expect(top).toBe("agentmemory");
  });

  it("returns git toplevel basename from a nested subdir", () => {
    const nested = join(process.cwd(), "src", "hooks");
    expect(resolveProject(nested)).toBe("agentmemory");
  });

  // Regression: this used to shell out to `git rev-parse` with a 500ms
  // timeout, so under load it returned "hooks" instead of "agentmemory"
  // and observations were filed under the wrong project. Resolution must
  // not depend on how busy the machine is.
  it("resolves the same repo root under repeated rapid calls", () => {
    const nested = join(process.cwd(), "src", "hooks");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(resolveProject(nested));
    expect([...seen]).toEqual(["agentmemory"]);
  });

  it("finds the root from a deeply nested path", () => {
    const deep = join(process.cwd(), "src", "functions");
    expect(resolveProject(deep)).toBe("agentmemory");
  });

  it("falls back to basename(cwd) when not in a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-noproj-"));
    try {
      // Not dir.split("/"): mkdtemp returns backslash-separated paths on
      // Windows, so splitting on "/" handed back the whole path.
      expect(resolveProject(dir)).toBe(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to process.cwd() when no cwd argument given", () => {
    expect(resolveProject()).toBe("agentmemory");
  });

  it("defaults to process.cwd() when cwd argument is empty", () => {
    expect(resolveProject("")).toBe("agentmemory");
    expect(resolveProject("   ")).toBe("agentmemory");
  });
});
