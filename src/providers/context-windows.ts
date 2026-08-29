/**
 * Context window sizes per model, and the prompt budget derived from them.
 *
 * Why this exists: `summarize.ts` chunked sessions at a hardcoded 400
 * observations, chosen — per its own comment — because that is "≈ 50k input
 * tokens, which fits comfortably in 128k-window models". The configured
 * model was `llama-3.1-8b-instruct-fp8`, whose window is 32k. Every summary
 * of a substantial session therefore failed with HTTP 413 before the
 * provider did any work, and the retry sent the identical oversized prompt.
 *
 * A constant tuned for one model cannot survive the model being swapped in
 * an env var. The budget has to be derived from the model actually in use,
 * and the chunker has to measure the prompt it is about to send rather than
 * assume a per-observation average — observation sizes vary by more than an
 * order of magnitude, so a fixed count is the wrong unit entirely.
 *
 * Windows below were read from the live Workers AI catalogue
 * (`/accounts/{id}/ai/models/search`) rather than model cards, so they
 * reflect what the deployment actually enforces.
 */

/** Used when the model is unknown. Small enough to be safe on anything. */
const FALLBACK_WINDOW = 32_000;

/**
 * Longest-suffix match wins, so `workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8`
 * and a bare `@cf/meta/llama-3.1-8b-instruct-fp8` resolve identically.
 */
const WINDOWS: ReadonlyArray<readonly [string, number]> = [
  // DeepSeek. V4 Flash and Pro landed in the Workers AI catalogue on
  // 2026-08-14 (`@cf/deepseek-ai/deepseek-v4-flash-0731`,
  // `@cf/deepseek-ai/deepseek-v4-pro-0813`), so they no longer need an AI
  // Gateway custom provider. Matching is longest-substring, so the undated
  // needles below already cover the dated Workers AI ids and the bare
  // `deepseek/deepseek-v4-*` names any older config still carries.
  ["deepseek-v4-flash", 1_048_576],
  ["deepseek-v4-pro", 1_048_576],
  ["deepseek-chat", 128_000],
  ["deepseek-reasoner", 128_000],

  // Workers AI — text generation
  ["glm-5.2", 262_144],
  ["kimi-k2.7-code", 262_144],
  ["kimi-k2.6", 262_144],
  ["nemotron-3-120b-a12b", 256_000],
  ["gemma-4-26b-a4b-it", 256_000],
  ["glm-4.7-flash", 131_072],
  ["llama-guard-3-8b", 131_072],
  ["llama-4-scout-17b-16e-instruct", 131_000],
  ["granite-4.0-h-micro", 131_000],
  ["gpt-oss-20b", 128_000],
  ["gpt-oss-120b", 128_000],
  ["mistral-small-3.1-24b-instruct", 128_000],
  ["llama-3.2-11b-vision-instruct", 128_000],
  ["gemma-sea-lion-v4-27b-it", 128_000],
  ["llama-3.2-3b-instruct", 80_000],
  ["deepseek-r1-distill-qwen-32b", 80_000],
  ["llama-3.2-1b-instruct", 60_000],
  ["qwen3-30b-a3b-fp8", 32_768],
  ["qwen2.5-coder-32b-instruct", 32_768],
  ["llama-3.1-8b-instruct-fp8", 32_000],
  ["llama-3.1-8b-instruct", 32_000],
  ["qwq-32b", 24_000],
  ["llama-3.3-70b-instruct-fp8-fast", 24_000],
  ["mistral-7b-instruct-v0.2-lora", 15_000],
  ["llama-2-7b-chat-hf-lora", 8_192],
  ["gemma-2b-it-lora", 8_192],
  ["gemma-7b-it-lora", 3_500],
];

/** Runtime corrections learned from 413s — see `noteContextLimit`. */
const learned = new Map<string, number>();

function parsePositive(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the usable context window for a model id, in tokens.
 *
 * Precedence: explicit env override > limit learned from a real 413 >
 * catalogue > conservative fallback. The learned value beats the table
 * because it came from the deployment that rejected us.
 */
export function resolveContextWindow(model: string): number {
  const override = parsePositive(process.env["AGENTMEMORY_CONTEXT_WINDOW"]);
  if (override) return override;

  const id = (model || "").toLowerCase();
  const remembered = learned.get(id);
  if (remembered) return remembered;

  let best: number | null = null;
  let bestLen = -1;
  for (const [needle, window] of WINDOWS) {
    if (id.includes(needle) && needle.length > bestLen) {
      best = window;
      bestLen = needle.length;
    }
  }
  return best ?? FALLBACK_WINDOW;
}

/**
 * Record a context limit reported by the provider in a 413, so subsequent
 * chunking for this model uses the real number instead of the table.
 */
export function noteContextLimit(model: string, limit: number): void {
  if (!model || !Number.isFinite(limit) || limit <= 0) return;
  learned.set(model.toLowerCase(), limit);
}

/** Test seam. */
export function resetLearnedContextLimits(): void {
  learned.clear();
}

/**
 * Output budget requested per call (MAX_TOKENS), which must be reserved out
 * of the window — providers size the request as input + max output, and
 * Cloudflare's 413 is raised against that sum, not against the input alone.
 */
export function getMaxOutputTokens(): number {
  const n = parseInt(process.env["MAX_TOKENS"] || "4096", 10);
  return Number.isFinite(n) && n > 0 ? n : 4096;
}

/**
 * Characters per token. English prose runs ~4; source code, paths and JSON —
 * which is most of what an observation contains — run denser. 3.2 buys
 * headroom without halving throughput.
 */
const CHARS_PER_TOKEN = 3.2;

/** Tokens reserved for the system prompt and the response envelope. */
const PROMPT_OVERHEAD_TOKENS = 1_500;

/**
 * Fraction of the remaining window we are willing to fill. Providers count
 * tokens with their own tokenizer, and Cloudflare's 413 is raised against
 * `input + max_output`, so the estimate must be beaten with room to spare.
 */
const SAFETY = 0.8;

/**
 * Maximum prompt size in characters for one call to `model`, given the
 * output budget that will be requested alongside it.
 *
 * Returns at least 2000 characters: if the output budget alone exceeds the
 * window the configuration is broken, but returning zero or a negative
 * budget would spin the chunker forever.
 */
export function promptCharBudget(model: string, maxOutputTokens: number): number {
  const window = resolveContextWindow(model);
  const usable = window - maxOutputTokens - PROMPT_OVERHEAD_TOKENS;
  const chars = Math.floor(usable * SAFETY * CHARS_PER_TOKEN);
  return Math.max(2_000, chars);
}
