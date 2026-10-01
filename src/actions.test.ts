import { expect, test } from "bun:test";
import { sessionAction } from "./actions";
import type { Session } from "./sessions";

test("only kiln-owned ACP sessions can be closed", () => {
  const session: Session = {
    agent: "codex",
    id: "owned",
    cwd: "/repo",
    startedAt: 1,
    place: { kind: "acp", id: "owned" },
  };
  expect(sessionAction(session)).toEqual({ verb: "close" });
  expect(sessionAction({ ...session, place: { kind: "cloud", id: "task", title: "task" } })).toHaveProperty("reason");
});
