import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, toolPath } from "./workdir";

test("edits, patches and a leading cd name where an agent works; reads and relative paths do not", () => {
  expect(toolPath("Edit", { file_path: "/repo/src/a.ts" })).toBe("/repo/src/a.ts");
  expect(toolPath("edit", { path: "/repo/src/a.ts" })).toBe("/repo/src/a.ts");
  expect(
    toolPath("apply_patch", { patchText: "*** Begin Patch\n*** Update File: /wt/src/a.ts\n@@\n-a\n+b\n*** End Patch" }),
  ).toBe("/wt/src/a.ts");
  expect(toolPath("shell", { command: "cd ~/.worktrees/fix && git status" })).toBe(`${homedir()}/.worktrees/fix`);
  expect(toolPath("Bash", { command: 'cd "/repo" ; ls' })).toBe("/repo");
  expect(toolPath("Bash", { command: "git -C /repo status" })).toBeUndefined();
  expect(toolPath("Read", { file_path: "/other/README.md" })).toBeUndefined();
  expect(toolPath("Write", { file_path: "relative.ts" })).toBeUndefined();
});

test("counting a checkout's changes leaves its index alone, so a commit there never meets a lock", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-status-"));
  try {
    const git = (...args: string[]) => {
      const done = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
      if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    };
    git("init", "-q");
    writeFileSync(join(root, "a"), "a\n");
    git("add", "a");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "a");
    // A changed timestamp is what makes a plain `git status` refresh the index and write it back.
    utimesSync(join(root, "a"), 1, 1);
    writeFileSync(join(root, "b"), "b\n");
    const index = () => statSync(join(root, ".git", "index")).ino;
    const before = index();

    const counted = Bun.spawnSync([...changedFiles], { cwd: root });

    expect(counted.stdout.toString()).toBe("?? b\n");
    expect(index()).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
