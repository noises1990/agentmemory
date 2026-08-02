import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";

// Env values use ${VAR:-default} expansion so the wired MCP entry
// inherits AGENTMEMORY_URL / AGENTMEMORY_SECRET / AGENTMEMORY_TOOLS
// from the user's shell, but never fails parse when the var is unset
// (#510). Earlier `${VAR}` form caused Claude Code to silently drop the
// server when no shell-level export existed — per the Claude Code MCP
// docs, "If a required environment variable is not set and has no
// default value, Claude Code will fail to parse the config."
//
// Defaults match the documented runtime: localhost:3111 (no auth, all
// tools). One wired entry now serves local AND remote (Kubernetes /
// reverse-proxied) deployments without doctor-warning duplicates (#375)
// AND fresh installs that haven't exported envs (#510).
// Windows has no `npx` executable — only `npx.cmd` / `npx.ps1` shims. A
// bare "npx" command therefore gets resolved by the client through
// cmd.exe anyway, but as an implicit grandchild that no Job Object owns:
// when the MCP client exits, the shim dies and the real `node` process
// is orphaned, still holding its stdio pipes. Repeated client restarts
// pile these up (we found 30 live orphans on one machine).
//
// Spawning cmd.exe EXPLICITLY makes the shell the direct child, so the
// client's process handle covers the whole tree. `/d` skips AutoRun
// registry commands, `/s` fixes quote handling, `/c` runs and exits.
//
// This was already the shape used for Copilot CLI, which is precisely
// why `connect` allowed copilot-cli as its sole exception on Windows.
// Applying it to the shared block is what makes every other adapter
// safe to wire here.
export function agentmemoryMcpCommand(): {
  command: string;
  args: string[];
} {
  if (process.platform === "win32") {
    return {
      command: process.env["ComSpec"] || process.env["COMSPEC"] || "cmd.exe",
      args: ["/d", "/s", "/c", "npx", "-y", "@agentmemory/mcp"],
    };
  }
  return { command: "npx", args: ["-y", "@agentmemory/mcp"] };
}

// Recognises an already-wired agentmemory entry in EITHER shape. Matching
// only the current platform's shape would make a Windows `connect`
// rewrite a POSIX-authored config (and vice versa) on every run, and
// report "installed" when it had really just churned the file. Keyed on
// the package name in argv rather than on the command, since the command
// is now platform-dependent.
export function isAgentmemoryMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  const command = typeof e["command"] === "string" ? e["command"] : "";
  const args = Array.isArray(e["args"]) ? (e["args"] as unknown[]) : [];
  const argv = [command, ...args].filter(
    (a): a is string => typeof a === "string",
  );
  return argv.some((a) => a === "@agentmemory/mcp");
}

export const AGENTMEMORY_MCP_BLOCK = {
  ...agentmemoryMcpCommand(),
  env: {
    AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
    AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
    AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
  },
};

export const AGENTMEMORY_COPILOT_MCP_BLOCK = {
  type: "local" as const,
  ...agentmemoryMcpCommand(),
  env: {
    AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
    AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
    AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
  },
  tools: ["*"],
};

export function backupsDir(): string {
  return join(homedir(), ".agentmemory", "backups");
}

export function ensureBackupsDir(): string {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function backupFile(
  sourcePath: string,
  agent: string,
  ext = "json",
): string {
  ensureBackupsDir();
  const stamp = timestampSlug();
  const target = join(backupsDir(), `${agent}-${stamp}.${ext}`);
  copyFileSync(sourcePath, target);
  return target;
}

export function readJsonSafe<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function logInstalled(label: string, target: string): void {
  p.log.success(`${label} → wired into ${target}`);
}

export function logAlreadyWired(label: string, target: string): void {
  p.log.info(`${label} already wired in ${target} (use --force to re-install)`);
}

export function logBackup(target: string): void {
  p.log.info(`Backup: ${target}`);
}
