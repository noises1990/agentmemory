import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_URL = "http://localhost:3111";
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_000;
const CALL_TIMEOUT_MS = 15_000;
const LOCAL_MODE_TTL_MS = 30_000;
// A configured-remote probe failure is a hard error, but we must not re-probe
// on every single tool call while the daemon is down. Cache the failure for a
// few seconds only — long enough to avoid hammering, short enough that the
// shim recovers on its own once the daemon is reachable again (no process
// restart required).
const REMOTE_FAILURE_TTL_MS = 3_000;

function probeTimeoutMs(): number {
  const raw = process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"];
  if (!raw) return DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
}

function forceProxy(): boolean {
  const raw = process.env["AGENTMEMORY_FORCE_PROXY"];
  return raw === "1" || raw === "true";
}

export interface ProxyHandle {
  mode: "proxy";
  baseUrl: string;
  call: (path: string, init?: RequestInit) => Promise<unknown>;
}

export interface LocalHandle {
  mode: "local";
}

export type Handle = ProxyHandle | LocalHandle;

let cached: Handle | null = null;
let cachedAt = 0;
let probeInFlight: Promise<Handle> | null = null;
// Negative result for the configured-remote path. Deliberately NOT a `Handle`:
// there is no usable handle when a configured remote is down, only an error to
// re-raise until the short TTL expires and we re-probe.
let remoteFailure: { at: number; message: string } | null = null;

// `${VAR}`-style placeholders ship in plugin/.mcp.json so MCP hosts that
// expand them (Claude Code, Cursor) substitute the user's shell value.
// Hosts that DON'T expand pass the literal string `"${AGENTMEMORY_URL}"`
// through to our subprocess — that string is truthy, defeats the `||`
// fallback, and would have us POST to `${AGENTMEMORY_URL}/agentmemory/...`
// (DNS failure). Strip any literal placeholder we see so the fallback
// engages instead.
export function resolveEnvOrEmpty(name: string): string {
  const raw = process.env[name];
  if (!raw) return "";
  if (raw.startsWith("${") && raw.endsWith("}")) return "";
  return raw;
}

function baseUrl(): string {
  return (resolveEnvOrEmpty("AGENTMEMORY_URL") || DEFAULT_URL).replace(/\/+$/, "");
}

/**
 * True when AGENTMEMORY_URL names a host that is NOT this machine.
 *
 * The distinction drives the silent-fallback policy: pointing the shim at a
 * real deployment is an explicit statement that memory lives *there*, so
 * quietly swapping in a process-local InMemoryKV would throw writes away and
 * answer reads with `[]` while looking healthy. The zero-config localhost case
 * is different — there the fallback is the documented "no daemon yet" path.
 *
 * Unset (or an unexpanded `${AGENTMEMORY_URL}` placeholder) counts as local:
 * baseUrl() resolves those to http://localhost:3111.
 */
export function isConfiguredRemote(): boolean {
  const raw = resolveEnvOrEmpty("AGENTMEMORY_URL");
  if (!raw) return false;
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    // Explicitly configured but unparseable — treat as remote so the operator
    // gets a loud error instead of a silent demotion to local KV.
    return true;
  }
  // Node returns IPv6 hostnames bracketed: new URL("http://[::1]").hostname === "[::1]"
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
}

/**
 * Reads the daemon bearer from Windows Credential Manager when the environment
 * does not carry it.
 *
 * Why: an MCP host does not hand a stdio server its own environment. Claude Code
 * passes only the server's configured `env` plus a short default set, and strips
 * anything whose name looks like a credential (TOKEN, SECRET, KEY, AUTH) -- so
 * AGENTMEMORY_SECRET can never arrive by inheritance, and `${VAR}` expansion in
 * the config only works in project-scoped .mcp.json. Every launcher on this
 * platform already treats the vault as the authoritative copy (credstore.ps1),
 * so the shim reads the same entry. The value crosses one pipe into memory and
 * is never an argument or a file.
 *
 * Deliberately narrow: only when the variable is absent, only on win32, only
 * this one entry. A vault miss is reported once on stderr and then the daemon's
 * 401 stays as loud as it is today -- nothing here turns a missing credential
 * into a quiet empty answer.
 */
