import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  ADAPTERS,
  knownAgents,
  resolveAdapter,
} from "../src/cli/connect/index.js";
import type { ConnectAdapter } from "../src/cli/connect/types.js";
import { VERSION } from "../src/version.js";

// Every adapter now shares this shape, not just Copilot. On Windows a
// bare `npx` command is resolved through cmd.exe implicitly, orphaning
// the real node process on client exit; spawning cmd.exe explicitly
// keeps it a direct child. Copilot always did this, which is why it was
// `connect`'s sole Windows exception.
// This build ships its own MCP server (tsdown entry src/mcp/standalone.ts).
// When it is present, wiring points at that file directly rather than at
// the registry copy: no network, no npx cache, and — the actual problem —
// no chance of a future upstream publish silently replacing the shim on
// the next cache miss. `node` is a real executable everywhere, so the
// cmd.exe wrapper is only needed for the npx fallback.
const LOCAL_MCP = resolve(__dirname, "..", "dist", "standalone.mjs");
const HAS_LOCAL_MCP = existsSync(LOCAL_MCP);

const EXPECTED_MCP_COMMAND = HAS_LOCAL_MCP
  ? { command: "node", args: [LOCAL_MCP] }
  : process.platform === "win32"
    ? {
        command: process.env["ComSpec"] || process.env["COMSPEC"] || "cmd.exe",
        args: ["/d", "/s", "/c", "npx", "-y", `@agentmemory/mcp@${VERSION}`],
      }
    : {
        command: "npx",
        args: ["-y", `@agentmemory/mcp@${VERSION}`],
      };

/** Identifies the wired entry regardless of which of the two forms it took. */
const MCP_MARKER = HAS_LOCAL_MCP ? "standalone.mjs" : "@agentmemory/mcp";

const EXPECTED_COPILOT_MCP_COMMAND = EXPECTED_MCP_COMMAND;

describe("agentmemory connect — dispatcher", () => {
  it("resolves every known agent by lowercase name", () => {
    for (const name of knownAgents()) {
      const a = resolveAdapter(name);
      expect(a, `expected adapter for ${name}`).not.toBeNull();
      expect(a!.name).toBe(name);
    }
  });

  it("resolves case-insensitively", () => {
    expect(resolveAdapter("Claude-Code")?.name).toBe("claude-code");
    expect(resolveAdapter("CURSOR")?.name).toBe("cursor");
  });

  it("returns null for unknown agents", () => {
    expect(resolveAdapter("nonexistent-agent")).toBeNull();
    expect(resolveAdapter("")).toBeNull();
  });

  it("ships the supported agent list", () => {
    expect(knownAgents().sort()).toEqual(
      [
        "antigravity",
        "claude-code",
        "cline",
        "copilot-cli",
        "codex",
        "continue",
        "cursor",
        "droid",
        "gemini-cli",
        "hermes",
        "kiro",
        "opencode",
        "openclaw",
        "openhuman",
        "pi",
        "qwen",
        "warp",
        "zed",
      ].sort(),
    );
    expect(ADAPTERS.length).toBe(18);
  });

  it("every adapter exposes detect() and install()", () => {
    for (const a of ADAPTERS) {
      expect(typeof a.detect).toBe("function");
      expect(typeof a.install).toBe("function");
      expect(typeof a.name).toBe("string");
      expect(typeof a.displayName).toBe("string");
    }
  });

  it("every adapter declares a category so onboarding never needs a separate list (#872)", () => {
    for (const a of ADAPTERS) {
      expect(
        ["native", "mcp"].includes(a.category as string),
        `adapter ${a.name} must set category to "native" or "mcp"`,
      ).toBe(true);
    }
  });
});

