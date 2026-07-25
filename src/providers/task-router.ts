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

// Record<MemoryTask, true> makes the list exhaustive at compile time: adding a
// task to the union without adding it here is a type error, so a new
// registration site cannot silently skip routing.
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
  allProviders(): ResilientProvider[];
  routingSummary(): Map<string, MemoryTask[]>;
}

export function makeTaskProviderFactory(
  config: AgentMemoryConfig,
  fallbackConfig: FallbackConfig,
): TaskProviderFactory {
  const byModel = new Map<string, ResilientProvider>();
  const tasksByModel = new Map<string, MemoryTask[]>();

  const build = (model: string): ResilientProvider => {
    const providerConfig: ProviderConfig = { ...config.provider, model };
    return fallbackConfig.providers.length > 0
      ? createFallbackProvider(providerConfig, fallbackConfig)
      : createProvider(providerConfig);
  };

  const resolve = (task: MemoryTask): ResilientProvider => {
    const override = getEnvVar(envVarForTask(task))?.trim();
    const model = override || config.provider.model;

    let provider = byModel.get(model);
    if (!provider) {
      provider = build(model);
      byModel.set(model, provider);
    }

    const tasks = tasksByModel.get(model) ?? [];
    if (!tasks.includes(task)) {
      tasks.push(task);
      tasksByModel.set(model, tasks);
    }
    return provider;
  };

  // Resolve every task up front so routingSummary() is complete for the boot
  // log, and so a broken provider config fails at startup rather than on the
  // first background job hours later.
  for (const task of ALL_TASKS) resolve(task);

  return {
    providerFor: resolve,
    allProviders: () => [...byModel.values()],
    routingSummary: () => tasksByModel,
  };
}
