import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import { VERSION } from "../../version.js";
import {
  AGENTMEMORY_MCP_BLOCK,
  isAgentmemoryMcpEntry,
  backupFile,
  logAlreadyWired,
  logBackup,
  logInstalled,
  readJsonSafe,
  writeJsonAtomic,
} from "./util.js";

// Continue.dev v1+ prefers ~/.continue/config.yaml; config.json is
// deprecated and ignored when yaml is present. Three branches:
//   - config.yaml exists → emit stub with manual edit instructions
//     (no YAML dep in tree; preserving comments/anchors safely needs it)
//   - config.json exists → modify it (legacy path still loaded when no yaml)
//   - neither → create config.yaml from scratch (no merge risk)
// Source: docs.continue.dev/reference/yaml-migration
const CONTINUE_DIR = join(homedir(), ".continue");
const YAML_PATH = join(CONTINUE_DIR, "config.yaml");
const JSON_PATH = join(CONTINUE_DIR, "config.json");

type ContinueEntry = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

type ContinueJsonConfig = {
  mcpServers?: ContinueEntry[];
  [key: string]: unknown;
};

function buildEntry(): ContinueEntry {
  return {
    name: "agentmemory",
    command: AGENTMEMORY_MCP_BLOCK.command,
    args: [...AGENTMEMORY_MCP_BLOCK.args],
    env: { ...AGENTMEMORY_MCP_BLOCK.env },
  };
}

// Name check stays local (Continue keys entries by `name`), but the
// command shape is delegated to the shared predicate. A private copy
// matching a literal "@agentmemory/mcp" stopped recognising this
// adapter's own output the moment the command shape changed, so every
// install failed its post-write verification.
function entryIsAgentmemory(entry: ContinueEntry | undefined): boolean {
  if (!entry) return false;
  return entry.name === "agentmemory" && isAgentmemoryMcpEntry(entry);
}

/**
 * Emit a YAML single-quoted scalar.
 *
 * Args can be absolute Windows paths. In a DOUBLE-quoted YAML scalar the
 * backslash is an escape character, so "X:\Projects\...\dist\standalone.mjs"
 * is both wrong and broken: \P and \a are valid escapes (paragraph
 * separator, bell) and silently corrupt the path, while \d and \s are not
 * valid escapes at all and fail the parse. Single-quoted scalars have no
 * escape processing — the only special case is a literal quote, written
 * by doubling it.
 */
function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Minimal YAML emitter for the agentmemory entry. Quotes string values
// that contain ${ ... } expansion to keep parsers happy. Only used when
// creating a fresh config.yaml, or when replacing a config.yaml we can
// prove we wrote ourselves — never when modifying a user-authored one.
/**
 * Arg quoting styles this emitter has used. Current output is always
 * "single"; "double" is retained ONLY so files written by earlier
 * versions are still recognised as self-generated. Drop it and every
 * previously-wired user gets "manual install required" on a file we
 * wrote ourselves.
 */
type ArgQuoting = "single" | "double";

function renderFreshYaml(
  command: string = AGENTMEMORY_MCP_BLOCK.command,
  args: readonly string[] = AGENTMEMORY_MCP_BLOCK.args,
  quoting: ArgQuoting = "single",
): string {
  const e = buildEntry();
  const envLines = Object.entries(e.env ?? {})
    .map(([k, v]) => `      ${k}: "${v}"`)
    .join("\n");
  const renderArg = (a: string) =>
    quoting === "single" ? yamlSingleQuoted(a) : `"${a}"`;
  return [
    "mcpServers:",
    `  - name: ${e.name}`,
    `    command: ${command}`,
    "    args:",
    ...args.map((a) => `      - ${renderArg(a)}`),
    "    env:",
    envLines,
    "",
  ].join("\n");
}

// Every command shape this emitter has ever produced. A config.yaml that
// matches one of these byte-for-byte contains nothing but our own block,
// so rewriting it destroys no user content — which is the only reason the
// yaml branch is allowed to write at all.
//
// The bare-npx entry is the pre-Windows-support shape. It still resolves,
// so it looks wired, but on Windows `npx` has no .exe — only npx.cmd — so
// the MCP client spawns an implicit cmd.exe grandchild that belongs to no
// Job Object and survives client exit. Users left on that shape accumulate
// orphaned node processes holding the port.
const COMSPEC = process.env["ComSpec"] || process.env["COMSPEC"] || "cmd.exe";

const GENERATED_SHAPES: ReadonlyArray<{ command: string; args: readonly string[] }> = [
  // Current: this build's own MCP server, invoked directly.
  { command: AGENTMEMORY_MCP_BLOCK.command, args: AGENTMEMORY_MCP_BLOCK.args },
  // Registry fallback, pinned and unpinned.
  { command: "npx", args: ["-y", `@agentmemory/mcp@${VERSION}`] },
  { command: "npx", args: ["-y", "@agentmemory/mcp"] },
  // Windows cmd.exe wrapper around each of those.
  { command: COMSPEC, args: ["/d", "/s", "/c", "npx", "-y", `@agentmemory/mcp@${VERSION}`] },
  { command: COMSPEC, args: ["/d", "/s", "/c", "npx", "-y", "@agentmemory/mcp"] },
];

