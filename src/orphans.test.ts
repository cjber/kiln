import { expect, test } from "bun:test";
import { orphanedChildren } from "./orphans";
import type { Session } from "./sessions";

const session = (overrides: Partial<Session>): Session => ({
  agent: "claude",
  id: "p1",
  pid: 10,
  cwd: "/repo",
  startedAt: 0,
  activity: "working",
  place: { kind: "kiln", name: "claude-p1" },
  ...overrides,
});

function observe(exited: number[]) {
  const closed: string[] = [];
  const reported: string[] = [];
  const check = orphanedChildren(
    (child) => closed.push(child.id ?? ""),
    (child, parent, grandparent) => reported.push(`${child.id}:${parent.id}->${grandparent.id}`),
    (pid) => !exited.includes(pid),
  );
  return { closed, reported, check };
}

const top = session({ id: "g1", pid: 9, place: { kind: "kiln", name: "claude-g1" } });
const parent = session({ parentSessionPid: 9 });
const idle = session({ id: "c1", pid: 11, activity: "idle", parentSessionPid: 10 });
const busy = session({ id: "c2", pid: 12, parentSessionPid: 10 });
const asking = session({ id: "c3", pid: 13, activity: "waiting", parentSessionPid: 10 });

test("a parent that exits closes its idle children and hands working ones to its own parent", () => {
  const exited: number[] = [];
  const { closed, reported, check } = observe(exited);
  check([top, parent, idle, busy, asking]);
  expect(closed).toEqual([]);
  exited.push(10);
  check([top, idle, busy, asking]);
  expect(closed).toEqual(["c1"]);
  expect(reported).toEqual(["c2:p1->g1", "c3:p1->g1"]);
  // Each orphan is acted on once.
  check([top, busy, asking]);
  expect(closed).toEqual(["c1"]);
  expect(reported).toHaveLength(2);
});

test("a top-level parent's working children are left alone", () => {
  const exited: number[] = [];
  const { closed, reported, check } = observe(exited);
  const root = session({});
  check([root, idle, busy]);
  exited.push(10);
  check([idle, busy]);
  expect(closed).toEqual(["c1"]);
  expect(reported).toEqual([]);
});

test("a parent missing from one listing while its process runs is not taken as exited", () => {
  const exited: number[] = [];
  const { closed, reported, check } = observe(exited);
  check([top, parent, idle, busy]);
  check([top, idle, busy]);
  expect(closed).toEqual([]);
  expect(reported).toEqual([]);
  // It is still watched, so its later exit is seen.
  exited.push(10);
  check([top, idle, busy]);
  expect(closed).toEqual(["c1"]);
});
