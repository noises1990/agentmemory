#!/usr/bin/env node
import { loadAgentMemoryEnv } from "../utils/env-file.js";
import { resolveProject } from "./_project.js";
import {
  reportCaptureFailure,
  reportCaptureResponse,
} from "./_capture-failure.js";

// Hook processes inherit only the OS environment, never ~/.agentmemory/.env.
// Load it before the module-scope process.env reads below, or a value set only
// in that file (AGENTMEMORY_URL, AGENTMEMORY_SECRET, feature gates) reads as
// undefined and the hook silently takes the disabled branch.
loadAgentMemoryEnv();

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;

  const sessionId = ((data.session_id || data.sessionId) as string) || "unknown";
  const agentId = data.agent_id || data.agentName;
  const agentType = data.agent_type || data.agentDisplayName || data.agentName;
  const lastMsg =
    typeof data.last_assistant_message === "string"
      ? data.last_assistant_message.slice(0, 4000)
      : "";

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "subagent_stop",
      sessionId,
      project: resolveProject(data.cwd as string | undefined),
      cwd: (data.cwd as string | undefined) || process.cwd(),
      timestamp: new Date().toISOString(),
      data: {
        agent_id: agentId,
        agent_type: agentType,
        last_message: lastMsg,
      },
    }),
    signal: AbortSignal.timeout(2000),
  }).then(
    (res) => reportCaptureResponse("subagent-stop:observe", `${REST_URL}/agentmemory/observe`, res),
    (err) => reportCaptureFailure("subagent-stop:observe", `${REST_URL}/agentmemory/observe`, err),
  );
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch(() => process.exit(0));
