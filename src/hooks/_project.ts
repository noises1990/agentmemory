import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/**
 * Find the repository root by walking up for a `.git` entry.
 *
 * This replaced `git rev-parse --show-toplevel`, which was spawned with a
 * 500ms timeout on EVERY hook invocation — and hooks run on every tool
 * call. Process spawn on Windows costs a large fraction of that budget
 * before git does any work, so on a loaded machine the call timed out,
 * the catch swallowed it, and resolution silently fell through to
 * basename(cwd). For a nested cwd that means observations were filed
 * under "hooks" instead of "agentmemory", fragmenting a project's memory
 * across directory names under load — the exact condition where you are
 * least likely to notice.
 *
 * The walk answers the same question with a few stat() calls and no
 * subprocess, so there is no timeout left to lose. `.git` is a directory
 * in a normal clone and a file in a worktree or submodule; either way the
 * directory containing it is the toplevel, which is what git reports.
 */
function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  // Bounded so a pathological path or a symlink cycle cannot spin.
  for (let i = 0; i < 64; i++) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Resolution order: AGENTMEMORY_PROJECT_NAME env → git toplevel basename → cwd basename.
export function resolveProject(cwd?: string): string {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  try {
    const root = findRepoRoot(dir);
    if (root) return basename(root);
  } catch {}
  return basename(dir) || rootProjectName(dir);
}

/**
 * A drive root (`C:\`) or `/` has no basename, and an empty project makes the
 * daemon refuse the observation with a 400 -- correctly, since a nameless
 * project would be unrecoverable. Claude Code's desktop app opens sessions at
 * `C:\` by default, so on 2026-09-05 every hook of such a session was refused
 * while the same session captured fine whenever its working directory had
 * wandered into a real folder. The name is the truth about where the session
 * ran, not a placeholder: `drive-c` for `C:\`, `root` for `/`.
 */
export function rootProjectName(dir: string): string {
  const drive = /^([A-Za-z]):[\\/]*$/.exec(dir.trim());
  if (drive) return `drive-${drive[1]!.toLowerCase()}`;
  return "root";
}
