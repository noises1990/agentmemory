import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Parsing for ~/.agentmemory/.env, shared by the daemon and the hooks.
 *
 * This lived only in config.ts, which the daemon loads and the hooks do not.
 * Hooks are standalone bundles spawned by Claude Code, so they inherit the OS
 * environment and nothing else — any hook gating behaviour on an env var read
 * the .env value as `undefined` and silently took the disabled branch. That is
 * how session-end's crystallisation and Claude-bridge calls were dead while the
 * daemon's timer-driven consolidation ran fine off the same file.
 *
 * Both callers must agree on the parse, or the daemon and a hook can disagree
 * about a value — a subtler bug than the one this fixes. Hence one module, not
 * a second copy. Kept free of non-node imports so pulling it into a hook bundle
 * costs nothing.
 */

export const ENV_FILE = join(homedir(), ".agentmemory", ".env");

/** Parse .env text into a map. No process.env access, no I/O — testable. */
export function parseEnvText(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    const quoteChar = val[0] === '"' || val[0] === "'" ? val[0] : "";
    if (quoteChar) {
      const closeIdx = val.indexOf(quoteChar, 1);
      if (closeIdx !== -1) val = val.slice(1, closeIdx);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    vars[key] = val;
  }
  return vars;
}

/**
 * Read and parse ~/.agentmemory/.env. Returns {} when absent or unreadable.
 *
 * Deliberately uncached: config.ts calls this per getEnvVar(), so a running
 * daemon picks up edits to .env without a restart. Caching here would change
 * that behaviour silently.
 */
export function readEnvFile(path: string = ENV_FILE): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseEnvText(readFileSync(path, "utf-8"));
  } catch {
    // An unreadable .env must not take a hook down; the caller falls back to
    // the OS environment exactly as it did before this module existed.
    return {};
  }
}

/**
 * Merge ~/.agentmemory/.env into process.env for hook processes.
 *
 * The OS environment wins on conflict, matching config.ts's
 * `{...fileEnv, ...process.env}` precedence — an explicitly exported variable
 * must keep overriding the file in both the daemon and the hooks.
 *
 * Call this at the top of a hook's module body, above any module-scope const
 * that reads process.env.
 */
export function loadAgentMemoryEnv(path: string = ENV_FILE): void {
  const fileEnv = readEnvFile(path);
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
