/**
 * Per-repository dossier prompts.
 *
 * A dossier is ONE curated memory per repository, rebuilt from that repo's
 * session summaries, lessons and recorded decisions. It exists so a consumer
 * that asks "what should I know about this repo" gets a single maintained
 * document instead of a search over hundreds of raw `file_edit` observations.
 *
 * The output is XML rather than prose because the caller renders the sections
 * itself: that keeps the section order stable across rebuilds, lets empty
 * sections be dropped without the model inventing filler, and makes the size
 * cap enforceable per section instead of by truncating a blob mid-sentence.
 */

/**
 * Sections, in render order. `key` is the XML tag; `heading` is what a reader
 * sees. Kept as data so the renderer, the prompt and the size cap iterate the
 * same list and cannot drift apart.
 */
export const DOSSIER_SECTIONS = [
  { key: "identity", heading: "What this repo is" },
  { key: "conventions", heading: "Conventions that bite" },
  { key: "gotchas", heading: "Known flakes & gotchas" },
  { key: "decisions", heading: "Standing decisions" },
  { key: "hotfiles", heading: "Hot files & blast radius" },
  { key: "risks", heading: "Open risks" },
] as const;

export type DossierSectionKey = (typeof DOSSIER_SECTIONS)[number]["key"];

export const DOSSIER_SYSTEM = `You maintain a factual dossier about ONE software repository, for AI agents that are about to work in it.

Your reader is an agent starting cold. It has the code. It does not have the history. Tell it only what the code cannot tell it.

INCLUSION BAR — this is the whole point of the document:
- Include a fact only if the input shows it at least TWICE independently, or a lesson/decision already records it, or a human confirmed it.
- A one-off event is not a convention. A single failing test is not a flake.
- Every entry must cite the source ids it came from, in square brackets, e.g. [ses_abc123, les_def456].
- If you cannot cite it, do not write it.
- Prefer a specific, checkable statement over a general one. "Integration tests need the shared Postgres container; if you see 'relation \\"findings\\" does not exist', re-run with X" beats "tests can be flaky".

NEVER include: secrets, tokens, keys, passwords, connection strings with credentials, personal data, or anything that looks like one.

Write for an agent, not a person: terse, imperative, no preamble, no marketing, no encouragement.

Output EXACTLY this XML and nothing else. Omit any section you have no qualifying facts for — an omitted section is correct, an invented one is not.

<dossier>
<identity>2-3 sentences: what this repo is and what it is for.</identity>
<conventions>
<item>A convention with teeth — test layout, CI structure, a style rule that fails the build. [source ids]</item>
</conventions>
<gotchas>
<item>A recurring flake or trap, WITH the verified fix or retry command. [source ids]</item>
</gotchas>
<decisions>
<item>A settled decision a reviewer or implementer must not re-litigate, and why. [source ids]</item>
</decisions>
<hotfiles>
<item>path/to/file.ts — why it matters, what it breaks when changed. [source ids]</item>
</hotfiles>
<risks>
<item>A recurring unresolved problem. [source ids]</item>
</risks>
</dossier>`;

export interface DossierInput {
  project: string;
  /** Session summaries for this project, newest first. */
  summaries: Array<{
    sessionId: string;
    title: string;
    narrative: string;
    keyDecisions: string[];
    filesModified: string[];
    concepts: string[];
  }>;
  /** Lessons scoped to this project. */
  lessons: Array<{
    id: string;
    content: string;
    context: string;
    confidence: number;
    reinforcements: number;
  }>;
  /** Existing curated memories for this project (excluding prior dossiers). */
  memories: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
  }>;
  /** path -> number of summaries that modified it. Feeds "hot files". */
  fileCounts: Array<{ path: string; count: number }>;
  /** The previous dossier body, when rebuilding. */
  previous?: string;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function buildDossierPrompt(input: DossierInput): string {
  const parts: string[] = [];

  parts.push(`REPOSITORY: ${input.project}`);
  parts.push("");

  if (input.previous) {
    // The previous dossier is context, not a floor. Saying so explicitly
    // matters: without it the model treats the prior text as ground truth and
    // carries forward entries whose evidence has since been superseded.
    parts.push(
      "PREVIOUS DOSSIER (for continuity only — drop anything the evidence below no longer supports, and do not treat it as a source):",
    );
    parts.push(truncate(input.previous, 6000));
    parts.push("");
  }

  if (input.lessons.length > 0) {
    // Lessons first: they already cleared a bar. A lesson is a fact someone
    // or something already judged worth keeping, so it outranks a summary.
    parts.push("LESSONS (already-curated; highest-trust input):");
    for (const l of input.lessons) {
      parts.push(
        `- [${l.id}] (confidence ${l.confidence.toFixed(2)}, reinforced ${l.reinforcements}x) ${truncate(l.content, 600)}` +
          (l.context ? ` — context: ${truncate(l.context, 300)}` : ""),
      );
    }
    parts.push("");
  }

  if (input.memories.length > 0) {
    parts.push("CURATED MEMORIES:");
    for (const m of input.memories) {
      parts.push(`- [${m.id}] (${m.type}) ${m.title}: ${truncate(m.content, 600)}`);
    }
    parts.push("");
  }

  if (input.summaries.length > 0) {
    parts.push("SESSION SUMMARIES (newest first):");
    for (const s of input.summaries) {
      parts.push(`- [${s.sessionId}] ${s.title}`);
      if (s.narrative) parts.push(`  ${truncate(s.narrative, 700)}`);
      for (const d of s.keyDecisions) {
        parts.push(`  DECISION: ${truncate(d, 400)}`);
      }
    }
    parts.push("");
  }

  if (input.fileCounts.length > 0) {
    // Counted here rather than asked of the model: "which files are touched
    // most" is arithmetic, and a model asked to tally will approximate.
    parts.push("FILE EDIT FREQUENCY (path — sessions that modified it):");
    for (const f of input.fileCounts) {
      parts.push(`- ${f.path} — ${f.count}`);
    }
    parts.push("");
  }

  parts.push(
    "Write the dossier for this repository now. Cite source ids for every entry. Omit sections with no qualifying facts.",
  );

  return parts.join("\n");
}
