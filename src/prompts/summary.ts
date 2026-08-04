export const SUMMARY_SYSTEM = `You are a session summarizer for an AI coding agent's memory system. Given all compressed observations from a coding session, produce a concise session summary.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars)</title>
  <narrative>3-5 sentence narrative of what was accomplished</narrative>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Focus on outcomes, not individual tool calls
- Highlight decisions and their rationale
- List all files that were created or modified
- Concepts should be searchable terms for future context retrieval`

export interface PromptObservation {
  type: string
  title: string
  facts: string[]
  narrative: string
  files: string[]
  concepts: string[]
}

/** Separator between rendered observations. */
export const OBSERVATION_SEPARATOR = '\n\n---\n\n'

/**
 * Render one observation exactly as it appears in the prompt.
 *
 * Exported so the chunker in summarize.ts can measure the true cost of each
 * observation instead of assuming a per-observation average. Observation
 * sizes vary by more than an order of magnitude, so an average silently
 * overshoots the model's context window on any session with a few large
 * entries — which is how every summary of a real session came to fail with
 * HTTP 413. Sharing the renderer keeps the measurement from drifting away
 * from what is actually sent.
 */
export function renderObservation(obs: PromptObservation, index: number): string {
  const facts = obs.facts.map((f) => `  - ${f}`).join('\n')
  return `[${index + 1}] ${obs.type}: ${obs.title}\n${obs.narrative}\nFacts:\n${facts}\nFiles: ${obs.files.join(', ')}`
}

export function buildSummaryPrompt(observations: PromptObservation[]): string {
  const lines = observations.map((obs, i) => renderObservation(obs, i))
  return `Session observations (${observations.length} total):\n\n${lines.join(OBSERVATION_SEPARATOR)}`
}

export const REDUCE_SYSTEM = `You are merging multiple partial summaries of the SAME coding session into one final session summary. The partials are chronological chunks of one continuous session — not separate sessions.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars)</title>
  <narrative>3-5 sentence narrative covering the whole session</narrative>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Synthesize a single narrative that reflects the whole arc, not a chunk-by-chunk recap
- Preserve every distinct decision across chunks
- Union (deduplicate) all files and concepts
- Title should capture the session's overall outcome`

export function buildReducePrompt(partials: Array<{
  title: string
  narrative: string
  keyDecisions: string[]
  filesModified: string[]
  concepts: string[]
  obsRangeStart: number
  obsRangeEnd: number
}>): string {
  const sections = partials.map((p, i) => {
    const decisions = p.keyDecisions.map((d) => `  - ${d}`).join('\n')
    const files = p.filesModified.map((f) => `  - ${f}`).join('\n')
    const concepts = p.concepts.join(', ')
    return `[Chunk ${i + 1} of ${partials.length} — obs ${p.obsRangeStart}-${p.obsRangeEnd}]
Title: ${p.title}
Narrative: ${p.narrative}
Decisions:
${decisions}
Files:
${files}
Concepts: ${concepts}`
  })
  return `Partial summaries (${partials.length} chunks of one session, chronological):\n\n${sections.join('\n\n---\n\n')}`
}
