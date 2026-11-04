import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSelection, selectionAt, sessionRows } from "./session-list";
import { type Session, sessionIdentity } from "./sessions";

const parent: Session = {
  pid: 1,
  agent: "codex",
  title: "Fix retry",
  cwd: "/z/atlas",
  startedAt: 1,
  lastActiveAt: 20,
  place: { kind: "kiln", name: "parent" },
};
const child: Session = {
  pid: 2,
  parentSessionPid: 1,
  agent: "claude",
  title: "Review retry",
  cwd: "/a/other",
  startedAt: 2,
  place: { kind: "kiln", name: "child" },
};
const entries = (rows: ReturnType<typeof sessionRows>) =>
  rows.flatMap((row) => (row.kind === "session" ? [row.session.pid] : []));

test("daemon children nest by provider thread identity without process ancestry", () => {
  const root: Session = { ...parent, id: "root" };
  const nested: Session = {
    ...parent,
    pid: undefined,
    id: "child",
    parentSessionId: "root",
    place: { kind: "kiln", name: "child" },
  };
  expect(sessionRows([nested, root], "project", "", new Set()).filter((row) => row.kind === "session")).toHaveLength(1);
  expect(
    sessionRows([nested, root], "project", "", new Set([sessionIdentity(root)]))
      .filter((row) => row.kind === "session")
      .map((row) => row.depth),
  ).toEqual([0, 1]);
});

test("children expand or match with their parent", () => {
  const sessions = [child, parent];
  const collapsed = sessionRows(sessions, "project", "", new Set());
  expect(entries(collapsed)).toEqual([1]);
  expect(collapsed.find((row) => row.kind === "session")).toMatchObject({ children: 1, depth: 0 });
  expect(entries(sessionRows(sessions, "project", "", new Set([sessionIdentity(parent)])))).toEqual([1, 2]);
  expect(entries(sessionRows(sessions, "project", "Review", new Set()))).toEqual([1, 2]);
});

test("directory groups sort by name and retain latest updates inside each group", () => {
  const recent: Session = { ...parent, pid: 4, lastActiveAt: 30 };
  const blog: Session = { ...parent, pid: 5, cwd: "/a/blog", lastActiveAt: 100 };
  const rows = sessionRows([blog, parent, recent], "project", "", new Set());
  expect(rows.filter((row) => row.kind === "header").map((row) => row.name)).toEqual(["atlas", "blog"]);
  expect(entries(rows)).toEqual([4, 1, 5]);
});

test("input requests remain visible and match their displayed status", () => {
  const orphan: Session = { ...child, pid: 3, parentSessionPid: undefined, activity: "waiting" };
  expect(entries(sessionRows([orphan], "project", "needs input", new Set()))).toEqual([3]);
  expect(entries(sessionRows([{ ...orphan, activity: "idle" }], "project", "", new Set()))).toEqual([3]);
});

test("the filter matches the status column's own words", () => {
  const waiting: Session = { ...parent, pid: 3, activity: "waiting" };
  expect(entries(sessionRows([parent, waiting], "age", "unknown", new Set()))).toEqual([1]);
  expect(entries(sessionRows([parent, waiting], "age", "needs input", new Set()))).toEqual([3]);
});

test("the cursor follows its session and rests in place when the session goes", () => {
  const other: Session = { ...parent, pid: 3 };
  const at = selectionAt([parent, other], 1);
  expect(resolveSelection([other, parent], at).index).toBe(0);
  expect(resolveSelection([parent], at).index).toBe(0);
  expect(resolveSelection([], at)).toEqual({ key: undefined, index: 0 });
});

test("project groups put a linked worktree under its repository", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-repo-"));
  const repo = join(root, "atlas");
  const worktree = join(root, "atlas-fix");
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { stdout: "ignore", stderr: "ignore" });
  try {
    git("init", "-q", repo);
    git("-C", repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
    git("-C", repo, "worktree", "add", "-q", worktree);
    const rows = sessionRows(
      [
        { ...parent, cwd: repo },
        { ...parent, pid: 3, cwd: join(worktree, "src") },
      ],
      "project",
      "",
      new Set(),
    );
    expect(rows.filter((row) => row.kind === "header")).toEqual([
      { kind: "header", key: `dir:${repo}`, name: "atlas", directory: repo },
    ]);
    expect(entries(rows)).toEqual([1, 3]);
    const separate = join(root, "work");
    git("init", "-q", separate, `--separate-git-dir=${join(root, "meta")}`);
    git("-C", separate, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
    git("-C", separate, "worktree", "add", "-q", join(root, "work-fix"));
    expect(
      sessionRows(
        [
          { ...parent, cwd: separate },
          { ...parent, pid: 3, cwd: join(root, "work-fix") },
        ],
        "project",
        "",
        new Set(),
      ).filter((row) => row.kind === "header"),
    ).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
