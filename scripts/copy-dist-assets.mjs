#!/usr/bin/env node
//
// Copy the non-TS build assets into `dist/` after tsdown runs.
//
// This used to be a chain of `cp ... 2>/dev/null || true` and `mkdir -p`
// appended to the `build` script. npm runs scripts through cmd.exe on
// Windows, where `cp`, `mkdir -p` and `2>/dev/null` are all syntax
// errors — so every Windows build printed "The system cannot find the
// path specified." four times, "The syntax of the command is incorrect."
// once, and still exited 0 because tsdown had already succeeded. The
// result was a dist/ with no engine config, no .env template and no
// viewer: `agentmemory` would boot and then fail to find its own
// iii-config.yaml, and port 3113 served nothing.
//
// The `|| true` was load-bearing on POSIX too: iii-config.docker.yaml and
// docker-compose.yml are genuinely optional in some checkouts. Optional
// files stay optional here (skipped, logged); required ones fail loudly
// instead of silently producing a broken package.
//
// Usage:
//   node scripts/copy-dist-assets.mjs

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const DIST = join(ROOT, "dist");

/** @type {{from: string, to: string, required: boolean}[]} */
const ASSETS = [
  { from: "iii-config.yaml", to: "iii-config.yaml", required: true },
  { from: "iii-config.docker.yaml", to: "iii-config.docker.yaml", required: false },
  { from: "docker-compose.yml", to: "docker-compose.yml", required: false },
  { from: ".env.example", to: ".env.example", required: true },
  { from: "src/viewer/index.html", to: "viewer/index.html", required: true },
  { from: "src/viewer/favicon.svg", to: "viewer/favicon.svg", required: true },
];

if (!existsSync(DIST)) {
  console.error(`copy-dist-assets: ${DIST} does not exist — run tsdown first.`);
  process.exit(1);
}

const missing = [];
let copied = 0;

for (const asset of ASSETS) {
  const src = join(ROOT, asset.from);
  const dest = join(DIST, asset.to);

  if (!existsSync(src)) {
    if (asset.required) missing.push(asset.from);
    else console.log(`copy-dist-assets: skipped optional ${asset.from} (absent)`);
    continue;
  }

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied += 1;
}

if (missing.length > 0) {
  console.error(
    `copy-dist-assets: missing required asset(s):\n${missing.map((m) => `  - ${m}`).join("\n")}`,
  );
  process.exit(1);
}

console.log(`copy-dist-assets: copied ${copied} asset(s) into dist/`);
