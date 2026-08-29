import type { ISdk } from "iii-sdk";
import type {
  Memory,
  MemoryProvider,
  SessionSummary,
  Lesson,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { memoryToObservation } from "../state/memory-utils.js";
import {
  getSearchIndex,
  vectorIndexAddGuarded,
  vectorIndexRemove,
  scheduleIndexSave,
} from "./search.js";
import {
  DOSSIER_SYSTEM,
  DOSSIER_SECTIONS,
  buildDossierPrompt,
  type DossierInput,
} from "../prompts/dossier.js";
import { getXmlChildren, getXmlTag } from "../prompts/xml.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";

/**
 * Per-repository dossier: ONE curated memory per repo, rebuilt from that
 * repo's summaries, lessons and decisions.
 *
 * Why a Memory and not a new store: consumers reach memory through a
 * read-only gatekeeper that exposes `search`, `smartSearch` and `contextPack`.
 * Those already index `KV.memories`. Writing the dossier as a Memory makes it
 * retrievable through the existing surface with no new query API and no
 * change on the consumer side — which is the constraint this feature is
 * built under.
 */

/** Marks a Memory as a dossier. Also the search handle consumers type. */
const DOSSIER_CONCEPT = "dossier";

/** `Dossier: <project>` — the title consumers match on. */
function dossierTitle(project: string): string {
  return `Dossier: ${project}`;
}

/**
 * ~4,000 tokens, so a contextPack budget can carry a whole dossier without
 * crowding out the session it is packing. Converted at the same 3.2
 * chars/token this codebase uses elsewhere for prompt budgeting — dossier
 * bodies are prose and paths, which sit near that ratio.
 */
const DOSSIER_MAX_TOKENS = 4000;
const CHARS_PER_TOKEN = 3.2;
const DOSSIER_MAX_CHARS = Math.floor(DOSSIER_MAX_TOKENS * CHARS_PER_TOKEN);

/**
 * Minimum gap between automatic rebuilds of the same repo.
 *
 * The trigger is session-end, and a busy repo ends sessions in bursts.
 * Without a debounce each one would spend an LLM call re-deriving a document
 * that changed by one summary. Explicit `force` bypasses it; the periodic
 * sweep respects it.
 */
function getRebuildIntervalMs(): number {
  const raw = process.env["AGENTMEMORY_DOSSIER_MIN_INTERVAL_MS"];
  const n = raw ? parseInt(raw, 10) : NaN;
  // `>= 0`, so an explicit 0 means "no debounce" instead of being rejected as
  // invalid and quietly replaced by the 6-hour default — a setting that reads
  // as applied but is not is worse than one that errors.
  return Number.isFinite(n) && n >= 0 ? n : 6 * 60 * 60 * 1000;
}

/**
 * Cap on summaries fed to one build, newest first.
 *
 * Not a silent truncation: when it bites, the count that was dropped is
 * logged and recorded on the build result, so a thin dossier is traceable to
 * the cap rather than looking like a repo with no history.
 */
function getMaxSummaries(): number {
  const raw = process.env["AGENTMEMORY_DOSSIER_MAX_SUMMARIES"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 120;
}

/** Files ranked into the "hot files" section. */
const HOT_FILE_LIMIT = 15;

/**
 * A lesson must clear this to be offered as high-trust input. Below it, a
 * lesson is a guess that decayed rather than a fact that held.
 */
const MIN_LESSON_CONFIDENCE = 0.3;

export interface DossierBuildResult {
  success: boolean;
  skipped?: "no-inputs" | "debounced" | "no-new-inputs";
  error?: string;
  memoryId?: string;
  version?: number;
  supersededId?: string;
  inputs?: {
    summaries: number;
    summariesDropped: number;
    lessons: number;
    memories: number;
  };
  bytes?: number;
  truncatedSections?: string[];
}

/**
 * The live dossier for a project, or null.
 *
 * Exported so `mem::context` can inject it without duplicating the
 * "which row is current" rule, which is not simply `isLatest` — see below.
 */
export async function findLiveDossier(
  kv: StateKV,
  project: string,
): Promise<Memory | null> {
  const memories = await kv.list<Memory>(KV.memories);
  const matches = memories.filter(
    (m) =>
      m.isLatest !== false &&
      m.project === project &&
      m.title === dossierTitle(project) &&
      (m.concepts || []).includes(DOSSIER_CONCEPT),
  );
  if (matches.length === 0) return null;
  // Newest wins if a previous run was interrupted between writing the new
  // version and demoting the old one.
  matches.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return matches[0]!;
}

/**
 * Render the model's XML into the stored body.
 *
 * Rendering here rather than storing raw model prose keeps section order
 * stable across rebuilds and makes the size cap enforceable per section: when
 * the body is over budget, whole trailing items are dropped and the fact is
 * reported, instead of slicing the blob mid-sentence and leaving a dangling
 * citation.
 */
function renderDossier(
  xml: string,
  project: string,
): { body: string; truncated: string[] } {
  const identity = getXmlTag(xml, "identity").trim();
  const rendered: string[] = [`# ${dossierTitle(project)}`, ""];
  const truncated: string[] = [];

  if (identity) {
    rendered.push(identity, "");
  }

  for (const section of DOSSIER_SECTIONS) {
    if (section.key === "identity") continue;
    const items = getXmlChildren(xml, section.key, "item")
      .map((i) => i.trim())
      .filter(Boolean);
    if (items.length === 0) continue;

    const block: string[] = [`## ${section.heading}`, ""];
    let kept = 0;
    for (const item of items) {
      const candidate = [...rendered, ...block, `- ${item}`].join("\n");
      if (candidate.length > DOSSIER_MAX_CHARS) break;
      block.push(`- ${item}`);
      kept += 1;
    }
    if (kept === 0) {
      truncated.push(section.key);
      continue;
    }
    if (kept < items.length) {
      truncated.push(section.key);
    }
    block.push("");
    rendered.push(...block);
  }

  return { body: rendered.join("\n").trimEnd(), truncated };
}

export function registerDossierFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::dossier-build",
    async (data: {
      project?: string;
      force?: boolean;
    }): Promise<DossierBuildResult> => {
      const project = (data?.project || "").trim();
      if (!project) {
        return { success: false, error: "project is required" };
      }

      // Keyed on the project so two session-end events for the same repo
      // cannot interleave a read-modify-write of the same dossier chain and
      // leave two entries flagged isLatest.
      return withKeyedLock(`dossier:${project}`, async () => {
        const previous = await findLiveDossier(kv, project);
        const previousBuiltAt = previous
          ? new Date(previous.updatedAt).getTime()
          : 0;

        if (
          previous &&
          !data.force &&
          Date.now() - previousBuiltAt < getRebuildIntervalMs()
        ) {
          return { success: true, skipped: "debounced" as const };
        }

        const allSummaries = await kv.list<SessionSummary>(KV.summaries);
        const projectSummaries = allSummaries
          .filter((s) => s.project === project)
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );

        const allLessons = await kv.list<Lesson>(KV.lessons);
        const projectLessons = allLessons.filter(
          (l) =>
            !l.deleted &&
            l.project === project &&
            l.confidence >= MIN_LESSON_CONFIDENCE,
        );

        const allMemories = await kv.list<Memory>(KV.memories);
        const projectMemories = allMemories.filter(
          (m) =>
            m.isLatest !== false &&
            m.project === project &&
            !(m.concepts || []).includes(DOSSIER_CONCEPT),
        );

        if (
          projectSummaries.length === 0 &&
          projectLessons.length === 0 &&
          projectMemories.length === 0
        ) {
          return { success: true, skipped: "no-inputs" as const };
        }

        // Idempotency: a rebuild with nothing newer than the live dossier
        // would spend a provider call to produce the same document and a
        // second version of it. Acceptance requires two runs with no new
        // inputs to leave exactly one live version, so detect it here rather
        // than deduplicating after the fact.
        if (previous && !data.force) {
          const newest = Math.max(
            ...projectSummaries.map((s) => new Date(s.createdAt).getTime()),
            ...projectLessons.map((l) => new Date(l.updatedAt).getTime()),
            ...projectMemories.map((m) => new Date(m.updatedAt).getTime()),
            0,
          );
          if (newest <= previousBuiltAt) {
            return { success: true, skipped: "no-new-inputs" as const };
          }
        }

        const maxSummaries = getMaxSummaries();
        const usedSummaries = projectSummaries.slice(0, maxSummaries);
        const summariesDropped = projectSummaries.length - usedSummaries.length;
        if (summariesDropped > 0) {
          logger.info("Dossier input capped", {
            project,
            cap: maxSummaries,
            dropped: summariesDropped,
          });
        }

        // Counted rather than asked of the model — see buildDossierPrompt.
        const fileTally = new Map<string, number>();
        for (const s of usedSummaries) {
          for (const f of new Set(s.filesModified || [])) {
            fileTally.set(f, (fileTally.get(f) || 0) + 1);
          }
        }
        const fileCounts = [...fileTally.entries()]
          .map(([path, count]) => ({ path, count }))
          // The inclusion bar is "seen at least twice"; a file touched once
          // is not hot, it is incidental.
          .filter((f) => f.count >= 2)
          .sort((a, b) => b.count - a.count)
          .slice(0, HOT_FILE_LIMIT);

        const input: DossierInput = {
          project,
          summaries: usedSummaries.map((s) => ({
            sessionId: s.sessionId,
            title: s.title,
            narrative: s.narrative,
            keyDecisions: s.keyDecisions || [],
            filesModified: s.filesModified || [],
            concepts: s.concepts || [],
          })),
          lessons: projectLessons.map((l) => ({
            id: l.id,
            content: l.content,
            context: l.context,
            confidence: l.confidence,
            reinforcements: l.reinforcements,
          })),
          memories: projectMemories.map((m) => ({
            id: m.id,
            type: m.type,
            title: m.title,
            content: m.content,
          })),
          fileCounts,
          ...(previous ? { previous: previous.content } : {}),
        };

        let xml: string;
        try {
          xml = await provider.summarize(DOSSIER_SYSTEM, buildDossierPrompt(input));
        } catch (err) {
          // Loud. A dossier that silently stops rebuilding decays into
          // confidently-stale advice, which is worse than none.
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Dossier build failed", { project, error: message });
          return { success: false, error: message };
        }

        const { body, truncated } = renderDossier(xml, project);
        // A body with a heading and nothing under it means the model returned
        // no citable facts. Storing it would overwrite a good dossier with an
        // empty one.
        if (body.split("\n").filter((l) => l.startsWith("- ")).length === 0 &&
            !getXmlTag(xml, "identity").trim()) {
          logger.warn("Dossier build produced no qualifying content", { project });
          return { success: false, error: "empty_dossier" };
        }

        const now = new Date().toISOString();
        const memory: Memory = {
          id: generateId("mem"),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          type: "architecture",
          title: dossierTitle(project),
          content: body,
          concepts: [DOSSIER_CONCEPT, project],
          files: fileCounts.map((f) => f.path),
          sessionIds: usedSummaries.map((s) => s.sessionId),
          strength: 10,
          version: (previous?.version ?? 0) + 1,
          ...(previous ? { supersedes: [previous.id] } : {}),
          sourceObservationIds: projectLessons.map((l) => l.id),
          isLatest: true,
          project,
        };

        await kv.set(KV.memories, memory.id, memory);

        // Persisting the row is NOT enough to make it findable — the same
        // trap mem::remember documents as #257. The BM25 index is built at
        // startup and maintained on write; a memory written straight to KV
        // is invisible to search until the next restart. Measured here: the
        // first dossier stored fine and `search {query:"launchproof
        // dossier"}` returned five raw file_edit observations and no
        // dossier. Indexing failures are logged, not fatal — the row is
        // saved either way and the restart rebuild will pick it up.
        try {
          getSearchIndex().add(memoryToObservation(memory));
        } catch (err) {
          logger.warn("Failed to index dossier into BM25", {
            memoryId: memory.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await vectorIndexAddGuarded(
          memory.id,
          memory.sessionIds?.[0] ?? "memory",
          `${memory.title} ${memory.content}`,
          { kind: "memory", logId: memory.id },
        );

        if (previous) {
          // Written after the new one, so an interruption leaves two live
          // entries (recoverable, and findLiveDossier prefers the newest)
          // rather than none.
          await kv.set(KV.memories, previous.id, {
            ...previous,
            isLatest: false,
            updatedAt: now,
          });
        }

        // Unindex EVERY older version of this project's dossier, not just the
        // one we superseded.
        //
        // `isLatest: false` governs KV reads; it does not govern the search
        // indexes. The BM25 index is persisted to disk and restored on boot,
        // and the KV-driven rebuild only ADDS entries missing from the
        // restored index — nothing ever removes one. So a version indexed
        // while it was live stays searchable forever.
        //
        // Measured on the launchproof pilot: `search {query:"launchproof
        // dossier"}` returned the current dossier at rank 1 and a superseded
        // one at rank 2, from a fresh boot with no build in that process.
        // Two documents disagreeing, with nothing in either saying which is
        // current, is worse than one stale document.
        //
        // Sweeping all older versions rather than just `previous` makes each
        // build self-healing: it converges even for versions orphaned before
        // this code existed.
        const stale = allMemories.filter(
          (m) =>
            m.id !== memory.id &&
            m.project === project &&
            m.title === dossierTitle(project) &&
            (m.concepts || []).includes(DOSSIER_CONCEPT),
        );
        for (const old of stale) {
          try {
            getSearchIndex().remove(old.id);
            vectorIndexRemove(old.id);
          } catch (err) {
            logger.warn("Failed to unindex superseded dossier", {
              memoryId: old.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        scheduleIndexSave();

        await recordAudit(kv, "consolidate", "mem::dossier-build", [memory.id], {
          project,
          version: memory.version,
          supersededId: previous?.id,
        });

        logger.info("Dossier built", {
          project,
          version: memory.version,
          memoryId: memory.id,
          supersededId: previous?.id ?? null,
          summaries: usedSummaries.length,
          summariesDropped,
          lessons: projectLessons.length,
          memories: projectMemories.length,
          bytes: body.length,
          truncatedSections: truncated,
        });

        return {
          success: true,
          memoryId: memory.id,
          version: memory.version,
          ...(previous ? { supersededId: previous.id } : {}),
          inputs: {
            summaries: usedSummaries.length,
            summariesDropped,
            lessons: projectLessons.length,
            memories: projectMemories.length,
          },
          bytes: body.length,
          truncatedSections: truncated,
        };
      });
    },
  );
}
