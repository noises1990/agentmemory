import type { MemoryProvider } from "../types.js";
import { getEnvVar } from "../config.js";

function requireEnvVar(key: string): string {
  const value = getEnvVar(key);
  if (!value) {
    throw new Error(`${key} is required for the cloudflare provider`);
  }
  return value;
}

function getBaseUrl(): string {
  const override = getEnvVar("CLOUDFLARE_AI_BASE_URL");
  if (override) {
    return override;
  }
  const accountId = requireEnvVar("CLOUDFLARE_ACCOUNT_ID");
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
}

export class CloudflareProvider implements MemoryProvider {
  name = "cloudflare";
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;

  constructor(apiKey: string, model: string, maxTokens: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.baseUrl = getBaseUrl();
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        max_completion_tokens: this.maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`cloudflare API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null; reasoning?: string | null };
        text?: string | null;
      }>;
    };
    const choice = data.choices?.[0];
    const content =
      choice?.message?.content ?? choice?.message?.reasoning ?? choice?.text;
    if (!content || !content.trim()) {
      throw new Error(
        `cloudflare returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return content;
  }
}