describe("agentmemory connect — claude-code adapter (mock filesystem)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "am-connect-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined)
      process.env["USERPROFILE"] = originalUserprofile;
    else delete process.env["USERPROFILE"];
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  async function loadAdapter(): Promise<ConnectAdapter> {
    const mod = await import("../src/cli/connect/claude-code.js?t=" + Date.now());
    return (mod as { adapter: ConnectAdapter }).adapter;
  }

  it("detect() returns false when ~/.claude doesn't exist", async () => {
    const a = await loadAdapter();
    expect(a.detect()).toBe(false);
  });

  it("install() writes mcpServers.agentmemory into ~/.claude.json and is idempotent", async () => {
    const claudeDir = join(tmpHome, ".claude");
    require("node:fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );

    const a = await loadAdapter();
    expect(a.detect()).toBe(true);

    const first = await a.install({ dryRun: false, force: false });
    expect(first.kind).toBe("installed");

    const config = JSON.parse(readFileSync(join(tmpHome, ".claude.json"), "utf-8"));
    expect(config.mcpServers.agentmemory.command).toBe(EXPECTED_MCP_COMMAND.command);
    expect(config.mcpServers.agentmemory.args).toEqual(EXPECTED_MCP_COMMAND.args);
    expect(config.mcpServers.agentmemory.args.join(" ")).toContain(MCP_MARKER);
    expect(config.mcpServers.other.command).toBe("x");

    const second = await a.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
  });

  it("install() writes env passthrough block for AGENTMEMORY_URL + AGENTMEMORY_SECRET (#375)", async () => {
    // Remote deployments (k8s, reverse proxy) set AGENTMEMORY_URL +
    // AGENTMEMORY_SECRET in the shell. The wired MCP entry must honour
    // those via ${VAR} expansion so a single entry covers both local
    // and remote without the user needing to add a duplicate config
    // that triggers a /doctor duplicate-server warning.
    const claudeDir = join(tmpHome, ".claude");
    require("node:fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(tmpHome, ".claude.json"), JSON.stringify({}));

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(readFileSync(join(tmpHome, ".claude.json"), "utf-8"));
    const entry = config.mcpServers.agentmemory;
    expect(entry.env).toBeDefined();
    // env interpolation must carry a default so Claude Code
    // doesn't silently drop the server when the user hasn't exported
    // AGENTMEMORY_URL / AGENTMEMORY_SECRET. Defaults match the
    // documented runtime (localhost:3111, no auth, all tools).
    expect(entry.env.AGENTMEMORY_URL).toBe(
      "${AGENTMEMORY_URL:-http://localhost:3111}",
    );
    expect(entry.env.AGENTMEMORY_SECRET).toBe("${AGENTMEMORY_SECRET:-}");
    expect(entry.env.AGENTMEMORY_TOOLS).toBe("${AGENTMEMORY_TOOLS:-all}");
  });

  it("install() with --force re-writes even when already wired", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          agentmemory: { command: "npx", args: ["-y", "@agentmemory/mcp"] },
        },
      }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: true });
    expect(result.kind).toBe("installed");
  });

  it("install() with --dry-run does not mutate the file", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const before = JSON.stringify({ mcpServers: {} });
    writeFileSync(join(tmpHome, ".claude.json"), before);

    const a = await loadAdapter();
    const result = await a.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");

    const after = readFileSync(join(tmpHome, ".claude.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("install() creates a backup file under ~/.agentmemory/backups/", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: {} }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(result.backupPath!).toContain(join(".agentmemory", "backups"));
    }
  });
});

describe("agentmemory connect — opencode adapter (#872)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "am-opencode-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined)
      process.env["USERPROFILE"] = originalUserprofile;
    else delete process.env["USERPROFILE"];
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  const cfgPath = () =>
    join(tmpHome, ".config", "opencode", "opencode.json");

  async function loadOpencode(): Promise<ConnectAdapter> {
    const mod = await import("../src/cli/connect/opencode.js?t=" + Date.now());
    return (mod as { adapter: ConnectAdapter }).adapter;
  }

  it("writes the opencode `mcp` schema (command as array) and preserves other servers", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".config", "opencode"), {
      recursive: true,
    });
    writeFileSync(
      cfgPath(),
      JSON.stringify({ mcp: { other: { type: "local", command: ["x"] } } }),
    );

    const a = await loadOpencode();
    expect(a.name).toBe("opencode");
    expect(a.detect()).toBe(true);

    const first = await a.install({ dryRun: false, force: false });
    expect(first.kind).toBe("installed");

    const config = JSON.parse(readFileSync(cfgPath(), "utf-8"));
    const entry = config.mcp.agentmemory;
    expect(entry.type).toBe("local");
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command.join(" ")).toContain(MCP_MARKER);
    expect(entry.enabled).toBe(true);
    expect(config.mcp.other.command).toEqual(["x"]);

    const second = await a.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
  });

  it("dry-run does not mutate the file", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".config", "opencode"), {
      recursive: true,
    });
    const before = JSON.stringify({ mcp: {} });
    writeFileSync(cfgPath(), before);

    const a = await loadOpencode();
    const result = await a.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
  });
});

