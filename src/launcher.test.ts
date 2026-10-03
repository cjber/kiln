import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { closeSession, openSession, sessionAction } from "./launcher";
import type { Session } from "./sessions";
import { defaults } from "./settings";

test("only kiln-owned sessions can be closed", () => {
  const session: Session = {
    agent: "codex",
    id: "owned",
    cwd: "/repo",
    startedAt: 1,
    place: { kind: "kiln", name: "owned" },
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
});

test("opening reports what the view should do without touching the terminal", async () => {
  const session: Session = { agent: "pi", cwd: "/repo", startedAt: 1, place: { kind: "kiln", name: "pi-1" } };
  expect(await openSession(session, defaults)).toEqual({ kind: "attach", name: "pi-1" });
  expect(await openSession({ ...session, place: { kind: "elsewhere", source: "tmux main" } }, defaults)).toEqual({
    kind: "notice",
    text: "Open this session in its terminal · tmux main",
  });
  expect(
    await openSession({ ...session, agent: "claude", place: { kind: "cloud", id: "x", title: "task" } }, defaults),
  ).toEqual({
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

test("a session a restart stopped resumes its conversation, and x only forgets the row", async () => {
  const stopped: Session = {
    agent: "codex",
    id: "0199c5a1-7a0e-7c11-9d3f-2f6d1c0e8a11",
    cwd: tmpdir(),
    startedAt: 1,
    lifecycle: "stopped",
    place: { kind: "saved" },
  };
  expect(sessionAction(stopped)).toEqual({ verb: "forget" });
  const commands: string[][] = [];
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(((command: string[]) => {
    commands.push(command);
    return { exitCode: command.includes("has-session") ? 1 : 0 };
  }) as unknown as typeof Bun.spawnSync);
  const which = spyOn(Bun, "which").mockReturnValue("/usr/bin/codex");
  try {
    const settings = {
      ...defaults,
      remoteControl: false,
      zoxide: false,
      agents: { ...defaults.agents, codex: ["codex", "--search"] },
    };
    const outcome = await openSession(stopped, settings);
    expect(outcome.kind).toBe("attach");
    expect(commands.find((command) => command.includes("new-session"))?.slice(-4)).toEqual([
      "codex",
      "resume",
      "0199c5a1-7a0e-7c11-9d3f-2f6d1c0e8a11",
      "--search",
    ]);
    expect(await openSession({ ...stopped, agent: "claude" }, settings)).toMatchObject({ kind: "attach" });
    expect(commands.findLast((command) => command.includes("new-session"))?.slice(-3)).toEqual([
      "claude",
      "--resume",
      "0199c5a1-7a0e-7c11-9d3f-2f6d1c0e8a11",
    ]);
  } finally {
    spawn.mockRestore();
    which.mockRestore();
  }
});
