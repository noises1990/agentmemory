#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
//#region src/hooks/notification.ts
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
	const notificationType = data.notification_type ?? data.notificationType;
	if (notificationType !== "permission_prompt") return;
	const rawSessionId = data.session_id ?? data.sessionId;
	const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : "unknown";
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "notification",
			sessionId,
			project: resolveProject(data.cwd),
			cwd: data.cwd || process.cwd(),
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				notification_type: notificationType,
				title: data.title,
				message: data.message
			}
		}),
		signal: AbortSignal.timeout(2e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=notification.mjs.map