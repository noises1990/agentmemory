import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => {
  let n = 0;
  return {
    KV: {
      memories: "mem:memories",
      summaries: "mem:summaries",
      lessons: "mem:lessons",
      audit: "mem:audit",
    },
    generateId: (prefix: string) => `${prefix}_test_${++n}`,
  };
});

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../src/functions/audit.js", () => ({ recordAudit: vi.fn() }));

const bm25Remove = vi.fn();
const bm25Add = vi.fn();
const vectorRemove = vi.fn();
const vectorAdd = vi.fn();
vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: bm25Add, remove: bm25Remove }),
  vectorIndexAddGuarded: (...a: unknown[]) => {
    vectorAdd(...a);
    return Promise.resolve();
  },
  vectorIndexRemove: (id: string) => vectorRemove(id),
  scheduleIndexSave: vi.fn(),
}));

import { registerDossierFunction } from "../src/functions/dossier.js";
import type { MemoryProvider } from "../src/types.js";

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
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from((store.get(scope) ?? new Map()).values()) as T[],
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

const DOSSIER_XML = `<dossier>
<identity>A test repository used to exercise the dossier builder end to end.</identity>
<decisions><item>Keep the NUL delimiter. [ses_1]</item></decisions>
</dossier>`;

function makeProvider(responses: string[] = [DOSSIER_XML]) {
  let i = 0;
  const p = {
    name: "test",
    calls: 0,
    compress: async () => "",
    summarize: async () => {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i += 1;
      p.calls = i;
      return r;
    },
  };
  return p as MemoryProvider & { calls: number };
}

async function setup(provider: MemoryProvider, opts?: { summaryAt?: string }) {
  const sdk = mockSdk();
  const kv = mockKV();
  await kv.set("mem:summaries", "ses_1", {
    sessionId: "ses_1",
    project: "demo",
    createdAt: opts?.summaryAt ?? "2026-08-01T00:00:00.000Z",
    title: "Initial work",
    narrative: "Set up the audit schema and the fingerprint module.",
    keyDecisions: ["Keep the NUL delimiter"],
    filesModified: ["lib/a.ts", "lib/b.ts"],
    concepts: ["audit"],
    observationCount: 12,
  });
  registerDossierFunction(sdk as any, kv as any, provider);
  return { handler: sdk.functions.get("mem::dossier-build")!, kv };
}

describe("mem::dossier-build", () => {
  beforeEach(() => {
    bm25Remove.mockClear();
    bm25Add.mockClear();
    vectorRemove.mockClear();
    vectorAdd.mockClear();
    delete process.env.AGENTMEMORY_DOSSIER_MIN_INTERVAL_MS;
  });

  it("requires a project", async () => {
    const { handler } = await setup(makeProvider());
    const r = await handler({});
    expect(r.success).toBe(false);
    expect(r.error).toBe("project is required");
  });

  it("skips a project with no inputs instead of writing an empty dossier", async () => {
    const provider = makeProvider();
    const { handler, kv } = await setup(provider);
    const r = await handler({ project: "nothing-here" });
    expect(r.skipped).toBe("no-inputs");
    // The bar that matters: no provider call, so no spend on a repo we know
    // nothing about.
    expect(provider.calls).toBe(0);
    expect(await kv.list("mem:memories")).toHaveLength(0);
  });

  it("builds a dossier and indexes it for search", async () => {
    const { handler, kv } = await setup(makeProvider());
    const r = await handler({ project: "demo" });

    expect(r.success).toBe(true);
    expect(r.version).toBe(1);
    const memories = await kv.list<any>("mem:memories");
    expect(memories).toHaveLength(1);
    expect(memories[0].title).toBe("Dossier: demo");
    expect(memories[0].isLatest).toBe(true);
    expect(memories[0].content).toContain("Standing decisions");
    // Persisting the row is not enough — #257. Without this the dossier is
    // invisible to search until the next restart.
    expect(bm25Add).toHaveBeenCalledTimes(1);
    expect(vectorAdd).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a rebuild with no new inputs writes no second version", async () => {
    // Debounce off, so this proves the no-new-inputs guard rather than the
    // interval guard.
    process.env.AGENTMEMORY_DOSSIER_MIN_INTERVAL_MS = "0";
    const provider = makeProvider();
    const { handler, kv } = await setup(provider);

    const first = await handler({ project: "demo" });
    expect(first.version).toBe(1);

    const second = await handler({ project: "demo" });
    expect(second.skipped).toBe("no-new-inputs");
    expect(provider.calls).toBe(1);

    const live = (await kv.list<any>("mem:memories")).filter((m) => m.isLatest);
    expect(live).toHaveLength(1);
  });

  it("debounces a rebuild inside the interval", async () => {
    const provider = makeProvider();
    const { handler } = await setup(provider);
    await handler({ project: "demo" });
    const second = await handler({ project: "demo" });
    expect(second.skipped).toBe("debounced");
    expect(provider.calls).toBe(1);
  });

  it("supersedes the previous version and unindexes it", async () => {
    const provider = makeProvider();
    const { handler, kv } = await setup(provider);
    const first = await handler({ project: "demo" });
    bm25Remove.mockClear();
    vectorRemove.mockClear();

    const second = await handler({ project: "demo", force: true });

    expect(second.version).toBe(2);
    expect(second.supersededId).toBe(first.memoryId);

    const all = await kv.list<any>("mem:memories");
    expect(all).toHaveLength(2);
    expect(all.filter((m) => m.isLatest)).toHaveLength(1);
    const live = all.find((m) => m.isLatest);
    expect(live.supersedes).toEqual([first.memoryId]);

    // isLatest governs KV reads, not the indexes — the old version must be
    // removed from both or search returns two disagreeing dossiers.
    expect(bm25Remove).toHaveBeenCalledWith(first.memoryId);
    expect(vectorRemove).toHaveBeenCalledWith(first.memoryId);
  });

  it("fails loudly when the provider throws, leaving the old dossier live", async () => {
    const { handler, kv } = await setup(makeProvider());
    const first = await handler({ project: "demo" });

    const sdk = mockSdk();
    const throwing: MemoryProvider = {
      name: "boom",
      compress: async () => "",
      summarize: async () => {
        throw new Error("provider down");
      },
    };
    registerDossierFunction(sdk as any, kv as any, throwing);
    const r = await sdk.functions.get("mem::dossier-build")!({
      project: "demo",
      force: true,
    });

    expect(r.success).toBe(false);
    expect(r.error).toBe("provider down");
    const live = (await kv.list<any>("mem:memories")).filter((m) => m.isLatest);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(first.memoryId);
  });

  it("refuses to store a dossier with no citable content", async () => {
    const { handler, kv } = await setup(
      makeProvider(["<dossier><identity></identity></dossier>"]),
    );
    const r = await handler({ project: "demo" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("empty_dossier");
    expect(await kv.list("mem:memories")).toHaveLength(0);
  });
});
