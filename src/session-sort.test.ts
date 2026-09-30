import { expect, test } from "bun:test";
import { sortSessions } from "./session-sort";
import type { Session } from "./sessions";
import { defaults, parseSettings } from "./settings";

const rows: [Session, Session, Session] = [
  { pid: 1, agent: "pi", cwd: "/a/zebra", startedAt: 10, lastActiveAt: 20, place: { kind: "kiln", name: "a" } },
  { pid: 2, agent: "claude", cwd: "/z/atlas", startedAt: 20, lastActiveAt: 30, place: { kind: "elsewhere" } },
  { pid: 3, agent: "codex", cwd: "/m/middle", startedAt: 30, place: { kind: "elsewhere" } },
];

test("all sort modes distinguish activity, age, harness, full directory and project basename", () => {
  const ids = (order: Parameters<typeof sortSessions>[1]) => sortSessions(rows, order).map((row) => row.pid);
  expect(ids("last_active")).toEqual([2, 1, 3]);
  expect(ids("age")).toEqual([1, 2, 3]);
  expect(ids("harness")).toEqual([2, 3, 1]);
  expect(ids("directory")).toEqual([1, 3, 2]);
  expect(ids("project")).toEqual([2, 3, 1]);
  expect(rows.map((row) => row.pid)).toEqual([1, 2, 3]);
  const child: Session = { ...rows[2], pid: 4, parentSessionPid: 1, lastActiveAt: 100 };
  expect(sortSessions([...rows, child], "last_active").map((row) => row.pid)).toEqual([2, 1, 4, 3]);
});

test("list order defaults to last activity and rejects unknown settings", () => {
  expect(defaults.sort).toBe("last_active");
  expect(parseSettings('sort = "project"').sort).toBe("project");
  expect(() => parseSettings('sort = "recent"')).toThrow("sort must be one of");
  expect(() => parseSettings("sort = false")).toThrow("sort must be one of");
});
