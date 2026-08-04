#!/usr/bin/env node
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
//#region src/hooks/pre-tool-use.ts
loadAgentMemoryEnv();
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	if (!INJECT_CONTEXT) return;
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
	const toolName = typeof data.tool_name === "string" ? data.tool_name : typeof data.toolName === "string" ? data.toolName : void 0;
	if (!toolName) return;
	const normalizedToolName = toolName.toLowerCase();
	if (![
		"edit",
		"write",
		"create",
		"read",
		"view",
		"glob",
		"grep"
	].includes(normalizedToolName)) return;
	const rawToolInput = data.tool_input ?? data.toolArgs;
	const toolInput = typeof rawToolInput === "object" && rawToolInput !== null && !Array.isArray(rawToolInput) ? rawToolInput : {};
	const files = [];
	const fileKeys = normalizedToolName === "grep" ? ["path", "file"] : [
		"file_path",
		"path",
		"file",
		"pattern"
	];
	for (const key of fileKeys) {
		const val = toolInput[key];
		if (typeof val === "string" && val.length > 0) files.push(val);
	}
	if (files.length === 0) return;
	const terms = [];
	if (normalizedToolName === "grep" || normalizedToolName === "glob") {
		const pattern = toolInput["pattern"];
		if (typeof pattern === "string" && pattern.length > 0) terms.push(pattern);
	}
	const rawSessionId = data.session_id || data.sessionId;
	const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : "unknown";
	const project = typeof data.project === "string" && data.project.trim().length > 0 ? data.project.trim() : void 0;
	try {
		const res = await fetch(`${REST_URL}/agentmemory/enrich`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				files,
				terms,
				toolName,
				...project !== void 0 && { project }
			}),
			signal: AbortSignal.timeout(2e3)
		});
		if (res.ok) {
			const result = await res.json();
			if (result.context) process.stdout.write(result.context);
		}
	} catch {}
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=pre-tool-use.mjs.map