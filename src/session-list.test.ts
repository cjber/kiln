import { expect, test } from "bun:test";
import { sessionRows } from "./session-list";
import type { Session } from "./sessions";

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
  place: { kind: "elsewhere" },
};
const entries = (rows: ReturnType<typeof sessionRows>) =>
  rows.flatMap((row) => (row.kind === "session" ? [row.session.pid] : []));

test("unopenable roots are hidden and children expand or match with their parent", () => {
  const orphan: Session = { ...child, pid: 3, parentSessionPid: undefined };
  const sessions = [child, orphan, parent];
  const collapsed = sessionRows(sessions, "project", "", new Set());
  expect(entries(collapsed)).toEqual([1]);
  expect(collapsed.find((row) => row.kind === "session")).toMatchObject({ children: 1, depth: 0 });
  expect(entries(sessionRows(sessions, "project", "", new Set(["pid:1"])))).toEqual([1, 2]);
  expect(entries(sessionRows(sessions, "project", "Review", new Set()))).toEqual([1, 2]);
});

test("directory groups sort by name and retain latest updates inside each group", () => {
  const recent: Session = { ...parent, pid: 4, lastActiveAt: 30 };
  const blog: Session = { ...parent, pid: 5, cwd: "/a/blog", lastActiveAt: 100 };
  const rows = sessionRows([blog, parent, recent], "project", "", new Set());
  expect(rows.filter((row) => row.kind === "header").map((row) => row.name)).toEqual(["atlas", "blog"]);
  expect(entries(rows)).toEqual([4, 1, 5]);
});
