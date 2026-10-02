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
  place: { kind: "acp", id: "parent" },
};
const child: Session = {
  pid: 2,
  parentSessionPid: 1,
  agent: "claude",
  title: "Review retry",
  cwd: "/a/other",
  startedAt: 2,
  place: { kind: "acp", id: "child" },
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
    place: { kind: "acp", id: "child" },
  };
  expect(sessionRows([nested, root], "project", "", new Set()).filter((row) => row.kind === "session")).toHaveLength(1);
  expect(
    sessionRows([nested, root], "project", "", new Set(["pid:1"]))
      .filter((row) => row.kind === "session")
      .map((row) => row.depth),
  ).toEqual([0, 1]);
});

test("children expand or match with their parent", () => {
  const sessions = [child, parent];
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
