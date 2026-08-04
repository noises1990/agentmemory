export const COMPRESSION_SYSTEM = `You are a memory compression engine for an AI coding agent. Your job is to extract the essential information from a tool usage observation and compress it into structured data.

Output EXACTLY this XML format with no additional text:

<observation>
  <type>one of: file_read, file_write, file_edit, command_run, search, web_fetch, conversation, error, decision, discovery, subagent, notification, task, other</type>
  <title>Short descriptive title (max 80 chars)</title>
  <subtitle>One-line context (optional)</subtitle>
  <facts>
    <fact>Specific factual detail 1</fact>
    <fact>Specific factual detail 2</fact>
  </facts>
  <narrative>2-3 sentence summary of what happened and why it matters</narrative>
  <concepts>
    <concept>technical concept or pattern</concept>
  </concepts>
  <files>
    <file>path/to/file</file>
  </files>
  <importance>1-10 scale, 10 being critical architectural decision</importance>
</observation>

Rules:
- Be concise but preserve ALL technically relevant details
- File paths must be exact
- Importance: 1-3 for routine reads, 4-6 for edits/commands, 7-9 for architectural decisions, 10 for breaking changes
- Concepts should be reusable search terms (e.g., "React hooks", "SQL migration", "auth middleware")
- Strip any secrets, tokens, or credentials from the output`;

/**
 * Legacy fixed budget: 4000 + 4000 + 2000 characters.
 *
 * These numbers capped a compression prompt at ~10k characters — roughly
 * 3k tokens — which meant the model never saw past the first 4 KB of a tool
 * result no matter how large its context window was. Compression feeds every
 * downstream stage, so anything dropped here is absent from summaries, the
 * graph and consolidation permanently, and nothing downstream can recover it.
 *
 * Kept as the floor so a small-window model behaves exactly as before.
 */
const LEGACY_INPUT_CHARS = 4_000;
const LEGACY_OUTPUT_CHARS = 4_000;
const LEGACY_USER_PROMPT_CHARS = 2_000;

/** Share of the prompt budget each field may claim. */
const SHARE = { input: 0.35, output: 0.45, userPrompt: 0.2 };

/**
 * Ceiling on a single compression prompt, independent of how large the
 * model's window is.
 *
 * The window says what fits; it does not say what is worth paying for.
 * Compression is the highest-volume call in the system — ~1450 in a day of
 * normal use — so letting each one grow to fill a 128k or 1M window turns a
 * rare large tool result into a recurring bill. 100k characters (~31k
 * tokens) is 10x the old fixed limit and swallows the overwhelming majority
 * of real observations whole; the rest are still truncated, but visibly and
 * at a defensible point. Raise with AGENTMEMORY_COMPRESS_MAX_CHARS.
 */
const DEFAULT_MAX_PROMPT_CHARS = 100_000;

function maxPromptChars(): number {
  const raw = process.env["AGENTMEMORY_COMPRESS_MAX_CHARS"];
  if (!raw) return DEFAULT_MAX_PROMPT_CHARS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PROMPT_CHARS;
}

export interface CompressionBudget {
  input: number;
  output: number;
  userPrompt: number;
}

/**
 * Split a total character budget across the three variable-length fields,
 * never going below the legacy limits.
 *
 * Tool output gets the largest share: it is where the substance is, and it
 * is the field most often truncated in practice.
 */
export function compressionBudget(totalChars?: number): CompressionBudget {
  if (!totalChars || !Number.isFinite(totalChars) || totalChars <= 0) {
    return {
      input: LEGACY_INPUT_CHARS,
      output: LEGACY_OUTPUT_CHARS,
      userPrompt: LEGACY_USER_PROMPT_CHARS,
    };
  }
  const capped = Math.min(totalChars, maxPromptChars());
  return {
    input: Math.max(LEGACY_INPUT_CHARS, Math.floor(capped * SHARE.input)),
    output: Math.max(LEGACY_OUTPUT_CHARS, Math.floor(capped * SHARE.output)),
    userPrompt: Math.max(
      LEGACY_USER_PROMPT_CHARS,
      Math.floor(capped * SHARE.userPrompt),
    ),
  };
}

export function buildCompressionPrompt(
  observation: {
    hookType: string;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: unknown;
    userPrompt?: string;
    timestamp: string;
  },
  budget: CompressionBudget = compressionBudget(),
): string {
  const parts = [
    `Timestamp: ${observation.timestamp}`,
    `Hook: ${observation.hookType}`,
  ];

  if (observation.toolName) parts.push(`Tool: ${observation.toolName}`);
  if (observation.toolInput) {
    const input =
      typeof observation.toolInput === "string"
        ? observation.toolInput
        : JSON.stringify(observation.toolInput, null, 2);
    parts.push(`Input:\n${truncate(input, budget.input)}`);
  }
  if (observation.toolOutput) {
    const output =
      typeof observation.toolOutput === "string"
        ? observation.toolOutput
        : JSON.stringify(observation.toolOutput, null, 2);
    parts.push(`Output:\n${truncate(output, budget.output)}`);
  }
  if (observation.userPrompt) {
    parts.push(`User prompt:\n${truncate(observation.userPrompt, budget.userPrompt)}`);
  }

  return parts.join("\n\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n[...truncated]" : s;
}
