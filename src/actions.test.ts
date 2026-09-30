import { expect, test } from "bun:test";
import { sessionAction } from "./actions";
import type { Agent, Place, Session } from "./sessions";

const session = (agent: Agent, place: Place, pid?: number): Session => ({
  agent,
  place,
  pid,
  cwd: "/repo",
  startedAt: 1,
});

test("x archives Codex daemon threads and closes Claude background jobs", () => {
  expect(sessionAction(session("codex", { kind: "background", id: "thread", attach: [] }))).toEqual({
    verb: "archive",
  });
  expect(
    sessionAction(session("claude", { kind: "background", id: "job", attach: [], stop: ["claude", "stop", "job"] })),
  ).toEqual({ verb: "close" });
});

test("all agents can close terminals or processes they own", () => {
  for (const agent of ["claude", "codex", "pi"] as const) {
    expect(sessionAction(session(agent, { kind: "kiln", name: "pane" }))).toEqual({ verb: "close" });
    expect(sessionAction(session(agent, { kind: "kitty", socket: "@kitty", windowId: 1 }, 123))).toEqual({
      verb: "close",
    });
    expect(sessionAction(session(agent, { kind: "elsewhere" }, 123))).toEqual({ verb: "close" });
  }
});

test("unsupported actions explain why before confirmation", () => {
  expect(sessionAction(session("codex", { kind: "cloud", id: "task", title: "task" }))).toEqual({
    reason: "cloud tasks are read-only and cannot be closed here",
  });
  expect(sessionAction(session("pi", { kind: "background", id: "job", attach: [] }))).toHaveProperty("reason");
  expect(sessionAction(session("claude", { kind: "elsewhere" }))).toHaveProperty("reason");
});
