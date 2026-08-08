#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
//#region src/hooks/session-end.ts
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
/**
* argv token that puts a re-exec of this script into dispatch mode.
*
* SessionEnd is the only hook event Claude Code fires while it is tearing the
* CLI down, and it does not wait for the hook to finish — it aborts the child,
* which the user sees as `SessionEnd hook [...] failed: Hook cancelled`. The
* previous shape of this hook fired the REST calls and then held the process
* open ~1.5s so Node could flush the sockets, which put it squarely inside
* that abort window every single time. (`stop.ts` has the identical shape and
* is never cancelled, because Stop fires mid-session with the CLI still alive.)
*
* So the work moves to a detached grandchild that outlives the teardown, and
* the hook itself exits as soon as the spawn is handed to libuv — well under
* the abort. Measured on Windows: the requests need ~100ms of process life to
* reach the daemon (a SIGKILL at 20ms loses them, at 100ms they land), and the
* detached child is no longer racing anything for that time.
*/
const DISPATCH_FLAG = "--agentmemory-dispatch";
/**
* Fire every session-end REST call. Returns the in-flight promises so the
* caller decides whether to await them (dispatch mode) or merely let the
* process linger long enough to flush them (fallback).
*
* Each call carries its own AbortSignal.timeout, so none can hang forever.
*/
function fireAll(sessionId) {
	const calls = [fetch(`${REST_URL}/agentmemory/session/end`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ sessionId }),
		signal: AbortSignal.timeout(3e4)
	}).catch(() => {})];
	if (process.env["CONSOLIDATION_ENABLED"] === "true") {
		calls.push(fetch(`${REST_URL}/agentmemory/crystals/auto`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ olderThanDays: 0 }),
			signal: AbortSignal.timeout(6e4)
		}).catch(() => {}));
		calls.push(fetch(`${REST_URL}/agentmemory/consolidate-pipeline`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				tier: "all",
				force: true
			}),
			signal: AbortSignal.timeout(12e4)
		}).catch(() => {}));
	}
	if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") calls.push(fetch(`${REST_URL}/agentmemory/claude-bridge/sync`, {
		method: "POST",
		headers: authHeaders(),
		signal: AbortSignal.timeout(3e4)
	}).catch(() => {}));
	return calls;
}
/**
* Re-exec this same file, detached, to do the REST work after the hook exits.
*
* `detached` + `stdio: "ignore"` + `unref()` is what lets it survive the CLI
* teardown that cancels the hook. `windowsHide` keeps a console window from
* flashing on every session end on Windows.
*
* Spawn failure surfaces asynchronously as an `error` event, not a throw, so
* `onFailure` re-arms the old inline path rather than losing the calls
* silently. We never call process.exit() here: letting the loop drain
* naturally exits in the same tick when the spawn took (the child is unref'd)
* while still leaving room for that error event to be delivered.
*/
function spawnDispatcher(sessionId, onFailure) {
	const self = fileURLToPath(import.meta.url);
	const payload = Buffer.from(JSON.stringify({ sessionId }), "utf-8").toString("base64");
	const child = spawn(process.execPath, [
		self,
		DISPATCH_FLAG,
		payload
	], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: process.env
	});
	child.on("error", onFailure);
	child.unref();
}
/** Old behaviour: fire and hold the process open long enough to flush. */
function fireInline(sessionId) {
	fireAll(sessionId);
	setTimeout(() => process.exit(0), 1500).unref();
}
function decodeDispatchPayload(encoded) {
	try {
		return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"))?.sessionId || "unknown";
	} catch {
		return "unknown";
	}
}
async function main() {
	const flagIdx = process.argv.indexOf(DISPATCH_FLAG);
	if (flagIdx !== -1) {
		setTimeout(() => process.exit(0), 15e4).unref();
		await Promise.allSettled(fireAll(decodeDispatchPayload(process.argv[flagIdx + 1] ?? "")));
		return;
	}
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
	spawnDispatcher(sessionId, () => fireInline(sessionId));
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=session-end.mjs.map