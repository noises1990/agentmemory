#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
//#region src/hooks/_capture-failure.ts
/**
* Durable record of capture POSTs that never reached the daemon.
*
* Every hook used to end its fire-and-forget POST with `.catch(() => {})`. That
* discarded the only evidence that capture was failing, and it hid a real
* outage: an ambient AGENTMEMORY_URL pointed every hook at a host that no
* longer resolved, so from 2026-08-08 to 2026-09-04 not one observation was
* stored. The daemon was healthy the whole time and `agentmemory status`
* reported a growing-looking session count, because the count was of rows
* written before the break.
*
* A hook may not print to the transcript on every tool use and may not block,
* so the signal goes to one small file that `agentmemory status` reads back.
*
* Deliberately NOT written on the success path: that would be a synchronous
* file write on every tool call. Recovery is inferred instead — status compares
* this marker's `lastAt` against the newest observation and reports the failure
* as resolved when capture has since succeeded.
*/
const CAPTURE_FAILURE_FILE = join(homedir(), ".agentmemory", "capture-failures.json");
function readRecord(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && parsed.v === 1 ? parsed : null;
	} catch {
		return null;
	}
}
/**
* Record one failed capture POST.
*
* Never throws: it runs inside the hook's `.catch`, and a hook that crashed
* while reporting a failure would be worse than the failure. If even the file
* write fails, it says so on stderr — the last channel available.
*
* Concurrency: hooks are separate short-lived processes, so two failing at once
* can lose an increment in the read-modify-write. That is accepted. The value
* of this file is "capture is broken, since when, against which URL", and none
* of those are harmed by an off-by-a-few count.
*/
function reportCaptureFailure(hookType, url, err, file = CAPTURE_FAILURE_FILE) {
	reportCaptureFailureImpl(hookType, url, err, file);
}
/**
* Record a capture POST that ARRIVED and was refused.
*
* `fetch` rejects only on a transport failure, so a 401 from a wrong or missing
* AGENTMEMORY_SECRET resolves normally with `ok: false`. Watching just the
* rejection path would leave that case as silent as the empty catch it
* replaces — and an auth failure is the likelier of the two to persist unnoticed,
* because the host is up and nothing times out.
*
* The body is never read: it is the daemon's error JSON, and the request that
* produced it carried a bearer token.
*/
function reportCaptureResponse(hookType, url, res, file = CAPTURE_FAILURE_FILE) {
	if (res.ok) return;
	reportCaptureFailureImpl(hookType, url, new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim()), file);
}
function reportCaptureFailureImpl(hookType, url, err, file) {
	try {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const prev = readRecord(file);
		const record = {
			v: 1,
			firstAt: prev?.firstAt ?? now,
			lastAt: now,
			count: (prev?.count ?? 0) + 1,
			byHook: { ...prev?.byHook ?? {} },
			lastUrl: url,
			lastError: err instanceof Error ? err.message : String(err)
		};
		record.byHook[hookType] = (record.byHook[hookType] ?? 0) + 1;
		mkdirSync(join(file, ".."), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
		renameSync(tmp, file);
	} catch (writeErr) {
		process.stderr.write(`[agentmemory] capture failed for ${hookType} against ${url}, and the failure marker at ${file} could not be written: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}\n`);
	}
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
	}).then((res) => reportCaptureResponse("prompt-submit:observe", `${REST_URL}/agentmemory/observe`, res), (err) => reportCaptureFailure("prompt-submit:observe", `${REST_URL}/agentmemory/observe`, err));
	setTimeout(() => process.exit(0), 500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=prompt-submit.mjs.map