import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequest } from "./dashboard";
import { sessionDetail } from "./session-detail";
import { repositoryName, type Session } from "./sessions";

const worktree = join(homedir(), ".worktrees", "tweaks-quest-xp");
const session: Session = {
  agent: "claude",
  title: "Addon releases, quest XP bar",
  cwd: worktree,
  branch: "cb/quest-xp-bar",
  startedAt: 1,
  place: { kind: "kiln", name: "quest" },
};
const pull = (checks: PullRequest["checks"]): PullRequest => ({
  number: 123,
  url: "https://github.com/cjber/tweaks-forever/pull/123",
  state: "OPEN",
  draft: false,
  additions: 1,
  deletions: 1,
  queued: false,
  checks,
  repository: "tweaks-forever",
});

test("the detail line names the repository, worktree, branch, pull request and changed files", () => {
  expect(
    sessionDetail(session, {
      prs: [pull({ passed: 1, failed: 1, running: 0 })],
      changes: 19,
      repository: "tweaks-forever",
    }),
  ).toBe("tweaks-forever · ~/.worktrees/tweaks-quest-xp · cb/quest-xp-bar · #123 ✗ · 19 changed");
});

test("a branch without a pull request says so, and the default branch leaves it out", () => {
  expect(sessionDetail(session, { changes: 2, repository: "tweaks-forever" })).toContain(
    "cb/quest-xp-bar · no PR yet · 2 changed",
  );
  expect(
    sessionDetail(
      { ...session, branch: "main" },
      { prs: [pull({ passed: 1, failed: 0, running: 0 })], changes: 2, repository: "tweaks-forever" },
    ),
  ).toBe("tweaks-forever · ~/.worktrees/tweaks-quest-xp · main · 2 changed");
});

test.each([
  [{ passed: 1, failed: 1, running: 0 }, "✗"],
  [{ passed: 1, failed: 0, running: 1 }, "●"],
  [{ passed: 1, failed: 0, running: 0 }, "✓"],
] as const)("the pull request carries its stage mark", (checks, mark) => {
  expect(sessionDetail(session, { prs: [pull(checks)], repository: "tweaks-forever" })).toContain(`#123 ${mark}`);
});

test("a repository is named by its remote, falling back to the directory name", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-remote-name-"));
  try {
    const remote = join(root, "tweaks-forever");
    mkdirSync(join(remote, ".git"), { recursive: true });
    writeFileSync(
      join(remote, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:cjber/tweaks-forever.git\n',
    );
    expect(repositoryName(remote)).toBe("tweaks-forever");
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(repositoryName(plain)).toBe("plain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
