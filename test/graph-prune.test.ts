import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { normalizeNodeName, capProvenance } from "../src/functions/graph.js";

// Two faults made the knowledge graph 18.5 MB for 633 nodes on a
// five-session corpus, and pushed /agentmemory/export past the engine's
// response ceiling:
//
//   1. sourceObservationIds grew without bound. Measured: 97.9% of all
//      graph node bytes, one node carrying 1,270 ids, median 430.
//   2. Nodes were keyed on the raw extracted name, so one file became
//      several nodes depending on how each observation spelled its path.
//      259 file nodes contained 74 suffix-duplicate pairs.

const BS = String.fromCharCode(92);

describe("normalizeNodeName", () => {
  // The three spellings of one file that were observed living as three
  // separate nodes, each with its own edges, so traversal reaching one
  // never reached the others.
  it("collapses Windows path spellings of the same file", () => {
    const escaped = `X:${BS}${BS}Projects${BS}${BS}app${BS}${BS}src${BS}${BS}main.ts`;
    const backslash = `X:${BS}Projects${BS}app${BS}src${BS}main.ts`;
    const forward = "x:/Projects/app/src/main.ts";

    const a = normalizeNodeName("file", escaped);
    const b = normalizeNodeName("file", backslash);
    const c = normalizeNodeName("file", forward);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe("x:/Projects/app/src/main.ts");
  });

  it("strips trailing annotations the extractor appends", () => {
    expect(normalizeNodeName("file", "build.gradle.kts (root)")).toBe(
      "build.gradle.kts",
    );
  });

  it("lowercases only the drive letter, preserving path case", () => {
    // POSIX paths are case-sensitive; MainView.tsx must not become mainview.tsx.
    expect(normalizeNodeName("file", "X:/Projects/App/src/MainView.tsx")).toBe(
      "x:/Projects/App/src/MainView.tsx",
    );
  });

  it("leaves non-file node names untouched", () => {
    // Concepts are prose. "React Hooks" and "react hooks" may be distinct
    // entities and are not ours to merge.
    expect(normalizeNodeName("concept", "React Hooks")).toBe("React Hooks");
    expect(normalizeNodeName("library", "Vitest")).toBe("Vitest");
  });

  it("tolerates empty and undefined names", () => {
    expect(normalizeNodeName("file", "")).toBe("");
    expect(normalizeNodeName("file", undefined as unknown as string)).toBe("");
  });
});

describe("capProvenance", () => {
  it("leaves short lists alone", () => {
    const ids = ["a", "b", "c"];
    expect(capProvenance(ids)).toEqual(ids);
  });

  it("deduplicates", () => {
    expect(capProvenance(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("bounds a list that previously grew forever", () => {
    const ids = Array.from({ length: 1270 }, (_, i) => `obs_${i}`);
    const capped = capProvenance(ids);
    expect(capped).toHaveLength(50);
  });

  it("keeps the most recent ids, not the oldest", () => {
    // Ids append newest-last, so the tail is live context while the head is
    // history the session summaries already cover.
    const ids = Array.from({ length: 100 }, (_, i) => `obs_${i}`);
    const capped = capProvenance(ids);
    expect(capped[capped.length - 1]).toBe("obs_99");
    expect(capped[0]).toBe("obs_50");
    expect(capped).not.toContain("obs_0");
  });
});
