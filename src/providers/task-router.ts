import type {
  AgentMemoryConfig,
  CircuitBreakerState,
  FallbackConfig,
  ProviderConfig,
} from "../types.js";
import type { ResilientProvider } from "./resilient.js";
import { getEnvVar } from "../config.js";
import { createFallbackProvider, createProvider } from "./index.js";

export type MemoryTask =
  | "compress"
  | "summarize"
  | "consolidate"
  | "consolidation-pipeline"
  | "graph"
  | "reflect"
  | "crystallize"
  | "skill-extract"
  | "sliding-window"
  | "query-expansion"
  | "temporal-graph"
  | "flow-compress"
  | "compress-file";

// Record<MemoryTask, true> only forces this object to cover every member of
// the MemoryTask union — it guarantees ALL_TASKS (and therefore eager
// resolution and the boot log) can't silently drop a task. It does NOT
// guarantee that every registration site in src/index.ts actually calls
// providerFor(): a 14th register*Function wired to a hand-built provider
// instead of taskProviders.providerFor(...) compiles fine. That still has to
// be caught by review or grep.
const TASK_SET: Record<MemoryTask, true> = {
  compress: true,
  summarize: true,
  consolidate: true,
  "consolidation-pipeline": true,
  graph: true,
  reflect: true,
  crystallize: true,
  "skill-extract": true,
  "sliding-window": true,
  "query-expansion": true,
  "temporal-graph": true,
  "flow-compress": true,
  "compress-file": true,
};

export const ALL_TASKS = Object.keys(TASK_SET) as MemoryTask[];

// envVarForTask builds names with a template literal, so scripts/skills/generate.ts's
// `/AGENTMEMORY_[A-Z0-9_]+/g` scan of src/ (which only matches literal text,
// not runtime output) can't discover any of them from this function body.
// Spelling the 13 resolved names out here as plain text gives the generator
// something to match, so `agentmemory-config`'s REFERENCE.md documents these
// variables instead of silently omitting all of them:
// AGENTMEMORY_COMPRESS_MODEL, AGENTMEMORY_SUMMARIZE_MODEL,
// AGENTMEMORY_CONSOLIDATE_MODEL, AGENTMEMORY_CONSOLIDATION_PIPELINE_MODEL,
// AGENTMEMORY_GRAPH_MODEL, AGENTMEMORY_REFLECT_MODEL,
// AGENTMEMORY_CRYSTALLIZE_MODEL, AGENTMEMORY_SKILL_EXTRACT_MODEL,
// AGENTMEMORY_SLIDING_WINDOW_MODEL, AGENTMEMORY_QUERY_EXPANSION_MODEL,
// AGENTMEMORY_TEMPORAL_GRAPH_MODEL, AGENTMEMORY_FLOW_COMPRESS_MODEL,
// AGENTMEMORY_COMPRESS_FILE_MODEL
export function envVarForTask(task: MemoryTask): string {
  return `AGENTMEMORY_${task.replace(/-/g, "_").toUpperCase()}_MODEL`;
}

const DEGRADATION_RANK: Record<CircuitBreakerState["state"], number> = {
  closed: 0,
  "half-open": 1,
  open: 2,
};

export function mostDegraded(
  states: CircuitBreakerState[],
): CircuitBreakerState | null {
  if (states.length === 0) return null;
  return states.reduce((worst, s) =>
    DEGRADATION_RANK[s.state] > DEGRADATION_RANK[worst.state] ? s : worst,
  );
}

export interface TaskProviderFactory {
  providerFor(task: MemoryTask): ResilientProvider;
  modelFor(task: MemoryTask): string;
  allProviders(): ResilientProvider[];
  routingSummary(): Map<string, MemoryTask[]>;
}

export function makeTaskProviderFactory(
  config: AgentMemoryConfig,
  fallbackConfig: FallbackConfig,
): TaskProviderFactory {
  // Keyed by { provider, model } rather than bare ResilientProvider: model is
  // read back from the ProviderConfig object actually handed to
  // createProvider/createFallbackProvider, not recomputed from the loop's
  // local `model` variable, so modelFor() reports what the provider was
  // really built with instead of what routing merely intended.
  const byModel = new Map<string, { provider: ResilientProvider; model: string }>();
  const tasksByModel = new Map<string, MemoryTask[]>();
  const providerByTask = new Map<MemoryTask, ResilientProvider>();
  const modelByTask = new Map<MemoryTask, string>();

  const build = (model: string): { provider: ResilientProvider; model: string } => {
    const providerConfig: ProviderConfig = { ...config.provider, model };
    const provider = fallbackConfig.providers.length > 0
      ? createFallbackProvider(providerConfig, fallbackConfig)
      : createProvider(providerConfig);
    return { provider, model: providerConfig.model };
  };

  // Resolve every task up front, once, so routingSummary() is complete for
  // the boot log, a broken provider config fails at startup rather than on
  // the first background job hours later, and providerFor/modelFor below can
  // be pure lookups: reading getEnvVar per call would let a task route
  // differently mid-process if ~/.agentmemory/.env changed after boot,
  // silently disagreeing with what the boot log already reported.
  for (const task of ALL_TASKS) {
    const override = getEnvVar(envVarForTask(task))?.trim();
    const requestedModel = override || config.provider.model;

    let entry = byModel.get(requestedModel);
    if (!entry) {
      entry = build(requestedModel);
      byModel.set(requestedModel, entry);
    }

    providerByTask.set(task, entry.provider);
    modelByTask.set(task, entry.model);

    const tasks = tasksByModel.get(requestedModel) ?? [];
    tasks.push(task);
    tasksByModel.set(requestedModel, tasks);
  }

  return {
    providerFor: (task) => {
      const provider = providerByTask.get(task);
      // Unreachable for any value the MemoryTask type allows: the loop above
      // iterates ALL_TASKS, which TASK_SET keeps exhaustive over the union.
      if (!provider) throw new Error(`task-router: no provider resolved for task "${task}"`);
      return provider;
    },
    modelFor: (task) => {
      const model = modelByTask.get(task);
      if (!model) throw new Error(`task-router: no model resolved for task "${task}"`);
      return model;
    },
    allProviders: () => [...byModel.values()].map((entry) => entry.provider),
    // Defensive copies: callers must not be able to mutate the factory's
    // internal routing state by mutating the returned map or its arrays.
    routingSummary: () => new Map([...tasksByModel].map(([model, tasks]) => [model, [...tasks]])),
  };
}
