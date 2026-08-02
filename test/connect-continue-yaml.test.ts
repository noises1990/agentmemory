import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(readYaml()).toContain("@agentmemory/mcp");
  });

  it("upgrades a config.yaml it wrote itself to the current command shape", async () => {
    writeYaml(LEGACY_YAML);
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const after = readYaml();
    expect(after).not.toBe(LEGACY_YAML);
    expect(after).toContain("@agentmemory/mcp");
    if (process.platform === "win32") {
      // The whole point of the upgrade: get off bare npx, which on Windows
      // resolves to npx.cmd and leaks an unparented cmd.exe grandchild.
      expect(after).toMatch(/command: .*cmd\.exe/i);
      expect(after).toContain('- "/d"');
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

  it("writes nothing on --dry-run", async () => {
    writeYaml(LEGACY_YAML);
    const adapter = await loadAdapter();
    const result = await adapter.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");
    expect(readYaml()).toBe(LEGACY_YAML);
  });
});
