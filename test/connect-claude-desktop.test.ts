import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

// Claude Desktop is a SEPARATE install from Claude Code and reads a
// different file. `connect claude-code` writes ~/.claude.json, which
// Desktop never reads — so someone with both installed saw agentmemory in
// the terminal, not in the app, with nothing explaining the gap.

let home: string;
const SAVED: Record<string, string | undefined> = {};
const MANAGED = ["HOME", "USERPROFILE", "APPDATA"];

/** The documented Electron userData location for the current platform. */
function desktopDir(root: string): string {
  if (platform() === "win32") return join(root, "AppData", "Roaming", "Claude");
  if (platform() === "darwin")
    return join(root, "Library", "Application Support", "Claude");
  return join(root, ".config", "Claude");
}

function configPath(): string {
  return join(desktopDir(home), "claude_desktop_config.json");
}

async function loadAdapter() {
  vi.resetModules();
  return (await import("../src/cli/connect/claude-desktop.js")).adapter;
}

describe("connect: Claude Desktop", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-claude-desktop-"));
    for (const k of MANAGED) SAVED[k] = process.env[k];
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    // Windows resolves the dir from APPDATA, so the sandbox has to move
    // it too or the adapter writes to the real Claude Desktop config.
    process.env["APPDATA"] = join(home, "AppData", "Roaming");
  });

  afterEach(() => {
    for (const k of MANAGED) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("does not detect when Claude Desktop is not installed", async () => {
    const adapter = await loadAdapter();
    expect(adapter.detect()).toBe(false);
  });

  it("detects the platform's Claude Desktop directory", async () => {
    mkdirSync(desktopDir(home), { recursive: true });
    const adapter = await loadAdapter();
    expect(adapter.detect()).toBe(true);
  });

  it("writes mcpServers.agentmemory into claude_desktop_config.json", async () => {
    mkdirSync(desktopDir(home), { recursive: true });
    const adapter = await loadAdapter();

    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const cfg = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(cfg.mcpServers.agentmemory).toBeDefined();
    expect(
      [cfg.mcpServers.agentmemory.command, ...cfg.mcpServers.agentmemory.args].join(" "),
    ).toMatch(/standalone\.mjs|@agentmemory\/mcp/);
    expect(cfg.mcpServers.agentmemory.env.AGENTMEMORY_URL).toMatch(
      /\$\{AGENTMEMORY_URL:-/,
    );
  });

  it("preserves other MCP servers and unrelated top-level keys", async () => {
    mkdirSync(desktopDir(home), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        mcpServers: { other: { command: "x", args: ["--y"] } },
        coworkUserFilesPath: "C:/somewhere",
        preferences: { theme: "dark" },
      }),
    );

    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false });

    const cfg = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(cfg.mcpServers.other.command).toBe("x");
    expect(cfg.mcpServers.agentmemory).toBeDefined();
    expect(cfg.coworkUserFilesPath).toBe("C:/somewhere");
    expect(cfg.preferences.theme).toBe("dark");
  });

  it("is idempotent", async () => {
    mkdirSync(desktopDir(home), { recursive: true });
    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false });
    const first = readFileSync(configPath(), "utf-8");

    const second = await adapter.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
    expect(readFileSync(configPath(), "utf-8")).toBe(first);
  });

  it("writes nothing on --dry-run", async () => {
    mkdirSync(desktopDir(home), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ mcpServers: {} }));
    const adapter = await loadAdapter();

    const result = await adapter.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");
    const cfg = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(cfg.mcpServers.agentmemory).toBeUndefined();
  });

  // Regression guard: the two Claude adapters must not collide. Wiring
  // Desktop must never write ~/.claude.json, and vice versa.
  it("does not touch the Claude Code config", async () => {
    mkdirSync(desktopDir(home), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));

    const adapter = await loadAdapter();
    await adapter.install({ dryRun: false, force: false });

    const claudeCode = JSON.parse(
      readFileSync(join(home, ".claude.json"), "utf-8"),
    );
    expect(claudeCode.mcpServers.agentmemory).toBeUndefined();
  });
});