describe("agentmemory connect — copilot-cli adapter (mock filesystem)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalCopilotHome: string | undefined;
  let importCounter = 0;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "am-connect-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    originalCopilotHome = process.env["COPILOT_HOME"];
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    delete process.env["COPILOT_HOME"];
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined)
      process.env["USERPROFILE"] = originalUserprofile;
    else delete process.env["USERPROFILE"];
    if (originalCopilotHome !== undefined)
      process.env["COPILOT_HOME"] = originalCopilotHome;
    else delete process.env["COPILOT_HOME"];
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  async function loadAdapter(): Promise<ConnectAdapter> {
    const mod = await import(
      "../src/cli/connect/copilot-cli.js?t=" + Date.now() + "-" + importCounter++
    );
    return (mod as { adapter: ConnectAdapter }).adapter;
  }

  it("detect() returns false when ~/.copilot doesn't exist", async () => {
    const a = await loadAdapter();
    expect(a.detect()).toBe(false);
  });

  it("install() writes mcpServers.agentmemory into ~/.copilot/mcp-config.json and is idempotent", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });

    const a = await loadAdapter();
    expect(a.detect()).toBe(true);

    const first = await a.install({ dryRun: false, force: false });
    expect(first.kind).toBe("installed");

    const config = JSON.parse(
      readFileSync(join(tmpHome, ".copilot", "mcp-config.json"), "utf-8"),
    );
    expect(config.mcpServers.agentmemory).toEqual({
      type: "local",
      ...EXPECTED_COPILOT_MCP_COMMAND,
      env: {
        AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
        AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
        AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
      },
      tools: ["*"],
    });

    const second = await a.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
  });

  it("honors COPILOT_HOME when locating mcp-config.json", async () => {
    const customCopilotHome = join(tmpHome, "custom-copilot-home");
    process.env["COPILOT_HOME"] = customCopilotHome;
    require("node:fs").mkdirSync(customCopilotHome, { recursive: true });

    const a = await loadAdapter();
    expect(a.detect()).toBe(true);

    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    expect(result.mutatedPath).toBe(join(customCopilotHome, "mcp-config.json"));
    expect(existsSync(join(customCopilotHome, "mcp-config.json"))).toBe(true);
    expect(existsSync(join(tmpHome, ".copilot", "mcp-config.json"))).toBe(false);
  });

  it("install() preserves unrelated top-level keys and mcpServers entries", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".copilot", "mcp-config.json"),
      JSON.stringify({
        otherTopLevel: { keep: true },
        mcpServers: { other: { type: "local", command: "other" } },
      }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(
      readFileSync(join(tmpHome, ".copilot", "mcp-config.json"), "utf-8"),
    );
    expect(config.otherTopLevel).toEqual({ keep: true });
    expect(config.mcpServers.other).toEqual({ type: "local", command: "other" });
    expect(config.mcpServers.agentmemory.command).toBe(
      EXPECTED_COPILOT_MCP_COMMAND.command,
    );
  });

  it("install() writes env passthrough block for AGENTMEMORY_URL + AGENTMEMORY_SECRET", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(
      readFileSync(join(tmpHome, ".copilot", "mcp-config.json"), "utf-8"),
    );
    const entry = config.mcpServers.agentmemory;
    expect(entry.env.AGENTMEMORY_URL).toBe(
      "${AGENTMEMORY_URL:-http://localhost:3111}",
    );
    expect(entry.env.AGENTMEMORY_SECRET).toBe("${AGENTMEMORY_SECRET:-}");
    expect(entry.env.AGENTMEMORY_TOOLS).toBe("${AGENTMEMORY_TOOLS:-all}");
  });

  it("install() with --force rewrites even when already wired", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".copilot", "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          agentmemory: {
            type: "local",
            ...EXPECTED_COPILOT_MCP_COMMAND,
            env: {
              AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
              AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
              AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
            },
            tools: ["memory_save"],
          },
        },
      }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: true });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(
      readFileSync(join(tmpHome, ".copilot", "mcp-config.json"), "utf-8"),
    );
    expect(config.mcpServers.agentmemory.tools).toEqual(["*"]);
  });

  it("install() with --dry-run does not mutate the file", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });
    const before = JSON.stringify({ mcpServers: {} });
    writeFileSync(join(tmpHome, ".copilot", "mcp-config.json"), before);

    const a = await loadAdapter();
    const result = await a.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");

    const after = readFileSync(
      join(tmpHome, ".copilot", "mcp-config.json"),
      "utf-8",
    );
    expect(after).toBe(before);
  });

  it("install() creates a backup file when config pre-exists", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".copilot", "mcp-config.json"),
      JSON.stringify({ mcpServers: {} }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(result.backupPath!).toContain(join(".agentmemory", "backups"));
    }
  });
});

describe("agentmemory connect — stub adapters log + return stub", () => {
  it("hermes adapter returns stub regardless of detect", async () => {
    const { adapter } = await import("../src/cli/connect/hermes.js");
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("stub");
  });

  it("openhuman adapter returns stub", async () => {
    const { adapter } = await import("../src/cli/connect/openhuman.js");
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("stub");
  });

  it("pi adapter returns stub", async () => {
    const { adapter } = await import("../src/cli/connect/pi.js");
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("stub");
  });
});

