import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("cli runtime ownership", () => {
  it("does not import the worker in normal engine-owned startup paths", () => {
    const source = readFileSync("src/cli.ts", "utf-8");
    const normalStartup = source.slice(
      source.indexOf("if (await isEngineRunning())"),
      source.indexOf("function installInstructions()"),
    );

    expect(normalStartup).not.toContain('await import("./index.js")');
  });

  it("keeps --no-engine as the only direct worker import path", () => {
    const source = readFileSync("src/cli.ts", "utf-8");
    const imports = source.match(/await import\("\.\/index\.js"\)/g) ?? [];

    expect(imports).toHaveLength(1);
    expect(source).toMatch(/if \(skipEngine\)[\s\S]*await import\("\.\/index\.js"\)/);
  });
});
