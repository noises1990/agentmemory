/**
 * A session opened at a drive root has no basename to name its project after,
 * and an empty project is refused by the daemon (400). Claude Code's desktop
 * app opens sessions at `C:\` by default, so this is the common case, not an
 * edge: on 2026-09-05 every hook of such a session was refused while the same
 * session captured fine whenever its cwd had moved into a real folder.
 */
import { describe, it, expect } from "vitest";
import { resolveProject, rootProjectName } from "../src/hooks/_project.js";

describe("project name for a working directory with no basename", () => {
  it("names a Windows drive root after the drive", () => {
    expect(rootProjectName("C:\\")).toBe("drive-c");
    expect(rootProjectName("X:/")).toBe("drive-x");
    expect(rootProjectName("c:")).toBe("drive-c");
  });

  it("names the POSIX root 'root'", () => {
    expect(rootProjectName("/")).toBe("root");
  });

  it("never resolves to an empty project for a drive root", () => {
    // Outside any git repository, resolveProject falls through to basename();
    // for a drive root that is "", which the daemon rejects.
    expect(resolveProject("C:\\")).not.toBe("");
    expect(resolveProject("C:\\")).toBe("drive-c");
  });

  it("still uses the folder name for an ordinary path", () => {
    expect(resolveProject("C:\\Users\\nobody\\some-folder-that-is-not-a-repo")).toBe(
      "some-folder-that-is-not-a-repo",
    );
  });
});
