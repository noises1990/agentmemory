import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Wiring prefers the MCP server this build ships over the registry copy.
const LOCAL_MCP = resolve(__dirname, "..", "dist", "standalone.mjs");
const HAS_LOCAL_MCP = existsSync(LOCAL_MCP);

// The Continue adapter refuses to touch an existing config.yaml because
// there is no YAML parser in the tree and rewriting would drop comments
// and anchors. That is right for user-authored files — but it also meant
// a config.yaml this emitter wrote itself could never be refreshed, so
// anyone wired before Windows support kept the bare-npx command shape
// forever and just saw "manual install required" on every re-run.

let home: string;
const ORIG_HOME = process.env["HOME"];
const ORIG_USERPROFILE = process.env["USERPROFILE"];

function yamlPath(): string {
  return join(home, ".continue", "config.yaml");
}

function readYaml(): string {
  return readFileSync(yamlPath(), "utf-8");
}

function writeYaml(content: string) {
  mkdirSync(join(home, ".continue"), { recursive: true });
  writeFileSync(yamlPath(), content, "utf-8");
}

async function loadAdapter() {
  vi.resetModules();
  return (await import("../src/cli/connect/continue.js")).adapter;
}

/** The exact bytes the pre-Windows-support emitter produced. */
const LEGACY_YAML = `mcpServers:
  - name: agentmemory
    command: npx
    args:
      - "-y"
      - "@agentmemory/mcp"
    env:
      AGENTMEMORY_URL: "\${AGENTMEMORY_URL:-http://localhost:3111}"
      AGENTMEMORY_SECRET: "\${AGENTMEMORY_SECRET:-}"
      AGENTMEMORY_TOOLS: "\${AGENTMEMORY_TOOLS:-all}"
`;

describe("connect: Continue config.yaml", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-continue-"));
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
  });

  afterEach(() => {
    if (ORIG_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIG_HOME;
    if (ORIG_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIG_USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  });

  it("creates config.yaml from scratch when nothing exists", async () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    expect(readYaml()).toContain(
      HAS_LOCAL_MCP ? "standalone.mjs" : "@agentmemory/mcp",
    );
  });

  it("upgrades a config.yaml it wrote itself to the current command shape", async () => {
    writeYaml(LEGACY_YAML);
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const after = readYaml();
    expect(after).not.toBe(LEGACY_YAML);

    if (HAS_LOCAL_MCP) {
      // The upgrade now also gets off the registry copy entirely: the
      // entry points at the MCP server this build ships, so no fetch and
      // no upstream publish can change what the agent runs.
      expect(after).toContain("standalone.mjs");
      expect(after).toMatch(/command: node/);
      expect(after).not.toContain("npx");
    } else if (process.platform === "win32") {
      // Fallback path: get off bare npx, which on Windows resolves to
      // npx.cmd and leaks an unparented cmd.exe grandchild.
      expect(after).toMatch(/command: .*cmd\.exe/i);
      expect(after).toContain('- "/d"');
      expect(after).toContain("@agentmemory/mcp@");
    }
  });

  it("reports already-wired when the file matches the current shape", async () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false });
    const first = readYaml();

    const second = await adapter.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
    expect(readYaml()).toBe(first);
  });

  it("still rewrites the current shape under --force", async () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false });

    const result = await adapter.install({ dryRun: false, force: true });
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") throw new Error("unreachable");
    expect(result.backupPath).toBeTruthy();
  });

  it("backs up before rewriting", async () => {
    writeYaml(LEGACY_YAML);
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") throw new Error("unreachable");
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(result.backupPath as string, "utf-8")).toBe(LEGACY_YAML);
  });

  it("leaves a user-authored config.yaml untouched and asks for a manual merge", async () => {
    const userConfig = `# my continue setup
models:
  - name: local
    provider: ollama
mcpServers:
  - name: agentmemory
    command: npx
    args:
      - "-y"
      - "@agentmemory/mcp"
`;
    writeYaml(userConfig);
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("stub");
    expect(readYaml()).toBe(userConfig);
  });

  it("treats a single added comment as user content", async () => {
    writeYaml(`# pinned by me\n${LEGACY_YAML}`);
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("stub");
    expect(readYaml()).toContain("# pinned by me");
  });

  it("tolerates CRLF line endings in its own output", async () => {
    writeYaml(LEGACY_YAML.replace(/\n/g, "\r\n"));
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
  });

  // A double-quoted YAML scalar processes backslash escapes, so a Windows
  // path like X:\Projects\...\dist\standalone.mjs is both corrupted (\P and
  // \a are VALID escapes — paragraph separator and bell) and unparseable
  // (\d and \s are not escapes at all). Single-quoted scalars have no
  // escape processing.
  it("emits args as single-quoted YAML so Windows paths survive", async () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false });

    const yaml = readYaml();
    const argLines = yaml
      .split("\n")
      .filter((l) => /^\s+- /.test(l))
      .map((l) => l.trim().slice(2));

    expect(argLines.length).toBeGreaterThan(0);
    for (const arg of argLines) {
      if (!arg.includes("\\")) continue;
      expect(arg.startsWith("'"), `arg must be single-quoted: ${arg}`).toBe(true);
      expect(arg.endsWith("'")).toBe(true);
      // The backslashes must still be there, unescaped and uncollapsed.
      expect(arg).toContain("\\");
      expect(arg).not.toContain('"');
    }
  });

  it("round-trips its own output so a rewrite is not a rewrite", async () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false });
    const first = readYaml();

    // If the emitter and the recogniser disagree, connect reports
    // "manual install required" forever on a file it wrote itself.
    const second = await adapter.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
    expect(readYaml()).toBe(first);
  });

  it("writes nothing on --dry-run", async () => {
    writeYaml(LEGACY_YAML);
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");
    expect(readYaml()).toBe(LEGACY_YAML);
  });
});
