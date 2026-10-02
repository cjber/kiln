import { expect, spyOn, test } from "bun:test";
import { closeSession, openSession, sessionAction } from "./launcher";
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

test("each terminal-less place has its own close rule", () => {
  const session: Session = { agent: "claude", cwd: "/repo", startedAt: 1, place: { kind: "job", id: "1", attach: [] } };
  expect(sessionAction(session)).toHaveProperty("reason");
  expect(
    sessionAction({ ...session, place: { kind: "job", id: "1", attach: [], stop: ["claude", "stop", "1"] } }),
  ).toEqual({
    verb: "delete",
  });
  expect(sessionAction({ ...session, lifecycle: "completed" })).toEqual({ verb: "delete" });
  expect(sessionAction({ ...session, agent: "codex", place: { kind: "thread", id: "1", attach: [] } })).toEqual({
    verb: "archive",
  });
  expect(sessionAction({ ...session, place: { kind: "saved", id: "1", attach: [] } })).toEqual({ verb: "close" });
});

test("opening reports what the view should do without touching the terminal", async () => {
  const session: Session = { agent: "pi", id: "a", cwd: "/repo", startedAt: 1, place: { kind: "acp", id: "a" } };
  expect(await openSession(session)).toEqual({ kind: "conversation", id: "a" });
  expect(await openSession({ ...session, agent: "claude" })).toHaveProperty("kind", "notice");
  expect(await openSession({ ...session, place: { kind: "kiln", name: "claude-1" } })).toEqual({
    kind: "attach",
    name: "claude-1",
  });
  expect(await openSession({ ...session, place: { kind: "elsewhere", source: "tmux main" } })).toEqual({
    kind: "notice",
    text: "Open this session in its terminal · tmux main",
  });
  expect(await openSession({ ...session, agent: "claude", place: { kind: "cloud", id: "x", title: "task" } })).toEqual({
    kind: "notice",
    text: "this Claude cloud session has no verified link",
  });
});

test("deleting a finished job runs claude rm and reports its refusal", async () => {
  const job: Session = {
    agent: "claude",
    cwd: "/repo",
    startedAt: 1,
    lifecycle: "completed",
    place: { kind: "job", id: "82f7d7c3", attach: [] },
  };
  const commands: string[][] = [];
  let code = 0;
  const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
    commands.push(command);
    return {
      stdout: new Response("").body,
      stderr: new Response(code ? "worktree has unpushed commits\nmore detail" : "").body,
      exited: Promise.resolve(code),
    };
  }) as unknown as typeof Bun.spawn);
  try {
    expect(await closeSession(job)).toBe(true);
    expect(commands).toEqual([["claude", "rm", "82f7d7c3"]]);
    commands.length = 0;
    const live: Session = {
      ...job,
      lifecycle: undefined,
      place: { kind: "job", id: "82f7d7c3", attach: [], stop: ["claude", "stop", "82f7d7c3"] },
    };
    expect(await closeSession(live)).toBe(true);
    expect(commands).toEqual([
      ["claude", "stop", "82f7d7c3"],
      ["claude", "rm", "82f7d7c3"],
    ]);
    code = 1;
    expect(await closeSession(job)).toBe("could not delete claude: worktree has unpushed commits");
  } finally {
    spawn.mockRestore();
  }
});
