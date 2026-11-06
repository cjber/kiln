import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequest } from "./dashboard";
import { type DetailOptions, sessionDetail } from "./session-detail";
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
const pull = (checks: PullRequest["checks"], number = 123): PullRequest => ({
  number,
  url: "https://github.com/cjber/tweaks-forever/pull/123",
  state: "OPEN",
  draft: false,
  additions: 1,
  deletions: 1,
  queued: false,
  checks,
  repository: "tweaks-forever",
});

const detail = (value: Session, options?: DetailOptions) =>
  sessionDetail(value, options)
    .map((part) => part.text)
    .join(" · ");

test("the detail line names the repository, worktree, branch, every pull request newest first and changed files", () => {
  expect(
    detail(session, {
      prs: [pull({ passed: 1, failed: 1, running: 0 }), pull({ passed: 1, failed: 0, running: 0 }, 130)],
      changes: 19,
      repository: "tweaks-forever",
    }),
  ).toBe("tweaks-forever · ~/.worktrees/tweaks-quest-xp · cb/quest-xp-bar · #130 ● · #123 ● · 19 changed");
});

test("a branch without a pull request says so, and the default branch leaves it out", () => {
  expect(detail(session, { changes: 2, repository: "tweaks-forever" })).toContain(
    "cb/quest-xp-bar · no PR yet · 2 changed",
  );
  expect(
    detail(
      { ...session, branch: "main" },
      { prs: [pull({ passed: 1, failed: 0, running: 0 })], changes: 2, repository: "tweaks-forever" },
    ),
  ).toBe("tweaks-forever · ~/.worktrees/tweaks-quest-xp · main · 2 changed");
});

test.each([
  [{ passed: 1, failed: 1, running: 0 }, "failing"],
  [{ passed: 1, failed: 0, running: 1 }, "checks"],
  [{ passed: 1, failed: 0, running: 0 }, "green"],
] as const)("each pull request carries its stage for its dot", (checks, stage) => {
  expect(sessionDetail(session, { prs: [pull(checks)], repository: "tweaks-forever" })).toContainEqual({
    text: "#123 ●",
    stage,
  });
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
