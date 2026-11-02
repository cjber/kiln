import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { toolPath } from "./workdir";

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
