import { expect, test } from "bun:test";
import { nativeNotifications } from "./notifications";
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

function observe() {
  const sent: string[] = [];
  const reported: string[] = [];
  const check = nativeNotifications(
    (row) => sent.push(`${row.id}:${row.activity}`),
    (child, parent) => reported.push(`${child.id}->${parent.id}:${child.activity}`),
  );
  return { sent, reported, check };
}

test("a child's turn end goes to its parent, never to the desktop", () => {
  const { sent, reported, check } = observe();
  const parent = session({});
  const child = session({ id: "c1", pid: 11, parentSessionPid: 10, place: { kind: "kiln", name: "claude-c1" } });
  check([parent, child], true);
  check([parent, { ...child, activity: "idle" }], true);
  check([parent, { ...child, activity: "waiting" }], true);
  expect(sent).toEqual([]);
  expect(reported).toEqual(["c1->p1:idle"]);
  check(
    [
      { ...parent, activity: "waiting" },
      { ...child, activity: "working" },
    ],
    true,
  );
  check(
    [
      { ...parent, activity: "waiting" },
      { ...child, activity: "waiting" },
    ],
    false,
  );
  expect(sent).toEqual(["p1:waiting"]);
  // Reports to the parent do not depend on the desktop's notification setting.
  expect(reported).toEqual(["c1->p1:idle", "c1->p1:waiting"]);
});

test("a turn that ends into background work notifies once, and the work finishing does not notify again", () => {
  const { sent, check } = observe();
  check([session({})], true);
  check([session({ turnEnded: true })], true);
  check([session({ activity: "idle" })], true);
  expect(sent).toEqual(["p1:working"]);
  // A first sight or an unknown status reports nothing.
  check([session({ activity: undefined })], true);
  check([session({ activity: "idle" })], true);
  expect(sent).toEqual(["p1:working"]);
});
