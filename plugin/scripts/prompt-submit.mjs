#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
//#region src/utils/env-file.ts
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
const ENV_FILE = join(homedir(), ".agentmemory", ".env");
/** Parse .env text into a map. No process.env access, no I/O — testable. */
function parseEnvText(content) {
	const vars = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		const quoteChar = val[0] === "\"" || val[0] === "'" ? val[0] : "";
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
function readEnvFile(path = ENV_FILE) {
	if (!existsSync(path)) return {};
	try {
		return parseEnvText(readFileSync(path, "utf-8"));
	} catch {
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
function loadAgentMemoryEnv(path = ENV_FILE) {
	const fileEnv = readEnvFile(path);
	for (const [key, value] of Object.entries(fileEnv)) if (process.env[key] === void 0) process.env[key] = value;
}
//#endregion
//#region src/hooks/_project.ts
/**
* Find the repository root by walking up for a `.git` entry.
*
* This replaced `git rev-parse --show-toplevel`, which was spawned with a
* 500ms timeout on EVERY hook invocation — and hooks run on every tool
* call. Process spawn on Windows costs a large fraction of that budget
* before git does any work, so on a loaded machine the call timed out,
* the catch swallowed it, and resolution silently fell through to
* basename(cwd). For a nested cwd that means observations were filed
* under "hooks" instead of "agentmemory", fragmenting a project's memory
* across directory names under load — the exact condition where you are
* least likely to notice.
*
* The walk answers the same question with a few stat() calls and no
* subprocess, so there is no timeout left to lose. `.git` is a directory
* in a normal clone and a file in a worktree or submodule; either way the
* directory containing it is the toplevel, which is what git reports.
*/
function findRepoRoot(startDir) {
	let dir = resolve(startDir);
	for (let i = 0; i < 64; i++) {
		if (existsSync(resolve(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const root = findRepoRoot(dir);
		if (root) return basename(root);
	} catch {}
	return basename(dir);
}
//#endregion
//#region src/hooks/prompt-submit.ts
loadAgentMemoryEnv();
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object") return;
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || "unknown";
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "prompt_submit",
			sessionId,
			project: resolveProject(data.cwd),
			cwd: data.cwd || process.cwd(),
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: { prompt: data.prompt ?? data.userPrompt }
		}),
		signal: AbortSignal.timeout(3e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=prompt-submit.mjs.map