const VAULT_ENTRY = "agentmemory-api-token";
let vaultSecret: string | null | undefined;
let vaultReader: (() => string | null) | null = null;

/** Tests swap the PowerShell read for a stub. */
export function setVaultReaderForTests(reader: (() => string | null) | null): void {
  vaultReader = reader;
  vaultSecret = undefined;
}

function readVaultSecret(): string | null {
  if (vaultSecret !== undefined) return vaultSecret;
  if (vaultReader) {
    vaultSecret = vaultReader();
    return vaultSecret;
  }
  if (process.platform !== "win32") {
    vaultSecret = null;
    return null;
  }
  const script = join(homedir(), ".agentmemory", "scripts", "credstore.ps1");
  if (!existsSync(script)) {
    vaultSecret = null;
    return null;
  }
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Get", "-Name", VAULT_ENTRY],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  const lines = result.status === 0 ? result.stdout.trim().split(/\r?\n/) : [];
  const value = (lines[lines.length - 1] ?? "").trim();
  if (!value) {
    process.stderr.write(
      `[@agentmemory/mcp] AGENTMEMORY_SECRET is not in the environment and the vault entry ` +
        `'${VAULT_ENTRY}' could not be read (${result.status === 0 ? "empty" : `credstore exit ${result.status}`}); ` +
        `requests will carry no bearer and the server will refuse them.\n`,
    );
    vaultSecret = null;
    return null;
  }
  process.stderr.write(
    `[@agentmemory/mcp] AGENTMEMORY_SECRET not in the environment; using Windows Credential Manager entry '${VAULT_ENTRY}'\n`,
  );
  vaultSecret = value;
  return value;
}

function authHeader(): Record<string, string> {
  const secret = resolveEnvOrEmpty("AGENTMEMORY_SECRET") || readVaultSecret() || "";
  return secret ? { authorization: `Bearer ${secret}` } : {};
}

/**
 * Probes the agentmemory server's livez endpoint. Returns a Response-shaped
 * object whose `ok` flag drives the proxy/local-fallback decision.
 *
 * Tests can swap this via {@link setLivezProbe} to avoid the real 2s
 * AbortController race that destabilises mcp-standalone test runs (#449).
 * Production callers should leave it on the default.
 */
export type LivezProbe = (
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
) => Promise<{ ok: boolean; status?: number; statusText?: string }>;

const defaultLivezProbe: LivezProbe = async (url, timeoutMs, headers) => {
  const res = await fetch(`${url}/agentmemory/livez`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status, statusText: res.statusText };
};

let livezProbe: LivezProbe = defaultLivezProbe;

/**
 * Override the livez probe. Intended for tests — production code should rely
 * on the default fetch-based probe. Calling without an argument restores the
 * default. Pair with {@link resetHandleForTests} so the cached handle is
 * dropped before the next call.
 */
export function setLivezProbe(fn?: LivezProbe): void {
  livezProbe = fn ?? defaultLivezProbe;
}

/**
 * Result of a livez probe. `reason` is populated on failure and is surfaced
 * verbatim to the caller on the configured-remote path, so it must name the
 * concrete cause (HTTP status or transport error).
 */
interface ProbeResult {
  ok: boolean;
  reason?: string;
}

