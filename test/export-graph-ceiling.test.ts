import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { KV } from "../src/state/schema.js";
import type { Session, ExportData } from "../src/types.js";

// Regression cover for a pair of faults that combined into silent data loss.
//
// 1. mem::export serialized the whole knowledge graph unconditionally. The
//    graph grows independently of session count, so ?maxSessions=1 did not
//    shrink it. Past a few MB the endpoint returned
//    500 {"error":"Invocation stopped"} in about a second — the function
//    completed and logged "Export complete", then the response was too big
//    for the engine's invocation channel. Observed live: 7.4 MB fine,
//    ~27 MB dead.
//
// 2. mem::import with strategy "replace" cleared every scope whether or not
//    the payload carried a replacement. So the obvious recovery — export,
//    edit, re-import — would have wiped the graph permanently, because the
//    export had already dropped it.
//
// Together those made export -> filter -> import(replace) unusable, which
// mattered beyond backups: it is also how sessions get bulk-deleted.

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const e = store.get(scope);
      return e ? (Array.from(e.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

const session: Session = {
  id: "s1",
  project: "proj",
  cwd: "/tmp",
  startedAt: new Date().toISOString(),
  status: "completed",
  observationCount: 0,
};

/** Nodes carrying enough payload to push the graph past the 4 MB ceiling. */
function fatNodes(count: number, padding: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    name: `node ${i}`,
    type: "concept",
    summary: "x".repeat(padding),
  }));
}

async function setup(nodes: unknown[], edges: unknown[]) {
  const sdk = mockSdk();
  const kv = mockKV();
  await kv.set(KV.sessions, session.id, session);
  for (const n of nodes) await kv.set(KV.graphNodes, (n as { id: string }).id, n);
  for (const e of edges) await kv.set(KV.graphEdges, (e as { id: string }).id, e);
  registerExportImportFunction(sdk as any, kv as any);
  return {
    kv,
    exportFn: sdk.functions.get("mem::export")!,
    importFn: sdk.functions.get("mem::import")!,
  };
}

describe("mem::export graph ceiling", () => {
  it("includes a small graph", async () => {
    const { exportFn } = await setup(fatNodes(3, 10), []);
    const out = (await exportFn({})) as ExportData;
    expect(out.graphNodes).toHaveLength(3);
    expect(out.graphOmitted).toBeUndefined();
  });

  it("omits a graph that would blow the response ceiling, and says so", async () => {
    // ~60 nodes x 100 KB = ~6 MB, over the 4 MB budget.
    const { exportFn } = await setup(fatNodes(60, 100_000), []);
    const out = (await exportFn({})) as ExportData;

    expect(out.graphNodes).toBeUndefined();
    expect(out.graphOmitted?.reason).toBe("too_large");
    expect(out.graphOmitted?.nodes).toBe(60);
    expect(out.graphOmitted?.bytes).toBeGreaterThan(4 * 1024 * 1024);
    // The rest of the export must survive — that is the whole point.
    expect(out.sessions).toHaveLength(1);
  });

  it("honours includeGraph:false even when the graph is small", async () => {
    const { exportFn } = await setup(fatNodes(3, 10), []);
    const out = (await exportFn({ includeGraph: false })) as ExportData;
    expect(out.graphNodes).toBeUndefined();
    expect(out.graphOmitted?.reason).toBe("not_requested");
  });

  it("honours includeGraph:true past the ceiling", async () => {
    const { exportFn } = await setup(fatNodes(60, 100_000), []);
    const out = (await exportFn({ includeGraph: true })) as ExportData;
    expect(out.graphNodes).toHaveLength(60);
    expect(out.graphOmitted).toBeUndefined();
  });
});

describe("mem::import replace only clears what it replaces", () => {
  // The fault that turned an oversized graph into permanent loss.
  it("leaves the existing graph alone when the payload carries none", async () => {
    const { kv, importFn } = await setup(fatNodes(5, 10), [
      { id: "e1", from: "n0", to: "n1", type: "relates" },
    ]);

    await importFn({
      exportData: {
        version: "0.9.28",
        exportedAt: new Date().toISOString(),
        sessions: [session],
        observations: {},
        memories: [],
        summaries: [],
        // no graphNodes / graphEdges — exactly what an over-ceiling export produces
      },
      strategy: "replace",
    });

    expect(await kv.list(KV.graphNodes)).toHaveLength(5);
    expect(await kv.list(KV.graphEdges)).toHaveLength(1);
  });

  it("still replaces the graph when the payload does carry one", async () => {
    const { kv, importFn } = await setup(fatNodes(5, 10), []);

    await importFn({
      exportData: {
        version: "0.9.28",
        exportedAt: new Date().toISOString(),
        sessions: [session],
        observations: {},
        memories: [],
        summaries: [],
        graphNodes: [{ id: "replacement", name: "only one", type: "concept" }],
      },
      strategy: "replace",
    });

    const nodes = await kv.list<{ id: string }>(KV.graphNodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe("replacement");
  });

  it("round-trips: a graph-omitted export can be re-imported without loss", async () => {
    const { kv, exportFn, importFn } = await setup(fatNodes(60, 100_000), []);

    const exported = (await exportFn({})) as ExportData;
    expect(exported.graphOmitted?.reason).toBe("too_large");

    await importFn({ exportData: exported, strategy: "replace" });

    // Sessions restored from the payload, graph untouched on disk.
    expect(await kv.list(KV.sessions)).toHaveLength(1);
    expect(await kv.list(KV.graphNodes)).toHaveLength(60);
  });
});
