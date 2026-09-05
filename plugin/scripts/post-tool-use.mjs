#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
	return basename(dir) || rootProjectName(dir);
}
/**
* A drive root (`C:\`) or `/` has no basename, and an empty project makes the
* daemon refuse the observation with a 400 -- correctly, since a nameless
* project would be unrecoverable. Claude Code's desktop app opens sessions at
* `C:\` by default, so on 2026-09-05 every hook of such a session was refused
* while the same session captured fine whenever its working directory had
* wandered into a real folder. The name is the truth about where the session
* ran, not a placeholder: `drive-c` for `C:\`, `root` for `/`.
*/
function rootProjectName(dir) {
	const drive = /^([A-Za-z]):[\\/]*$/.exec(dir.trim());
	if (drive) return `drive-${drive[1].toLowerCase()}`;
	return "root";
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
function clientHint() {
	const names = Object.keys(process.env).filter((k) => /^(CLAUDE|CODEX|DEVIN|CURSOR|COPILOT)[_A-Z]*/.test(k)).sort();
	return names.length ? names.join(",") : "none";
}
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
	const head = `HTTP ${res.status} ${res.statusText || ""}`.trim();
	if (res.status >= 400 && res.status < 500 && typeof res.text === "function") {
		res.text().then((body) => {
			let reason = "";
			try {
				reason = String(JSON.parse(body).error ?? "");
			} catch {}
			reportCaptureFailureImpl(hookType, url, new Error(reason ? `${head}: ${reason.slice(0, 120)}` : head), file);
		}, () => reportCaptureFailureImpl(hookType, url, new Error(head), file));
		return;
	}
	reportCaptureFailureImpl(hookType, url, new Error(head), file);
}
const CAPTURE_SKIP_FILE = join(homedir(), ".agentmemory", "capture-skips.log");
const CAPTURE_SKIP_CAP_BYTES = 64 * 1024;
/**
* Record a hook that decided NOT to post -- an unparsable payload, or a
* payload it classifies as an SDK child context. Those returns are by design,
* but from the outside they are indistinguishable from a hook that never ran:
* no observation, no failure marker, nothing. On 2026-09-05 a whole session
* captured nothing while the daemon was healthy and the marker was quiet,
* and there was no way to tell which return it was without patching the
* bundle by hand.
*
* Bounded: appends until the file reaches CAPTURE_SKIP_CAP_BYTES, then stops.
* The value of the log is the first few lines after a change, not a stream.
* Payload contents are never written -- only key names and the fields that
* decide the skip.
*/
function reportCaptureSkip(hookType, reason, detail, file = CAPTURE_SKIP_FILE) {
	try {
		mkdirSync(join(file, ".."), { recursive: true });
		let size = 0;
		try {
			size = statSync(file).size;
		} catch {}
		if (size >= CAPTURE_SKIP_CAP_BYTES) return;
		writeFileSync(file, JSON.stringify({
			ts: (/* @__PURE__ */ new Date()).toISOString(),
			hook: hookType,
			reason,
			...detail
		}) + "\n", { flag: "a" });
	} catch {}
}
/** The fields that decide an SDK-child skip, as names and flags -- never payload contents. */
function describeHookPayload(data) {
	const obj = data && typeof data === "object" ? data : null;
	return {
		keys: obj ? Object.keys(obj).sort().join(",") : "",
		entrypoint: obj && typeof obj["entrypoint"] === "string" ? obj["entrypoint"] : null,
		sdkChildEnv: process.env["AGENTMEMORY_SDK_CHILD"] ?? null,
		sessionPrefix: obj ? String(obj["session_id"] ?? obj["sessionId"] ?? "").slice(0, 8) : "",
		client: Object.keys(process.env).filter((k) => /^(CLAUDE|CODEX|DEVIN)[_A-Z]*/.test(k)).sort().join(",")
	};
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
			lastError: err instanceof Error ? err.message : String(err),
			lastClient: clientHint()
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
//#region src/hooks/post-tool-use.ts
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
		reportCaptureSkip("post-tool-use", "unparsable-stdin", { bytes: input.length });
		return;
	}
	if (!data || typeof data !== "object") {
		reportCaptureSkip("post-tool-use", "not-an-object", {});
		return;
	}
	if (isSdkChildContext(data)) {
		reportCaptureSkip("post-tool-use", "sdk-child", describeHookPayload(data));
		return;
	}
	const sessionId = data.session_id || data.sessionId || "unknown";
	const toolName = data.tool_name ?? data.toolName;
	const toolInput = data.tool_input ?? data.toolArgs;
	const { imageData, cleanOutput } = extractImageData(toolOutput(data));
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "post_tool_use",
			sessionId,
			project: resolveProject(data.cwd),
			cwd: data.cwd || process.cwd(),
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				tool_name: toolName,
				tool_input: toolInput,
				tool_output: truncate(cleanOutput, 8e3),
				...imageData ? { image_data: imageData } : {}
			}
		}),
		signal: AbortSignal.timeout(3e3)
	}).then((res) => reportCaptureResponse("post-tool-use:observe", `${REST_URL}/agentmemory/observe`, res), (err) => reportCaptureFailure("post-tool-use:observe", `${REST_URL}/agentmemory/observe`, err));
	setTimeout(() => process.exit(0), 500).unref();
}
function toolOutput(data) {
	if (data.tool_response !== void 0) return data.tool_response;
	if (data.tool_output !== void 0) return data.tool_output;
	const result = data.tool_result ?? data.toolResult;
	if (typeof result === "object" && result !== null) {
		const obj = result;
		return obj.text_result_for_llm ?? obj.textResultForLlm ?? result;
	}
	return result;
}
function isBase64Image(val) {
	return typeof val === "string" && (val.startsWith("data:image/") || val.startsWith("iVBORw0KGgo") || val.startsWith("/9j/"));
}
function extractImageData(output) {
	if (isBase64Image(output)) return {
		imageData: output,
		cleanOutput: "[image data extracted]"
	};
	if (typeof output === "object" && output !== null && !Array.isArray(output)) {
		const obj = output;
		let imageData;
		const clean = {};
		for (const [key, val] of Object.entries(obj)) if (!imageData && isBase64Image(val)) {
			imageData = val;
			clean[key] = "[image data extracted]";
		} else clean[key] = val;
		return {
			imageData,
			cleanOutput: clean
		};
	}
	return {
		imageData: void 0,
		cleanOutput: output
	};
}
function truncate(value, max) {
	if (typeof value === "string" && value.length > max) return value.slice(0, max) + "\n[...truncated]";
	if (typeof value === "object" && value !== null) {
		const str = JSON.stringify(value);
		if (str.length > max) return str.slice(0, max) + "...[truncated]";
		return value;
	}
	return value;
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=post-tool-use.mjs.map