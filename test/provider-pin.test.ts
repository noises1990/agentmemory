import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AGENTMEMORY_PROVIDER used to be read only by hasLLMProviderConfigured, so
// provider selection was decided purely by which key happened to be present.
// Anyone with a leftover OPENAI_API_KEY in their user environment got OpenAI
// no matter what they configured — and found out from the invoice.

const ENV_KEYS = [
  "AGENTMEMORY_PROVIDER",
  "AGENTMEMORY_ALLOW_AGENT_SDK",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_FOR_LLM",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MINIMAX_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_MODEL",
  "CONSOLIDATION_ENABLED",
];

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];
const ORIGINAL: Record<string, string | undefined> = {};

let sandboxHome: string;

async function freshConfig() {
  vi.resetModules();
  return await import("../src/config.js");
}

function writeEnv(contents: string) {
  const dir = join(sandboxHome, ".agentmemory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), contents);
}

describe("AGENTMEMORY_PROVIDER pinning", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-provider-pin-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    for (const k of ENV_KEYS) {
      ORIGINAL[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    for (const k of ENV_KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("selects the pinned provider even when a higher-precedence key is present", async () => {
    writeEnv(
      "AGENTMEMORY_PROVIDER=cloudflare\nOPENAI_API_KEY=sk-stray\nCLOUDFLARE_API_TOKEN=cf-token",
    );
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("cloudflare");
  });

  it("keeps key-presence precedence when unpinned", async () => {
    writeEnv("OPENAI_API_KEY=sk-stray\nCLOUDFLARE_API_TOKEN=cf-token");
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("openai");
  });

  it("falls back to noop — never another provider — when the pinned key is missing", async () => {
    writeEnv("AGENTMEMORY_PROVIDER=cloudflare\nANTHROPIC_API_KEY=sk-ant-stray");
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("noop");
  });

  it("names the missing credential rather than failing silently", async () => {
    writeEnv("AGENTMEMORY_PROVIDER=cloudflare");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cfg = await freshConfig();
    cfg.loadConfig();
    const output = stderr.mock.calls.map((c) => String(c[0])).join("");
    stderr.mockRestore();
    expect(output).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("rejects an unknown provider name instead of guessing", async () => {
    writeEnv("AGENTMEMORY_PROVIDER=cloudfare\nCLOUDFLARE_API_TOKEN=cf-token");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cfg = await freshConfig();
    const provider = cfg.loadConfig().provider.provider;
    const output = stderr.mock.calls.map((c) => String(c[0])).join("");
    stderr.mockRestore();
    expect(provider).toBe("noop");
    expect(output).toContain("not a known provider");
  });

  it("is case- and whitespace-insensitive", async () => {
    writeEnv("AGENTMEMORY_PROVIDER=  CloudFlare  \nCLOUDFLARE_API_TOKEN=cf-token");
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("cloudflare");
  });

  it("honours AGENTMEMORY_PROVIDER=noop even with a usable key", async () => {
    writeEnv("AGENTMEMORY_PROVIDER=noop\nANTHROPIC_API_KEY=sk-ant-123");
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("noop");
  });

  it("still requires AGENTMEMORY_ALLOW_AGENT_SDK to reach agent-sdk", async () => {
    writeEnv("AGENTMEMORY_PROVIDER=agent-sdk");
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("noop");
  });

  it("selects agent-sdk when both the pin and the opt-in flag are set", async () => {
    writeEnv("AGENTMEMORY_PROVIDER=agent-sdk\nAGENTMEMORY_ALLOW_AGENT_SDK=true");
    const cfg = await freshConfig();
    expect(cfg.loadConfig().provider.provider).toBe("agent-sdk");
  });
});

describe("consolidation gating follows the same provider view", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-provider-pin-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    for (const k of ENV_KEYS) {
      ORIGINAL[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    for (const k of ENV_KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  // consolidation-pipeline.ts already told users CLOUDFLARE_API_TOKEN enables
  // consolidation; hasLLMProviderConfigured never checked for it, so a
  // Cloudflare-only install ran with consolidation quietly off.
  it("counts CLOUDFLARE_API_TOKEN as a configured provider", async () => {
    writeEnv("CLOUDFLARE_API_TOKEN=cf-token");
    const cfg = await freshConfig();
    expect(cfg.isConsolidationEnabled()).toBe(true);
  });

  it("ignores a stale key for a different provider when pinned", async () => {
    writeEnv("AGENTMEMORY_PROVIDER=cloudflare\nANTHROPIC_API_KEY=sk-ant-stale");
    const cfg = await freshConfig();
    expect(cfg.isConsolidationEnabled()).toBe(false);
  });
});