// Windows portability. `connect` used to refuse to run on win32 entirely,
// with copilot-cli as its single exception, and the docs told Windows
// users to install under WSL2. The adapters were always portable (plain
// node:fs/node:path/homedir); what was NOT portable was the shared MCP
// command shape.
describe("MCP command is Windows-safe on every adapter", () => {
  it("prefers this build's own MCP server over the registry copy", async () => {
    const { agentmemoryMcpCommand, localMcpServerPath } = await import(
      "../src/cli/connect/util.js"
    );
    const cmd = agentmemoryMcpCommand();

    if (HAS_LOCAL_MCP) {
      // Pointing at the shipped file means the wired agents run the same
      // code as the installed package, with no network fetch and nothing
      // an upstream publish can swap out underneath them.
      expect(localMcpServerPath()).toBe(LOCAL_MCP);
      expect(cmd.command).toBe("node");
      expect(cmd.args).toEqual([LOCAL_MCP]);
      // `node` is a real executable on Windows, unlike `npx`, so there is
      // no shim to orphan and no cmd.exe wrapper needed.
      expect(cmd.args.join(" ")).not.toContain("npx");
    } else {
      expect(cmd.args.join(" ")).toContain("@agentmemory/mcp@");
    }
  });

  it("falls back to a VERSION-PINNED registry spec, never floating latest", async () => {
    const { agentmemoryMcpCommand } = await import("../src/cli/connect/util.js");
    const cmd = agentmemoryMcpCommand();
    const argv = [cmd.command, ...cmd.args].join(" ");

    // An unpinned "@agentmemory/mcp" resolves to whatever is latest at
    // spawn time, so a future upstream publish would silently replace the
    // shim on the next npx cache miss. Whichever branch we are on, the
    // bare unpinned spec must never appear.
    expect(argv).not.toMatch(/@agentmemory\/mcp(\s|$)/);
  });

  it("still wraps npx in an explicit cmd.exe when it has to use the registry", async () => {
    const { agentmemoryMcpCommand } = await import("../src/cli/connect/util.js");
    const cmd = agentmemoryMcpCommand();
    if (HAS_LOCAL_MCP) return; // local path needs no shell wrapper

    if (process.platform === "win32") {
      // cmd.exe must be a DIRECT child. A bare "npx" is still run via
      // cmd.exe by the client, but as an implicit grandchild that no Job
      // Object owns — so the node process survives client exit and leaks
      // a port-holding orphan.
      expect(cmd.command.toLowerCase()).toContain("cmd");
      expect(cmd.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    } else {
      expect(cmd.command).toBe("npx");
    }
  });

  it("uses the same command for the shared block and the Copilot block", async () => {
    const { AGENTMEMORY_MCP_BLOCK, AGENTMEMORY_COPILOT_MCP_BLOCK } = await import(
      "../src/cli/connect/util.js"
    );
    // Copilot was the only Windows-safe adapter; the fix is that its
    // shape is now the shared one, not a special case.
    expect(AGENTMEMORY_MCP_BLOCK.command).toBe(AGENTMEMORY_COPILOT_MCP_BLOCK.command);
    expect(AGENTMEMORY_MCP_BLOCK.args).toEqual(AGENTMEMORY_COPILOT_MCP_BLOCK.args);
  });
});

describe("already-wired detection survives the command change", () => {
  it("recognises both the bare-npx and cmd.exe-wrapped shapes", async () => {
    const { isAgentmemoryMcpEntry } = await import("../src/cli/connect/util.js");

    // A config written on macOS then synced to Windows (or the reverse)
    // must still read as wired. Matching only the current platform's
    // shape would rewrite the file on every run and never report
    // "already-wired" — churn that looks like success.
    expect(isAgentmemoryMcpEntry({ command: "npx", args: ["-y", "@agentmemory/mcp"] })).toBe(true);
    expect(
      isAgentmemoryMcpEntry({
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "npx", "-y", "@agentmemory/mcp"],
      }),
    ).toBe(true);
    expect(
      isAgentmemoryMcpEntry({
        command: "C:\WINDOWS\system32\cmd.exe",
        args: ["/d", "/s", "/c", "npx", "-y", "@agentmemory/mcp"],
      }),
    ).toBe(true);
  });

  it("does not match unrelated servers or malformed entries", async () => {
    const { isAgentmemoryMcpEntry } = await import("../src/cli/connect/util.js");
    expect(isAgentmemoryMcpEntry({ command: "npx", args: ["-y", "some-other-mcp"] })).toBe(false);
    expect(isAgentmemoryMcpEntry({ command: "x" })).toBe(false);
    expect(isAgentmemoryMcpEntry(null)).toBe(false);
    expect(isAgentmemoryMcpEntry("npx @agentmemory/mcp")).toBe(false);
    // Substring match would wrongly accept a lookalike package.
    expect(
      isAgentmemoryMcpEntry({ command: "npx", args: ["-y", "@agentmemory/mcp-evil"] }),
    ).toBe(false);
  });
});
