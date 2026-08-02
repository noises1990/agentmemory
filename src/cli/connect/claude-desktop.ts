import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createJsonMcpAdapter } from "./json-mcp-adapter.js";

// Claude Desktop is a SEPARATE install from Claude Code and reads a
// different file. Wiring claude-code touches ~/.claude.json; Desktop never
// looks at it, so a user with both installed would see agentmemory in the
// terminal and not in the app, with nothing explaining the difference.
//
// Paths are the documented per-platform Electron userData locations:
//   Windows  %APPDATA%\Claude\claude_desktop_config.json
//   macOS    ~/Library/Application Support/Claude/claude_desktop_config.json
//   Linux    ~/.config/Claude/claude_desktop_config.json
function claudeDesktopDir(): string {
  if (platform() === "win32") {
    // APPDATA is set for any interactive Windows session; the join()
    // fallback keeps this total if connect runs from a stripped
    // environment (a service, a CI runner) rather than throwing.
    const appData =
      process.env["APPDATA"] || join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude");
  }
  return join(homedir(), ".config", "Claude");
}

const DIR = claudeDesktopDir();

export const adapter = createJsonMcpAdapter({
  name: "claude-desktop",
  displayName: "Claude Desktop",
  detectDir: DIR,
  configPath: join(DIR, "claude_desktop_config.json"),
  docs: "https://github.com/rohitg00/agentmemory#other-agents",
  protocolNote:
    "→ Using MCP. Claude Desktop reads claude_desktop_config.json, not ~/.claude.json — wiring claude-code does not cover it.",
});
