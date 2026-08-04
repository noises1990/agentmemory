import { TriggerAction, type ISdk } from "iii-sdk";
import type { CompressedObservation, HookPayload, Session } from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isReflectEnabled } from "../functions/slots.js";
import {
  getAgentId,
  isGraphExtractionEnabled,
  getGraphBatchSize,
} from "../config.js";
import { logger } from "../logger.js";

export function registerEventTriggers(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "event::session::started",
    async (data: {
      sessionId: string;
      project: string;
      cwd: string;
      agentId?: string;
    }) => {
      const requestAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim().slice(0, 128)
          : undefined;
      const agentId = requestAgentId ?? getAgentId();
      const session: Session = {
        id: data.sessionId,
        project: data.project,
        cwd: data.cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
        ...(agentId ? { agentId } : {}),
      };
      await kv.set(KV.sessions, data.sessionId, session);
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string; agentId?: string },
        { context: string }
      >({
        function_id: "mem::context",
        payload: {
          sessionId: data.sessionId,
          project: data.project,
          ...(agentId ? { agentId } : {}),
        },
      });
      return { session, context: contextResult.context };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::started",
    config: { topic: "agentmemory.session.started" },
  });

  sdk.registerFunction("event::observation", async (data: HookPayload) =>
    sdk.trigger({ function_id: "mem::observe", payload: data }),
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::observation",
    config: { topic: "agentmemory.observation" },
  });

  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string }) => {
    const summary = await sdk.trigger({ function_id: "mem::summarize", payload: data });
    if (isReflectEnabled()) {
      try {
        sdk.trigger({
          function_id: "mem::slot-reflect",
          payload: { sessionId: data.sessionId },
          action: TriggerAction.Void(),
        });
      } catch (err) {
        logger.warn("slot-reflect trigger failed", {
          sessionId: data.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (isGraphExtractionEnabled()) {
      try {
        const observations = await kv.list<CompressedObservation>(
          KV.observations(data.sessionId),
        );
        const compressed = observations.filter((o) => o.title);
        if (compressed.length > 0) {
          // Batch, because this used to hand the model the entire session in
          // one call. Measured on a real 500-observation session: a 417,500
          // character prompt, ~130k tokens against gpt-oss-20b's 128k window
          // — the input alone did not fit, before reserving a single output
          // token. It also asked for 2,281 entities in one response, which no
          // sane max_tokens covers. That is both failure modes seen in the
          // logs: the 60s timeouts and the finish_reason=length truncations.
          //
          // GRAPH_EXTRACTION_BATCH_SIZE and its getGraphBatchSize() reader
          // already existed for exactly this, and nothing had ever called
          // them — the batching was designed and the knob shipped, but the
          // call site was never wired. api::graph-build batches the identical
          // work, so both paths now chunk rather than one going whole-session.
          //
          // Sequential, not fanned out: a 500-observation session is 20 calls,
          // and firing those at once is how the provider rate limiter gets
          // tripped. Detached from the handler so session-end does not block
          // on 20 LLM round-trips — matching the fire-and-forget this replaces.
          const batchSize = getGraphBatchSize();
          void (async () => {
            for (let i = 0; i < compressed.length; i += batchSize) {
              const batch = compressed.slice(i, i + batchSize);
              try {
                await sdk.trigger({
                  function_id: "mem::graph-extract",
                  payload: { observations: batch },
                });
              } catch (err) {
                // One bad batch must not abandon the rest of the session.
                logger.warn("graph-extract batch failed", {
                  sessionId: data.sessionId,
                  batch: `${i / batchSize + 1}/${Math.ceil(compressed.length / batchSize)}`,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          })();
        }
      } catch (err) {
        logger.warn("graph-extract trigger failed", {
          sessionId: data.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return summary;
  });
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::stopped",
    config: { topic: "agentmemory.session.stopped" },
  });

  sdk.registerFunction(
    "event::session::ended",
    async (data: { sessionId: string }) => {
      await kv.update(KV.sessions, data.sessionId, [
        { type: "set", path: "endedAt", value: new Date().toISOString() },
        { type: "set", path: "status", value: "completed" },
      ]);
      return { success: true };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::ended",
    config: { topic: "agentmemory.session.ended" },
  });

  // React to observation count changes and emit a lightweight live event for dashboards/viewer.
  sdk.registerFunction(
    "event::session::observation-count-changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Session;
      new_value?: Session;
    }) => {
      if (payload.event_type === "delete") return { skipped: true };
      const oldCount = payload.old_value?.observationCount ?? 0;
      const newCount = payload.new_value?.observationCount ?? 0;
      if (newCount <= oldCount) return { skipped: true };

      await sdk.trigger({
        function_id: "stream::send",
        payload: {
          stream_name: STREAM.name,
          group_id: STREAM.viewerGroup,
          id: `session-activity-${payload.key}-${Date.now()}`,
          type: "session.activity",
          data: {
            sessionId: payload.key,
            observationCount: newCount,
            delta: newCount - oldCount,
            updatedAt: payload.new_value?.updatedAt ?? new Date().toISOString(),
          },
        },
        action: TriggerAction.Void(),
      });

      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::session::observation-count-changed",
    config: { scope: KV.sessions },
  });
}
