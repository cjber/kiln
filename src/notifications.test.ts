import { expect, test } from "bun:test";

import { turnNotifications } from "./notifications";
import type { Activity, Session } from "./sessions";

function session(activity: Activity | undefined, overrides: Partial<Session> = {}): Session {
  return {
    pid: 123,
    agent: "claude",
    cwd: "/project",
    startedAt: 1,
    place: { kind: "kiln", name: "claude-project" },
    activity,
    ...overrides,
  };
}

test("notifies once per observed turn, only after idle", () => {
  const sent: Session[] = [];
  const update = turnNotifications((session) => sent.push(session));
  for (const activity of ["idle", "working", "working", "waiting", undefined] as const)
    update([session(activity)], true);
  expect(sent).toHaveLength(0);
  update([session("idle")], true);
  update([session("idle")], true);
  expect(sent).toHaveLength(1);
  update([session("working")], true);
  update([session("idle")], true);
  expect(sent).toHaveLength(2);
});

test("disappearance and PID reuse do not complete an old turn", () => {
  const sent: Session[] = [];
  const update = turnNotifications((session) => sent.push(session));
  update([session("working")], true);
  update([], true);
  update([session("idle")], true);
  update([session("working")], true);
  update([session("idle", { startedAt: 2 })], true);
  expect(sent).toHaveLength(0);
});

test("disabled notifications discard pending turns", () => {
  const sent: Session[] = [];
  const update = turnNotifications((session) => sent.push(session));
  update([session("working")], true);
  update([session("working")], false);
  update([session("idle")], true);
  update([session("working")], true);
  update([session("idle")], false);
  update([session("idle")], true);
  expect(sent).toHaveLength(0);
});

test("background threads retain identity across directory changes and cloud tasks are excluded", () => {
  const sent: Session[] = [];
  const update = turnNotifications((session) => sent.push(session));
  const background: Partial<Session> = {
    pid: undefined,
    agent: "codex",
    place: { kind: "background", id: "thread-1", attach: [] },
  };
  const cloud: Partial<Session> = { pid: undefined, place: { kind: "cloud", id: "task-1", title: "Task" } };
  update([session("working", background), session("working", cloud)], true);
  update([session("idle", { ...background, cwd: "/other" }), session("idle", cloud)], true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.cwd).toBe("/other");
});

test("a background turn completes after attaching to a terminal with the same provider ID", () => {
  const sent: Session[] = [];
  const update = turnNotifications((session) => sent.push(session));
  update(
    [
      session("working", {
        agent: "codex",
        pid: undefined,
        id: "thread-1",
        place: { kind: "background", id: "thread-1", attach: [] },
      }),
    ],
    true,
  );
  update([session("idle", { agent: "codex", id: "thread-1", startedAt: 2 })], true);
  expect(sent).toHaveLength(1);
});