async function probe(url: string): Promise<ProbeResult> {
  const timeout = probeTimeoutMs();
  try {
    const res = await livezProbe(url, timeout, authHeader());
    if (res.ok) return { ok: true };
    return {
      ok: false,
      reason: `HTTP ${res.status ?? "?"} ${res.statusText ?? ""}`.trim(),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `request failed in ${timeout}ms: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function remoteUnreachableMessage(url: string, reason: string): string {
  return (
    `[@agentmemory/mcp] agentmemory server at ${url} is unreachable — livez probe ${url}/agentmemory/livez ${reason}. ` +
    `AGENTMEMORY_URL is explicitly configured to a non-local host, so refusing to fall back to the in-process InMemoryKV: ` +
    `that fallback would accept writes into throwaway RAM and answer reads with empty results while looking healthy. ` +
    `Fix the server or network, then retry (the shim re-probes automatically — no restart needed). ` +
    `Set AGENTMEMORY_FORCE_PROXY=1 to skip the probe, or raise AGENTMEMORY_PROBE_TIMEOUT_MS if the probe is merely slow.`
  );
}

export function invalidateHandle(): void {
  cached = null;
  cachedAt = 0;
  remoteFailure = null;
}

export async function resolveHandle(): Promise<Handle> {
  const now = Date.now();
  if (remoteFailure) {
    if (now - remoteFailure.at < REMOTE_FAILURE_TTL_MS) {
      throw new Error(remoteFailure.message);
    }
    // TTL expired — drop the negative result and re-probe so a recovered
    // daemon is picked up without restarting the process.
    remoteFailure = null;
  }
  if (cached) {
    if (cached.mode === "local" && now - cachedAt >= LOCAL_MODE_TTL_MS) {
      cached = null;
      cachedAt = 0;
    } else {
      return cached;
    }
  }
  if (probeInFlight) return probeInFlight;
  const url = baseUrl();
  const skipProbe = forceProxy();
  probeInFlight = (async () => {
    const result: ProbeResult = skipProbe ? { ok: true } : await probe(url);
    const up = result.ok;
    if (!up) {
      const reason = result.reason ?? "failed for an unknown reason";
      if (isConfiguredRemote()) {
        // HARD ERROR: no InMemoryKV fallback on the configured-remote path.
        const message = remoteUnreachableMessage(url, reason);
        remoteFailure = { at: Date.now(), message };
        process.stderr.write(`${message}\n`);
        throw new Error(message);
      }
      // Zero-config / localhost: the documented fallback stays, and so does
      // the stderr warning that makes it diagnosable.
      process.stderr.write(
        `[@agentmemory/mcp] livez probe ${url}/agentmemory/livez failed: ${reason}; falling back to local InMemoryKV (set AGENTMEMORY_FORCE_PROXY=1 to skip the probe, or raise AGENTMEMORY_PROBE_TIMEOUT_MS)\n`,
      );
    }
    if (skipProbe) {
      process.stderr.write(
        `[@agentmemory/mcp] AGENTMEMORY_FORCE_PROXY set; skipping livez probe and trusting ${url}\n`,
      );
    }
    if (up) {
      const handle: ProxyHandle = {
        mode: "proxy",
        baseUrl: url,
        call: async (path, init) => {
          const res = await fetch(`${url}${path}`, {
            ...init,
            headers: {
              "content-type": "application/json",
              ...authHeader(),
              ...(init?.headers as Record<string, string> | undefined),
            },
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          });
          if (!res.ok) {
            throw new Error(
              `${init?.method || "GET"} ${path} -> ${res.status} ${res.statusText}`,
            );
          }
          const text = await res.text();
          return text ? JSON.parse(text) : null;
        },
      };
      cached = handle;
      cachedAt = Date.now();
      return handle;
    }
    const local: LocalHandle = { mode: "local" };
    cached = local;
    cachedAt = Date.now();
    return local;
  })();
  try {
    return await probeInFlight;
  } finally {
    probeInFlight = null;
  }
}

export function resetHandleForTests(): void {
  cached = null;
  cachedAt = 0;
  probeInFlight = null;
  remoteFailure = null;
  livezProbe = defaultLivezProbe;
}
