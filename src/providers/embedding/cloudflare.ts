import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";

const DEFAULT_MODEL = "@cf/baai/bge-base-en-v1.5";

function requireEnvVar(key: string): string {
  const value = getEnvVar(key);
  if (!value) {
    throw new Error(`${key} is required for the cloudflare embedding provider`);
  }
  return value;
}

function resolveDimensions(model: string): number {
  const override =
    getEnvVar("CLOUDFLARE_EMBEDDING_DIMENSIONS") ||
    getEnvVar("OPENAI_EMBEDDING_DIMENSIONS");
  if (override && override.trim().length > 0) {
    const parsed = parseInt(override, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `CLOUDFLARE_EMBEDDING_DIMENSIONS must be a positive integer, got: ${override}`,
      );
    }
    return parsed;
  }
  if (model === "@cf/baai/bge-base-en-v1.5") {
    return 768;
  }
  return 768;
}

function getBaseUrl(): string {
  const accountId = requireEnvVar("CLOUDFLARE_ACCOUNT_ID");
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/embeddings`;
}

export class CloudflareEmbeddingProvider implements EmbeddingProvider {
  readonly name = "cloudflare";
  readonly dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || getEnvVar("CLOUDFLARE_API_TOKEN") || "";
    if (!this.apiKey) {
      throw new Error("CLOUDFLARE_API_TOKEN is required");
    }
    this.model =
      getEnvVar("CLOUDFLARE_EMBEDDING_MODEL") ||
      getEnvVar("OPENAI_EMBEDDING_MODEL") ||
      DEFAULT_MODEL;
    this.dimensions = resolveDimensions(this.model);
    this.baseUrl = getBaseUrl();
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cloudflare embedding failed (${response.status}): ${err}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map((d) => new Float32Array(d.embedding));
  }
}