function normalizeYaml(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Which of our generated shapes this file is, or null if the file has any
 * content we did not write. Comparison is exact (modulo line endings and
 * trailing newline): a single added comment or reordered key means a human
 * touched it, and we fall back to printing the manual-merge instructions.
 */
function matchGeneratedShape(content: string): { isCurrent: boolean } | null {
  const actual = normalizeYaml(content);
  const QUOTINGS: ArgQuoting[] = ["single", "double"];
  for (const [i, shape] of GENERATED_SHAPES.entries()) {
    for (const quoting of QUOTINGS) {
      const rendered = normalizeYaml(
        renderFreshYaml(shape.command, shape.args, quoting),
      );
      if (rendered === actual) {
        // Only the current command shape in the current quoting counts as
        // up to date; anything else is ours but stale, and gets rewritten.
        return { isCurrent: i === 0 && quoting === "single" };
      }
    }
  }
  return null;
}

export const adapter: ConnectAdapter = {
  name: "continue",
  displayName: "Continue",
  category: "mcp",
  docs: "https://github.com/rohitg00/agentmemory#other-agents",
  protocolNote:
    "→ Using MCP via ~/.continue/config.yaml (preferred) or config.json (legacy, only when no yaml).",

  detect(): boolean {
    return existsSync(CONTINUE_DIR);
  },

  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const yamlExists = existsSync(YAML_PATH);
    const jsonExists = existsSync(JSON_PATH);

    // Branch 1: yaml present — refuse to silently mutate user's yaml
    // config (preserving comments/anchors needs a proper parser), unless
    // the file is byte-identical to something this emitter produced.
    if (yamlExists) {
      const generated = matchGeneratedShape(readFileSync(YAML_PATH, "utf-8"));

      if (generated) {
        if (generated.isCurrent && !opts.force) {
          logAlreadyWired("Continue", YAML_PATH);
          return { kind: "already-wired", mutatedPath: YAML_PATH };
        }

        if (opts.dryRun) {
          p.log.info(
            `[dry-run] Would rewrite ${YAML_PATH} (agentmemory-generated, ${generated.isCurrent ? "refresh" : "outdated command shape"})`,
          );
          return { kind: "installed", mutatedPath: YAML_PATH };
        }

        const backupPath = backupFile(YAML_PATH, "continue", "yaml");
        logBackup(backupPath);
        writeFileSync(YAML_PATH, renderFreshYaml(), "utf-8");

        if (matchGeneratedShape(readFileSync(YAML_PATH, "utf-8"))?.isCurrent !== true) {
          p.log.error(
            `Verification failed: ${YAML_PATH} does not hold the expected agentmemory entry after write.`,
          );
          return { kind: "skipped", reason: "verification-failed" };
        }

        logInstalled("Continue", YAML_PATH);
        return { kind: "installed", mutatedPath: YAML_PATH, backupPath };
      }

      const indented = renderFreshYaml()
        .split("\n")
        .map((l) => (l ? `  ${l}` : l))
        .join("\n");
      const manual = `\nMerge this block into ~/.continue/config.yaml (the snippet already includes the top-level mcpServers key — if your config already has a mcpServers list, append the agentmemory entry to it instead of duplicating the key):\n\n${indented}`;
      p.log.info(
        `Continue: ${YAML_PATH} already exists. Manual edit needed.${manual}`,
      );
      return { kind: "stub", reason: "config.yaml-needs-manual-edit" };
    }

    // Branch 2: legacy json present — modify in place.
    if (jsonExists) {
      const existing = readJsonSafe<ContinueJsonConfig>(JSON_PATH);
      const next: ContinueJsonConfig = existing ? { ...existing } : {};
      const servers = Array.isArray(next.mcpServers)
        ? [...next.mcpServers]
        : [];

      const idx = servers.findIndex((s) => s?.name === "agentmemory");
      const alreadyHas = idx >= 0 && entryIsAgentmemory(servers[idx]);
      if (alreadyHas && !opts.force) {
        logAlreadyWired("Continue", JSON_PATH);
        return { kind: "already-wired", mutatedPath: JSON_PATH };
      }

      if (opts.dryRun) {
        p.log.info(
          `[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcpServers[agentmemory] in ${JSON_PATH}`,
        );
        return { kind: "installed", mutatedPath: JSON_PATH };
      }

      const backupPath = backupFile(JSON_PATH, "continue");
      logBackup(backupPath);

      const entry = buildEntry();
      if (idx >= 0) servers[idx] = entry;
      else servers.push(entry);
      next.mcpServers = servers;
      writeJsonAtomic(JSON_PATH, next);

      const verify = readJsonSafe<ContinueJsonConfig>(JSON_PATH);
      const verifyEntry = verify?.mcpServers?.find(
        (s) => s?.name === "agentmemory",
      );
      if (!entryIsAgentmemory(verifyEntry)) {
        p.log.error(
          `Verification failed: ${JSON_PATH} did not contain mcpServers[agentmemory] after write.`,
        );
        return { kind: "skipped", reason: "verification-failed" };
      }

      logInstalled("Continue (legacy config.json)", JSON_PATH);
      return {
        kind: "installed",
        mutatedPath: JSON_PATH,
        backupPath,
      };
    }

    // Branch 3: neither exists — create config.yaml from scratch (modern path).
    if (opts.dryRun) {
      p.log.info(`[dry-run] Would create ${YAML_PATH} with agentmemory entry`);
      return { kind: "installed", mutatedPath: YAML_PATH };
    }

    mkdirSync(dirname(YAML_PATH), { recursive: true });
    writeFileSync(YAML_PATH, renderFreshYaml(), "utf-8");
    logInstalled("Continue", YAML_PATH);
    return { kind: "installed", mutatedPath: YAML_PATH };
  },
};
