import { describe, expect, test } from "bun:test";
import { sessionAction } from "./launcher";
import {
  deduplicateSessions,
  finishedClaudeJobs,
  isInteractiveCodex,
  resumedCodexThread,
  sessionLocation,
  withCodexThreads,
} from "./native-sessions";
import type { Place, Session } from "./sessions";

describe("isInteractiveCodex", () => {
  test("keeps a plain session, a resume, and flags that merely contain a subcommand name", () => {
    expect(isInteractiveCodex(["codex"])).toBe(true);
    expect(isInteractiveCodex(["codex", "resume", "0199c-abc"])).toBe(true);
    expect(isInteractiveCodex(["codex", "--search", "--dangerously-bypass-approvals-and-sandbox"])).toBe(true);
  });

  test("keeps a session whose opening prompt starts with a subcommand's name", () => {
    expect(isInteractiveCodex(["codex", "review the retry change"])).toBe(true);
  });

  test("drops the non-session subcommands", () => {
    for (const command of [
      ["codex", "exec", "do a thing"],
      ["codex", "review"],
      ["codex", "agents"],
      ["codex", "app-server"],
      ["codex", "mcp", "list"],
    ]) {
      expect(isInteractiveCodex(command)).toBe(false);
    }
  });
});

describe("Codex thread matching", () => {
  const process = (pid: number, threadId?: string) => ({
    pid,
    threadId,
    agent: "codex" as const,
    cwd: "/repo",
    startedAt: pid,
  });
  const threads = [
    { id: "older", cwd: "/repo", createdAt: 1, activity: "idle" as const },
    { id: "newer", cwd: "/repo", createdAt: 2, activity: "working" as const },
  ];

  test("thread IDs win over process start order", () => {
    const result = withCodexThreads([process(1, "newer"), process(2, "older")], threads);
    expect(result.processes.map((item) => item.activity)).toEqual(["working", "idle"]);
    expect(result.headless).toEqual([]);
  });

  test("a matched daemon thread supplies its current directory instead of the terminal launch path", () => {
    const result = withCodexThreads(
      [process(1, "older")],
      [{ id: "older", cwd: "/new-worktree", createdAt: 1, activity: "idle" }],
    );
    expect(result.processes[0]?.cwd).toBe("/new-worktree");
    expect(result.headless).toEqual([]);
  });

  test("a local thread absent from the daemon never borrows its status", () => {
    const result = withCodexThreads([process(1, "local")], threads);
    expect(result.processes[0]?.activity).toBeUndefined();
    expect(result.headless).toHaveLength(2);
  });

  test("unidentified terminals defer to attachable daemon tasks", () => {
    const result = withCodexThreads([process(1), process(2)], threads);
    expect(result.processes).toHaveLength(0);
    expect(result.headless.map((item) => item.place.kind)).toEqual(["thread", "thread"]);
  });

  test("unidentified terminals stay visible when daemon inventory is unavailable", () => {
    expect(withCodexThreads([process(1)], []).processes).toHaveLength(1);
  });

  test("unidentified clients do not steal a remaining daemon task", () => {
    const result = withCodexThreads([process(1), process(2, "older")], threads);
    expect(result.processes.map((item) => item.activity)).toEqual(["idle"]);
    expect(result.headless.map((item) => item.id)).toEqual(["newer"]);
  });

  test("duplicate clients retain thread metadata until placement is resolved", () => {
    const result = withCodexThreads([process(1, "newer"), process(2, "newer"), process(3)], threads);
    expect(result.processes.map((item) => item.id)).toEqual(["newer", "newer"]);
    expect(result.processes.map((item) => item.activity)).toEqual(["working", "working"]);
    expect(result.headless.map((item) => item.id)).toEqual(["older"]);
  });

  test("two terminals cannot share a single daemon status", () => {
    const result = withCodexThreads([process(1), process(2)], threads.slice(0, 1));
    expect(result.processes).toHaveLength(0);
  });
});

describe("session placement", () => {
  const parentPlace: Place = { kind: "kiln", name: "parent" };
  const childPlace: Place = { kind: "kitty", socket: "@kitty", windowId: 7 };
  test("a piped child does not open its parent's terminal", () => {
    expect(sessionLocation([2, 3, 1, 4], new Map([[4, parentPlace]]), new Set([1, 2]))).toEqual({
      ancestorSessionPid: 1,
      place: undefined,
    });
  });
  test("a child with its own terminal stays openable", () => {
    expect(
      sessionLocation(
        [2, 3, 1, 4],
        new Map<number, Place>([
          [3, childPlace],
          [4, parentPlace],
        ]),
        new Set([1, 2]),
      ),
    ).toEqual({ ancestorSessionPid: 1, place: childPlace });
  });
  test("a shell between a top-level agent and its pane still resolves", () => {
    expect(sessionLocation([2, 3, 4], new Map([[4, parentPlace]]), new Set([2]))).toEqual({ place: parentPlace });
  });
});

test("resumed daemon terminals retain their explicit thread ID", () => {
  const id = "01a0f263-aa24-75d3-ae9a-4d2440758175";
  expect(resumedCodexThread(["codex", "resume", id, "--remote", "unix://"])).toBe(id);
  expect(resumedCodexThread(["codex", "--config", "resume", id])).toBeUndefined();
  expect(resumedCodexThread(["codex", "resume", "--last"])).toBeUndefined();
  expect(resumedCodexThread(["codex", "--config", "prompt=resume", id])).toBeUndefined();
});

test("duplicate clients keep an openable terminal regardless of process order", () => {
  const outside: Session = {
    id: "task",
    pid: 1,
    agent: "codex",
    cwd: "/repo",
    startedAt: 1,
    place: { kind: "elsewhere" },
  };
  const inside: Session = { ...outside, pid: 2, place: { kind: "kiln", name: "task" } };
  expect(deduplicateSessions([outside, inside])).toEqual([inside]);
  expect(deduplicateSessions([inside, outside])).toEqual([inside]);
});

describe("finished Claude jobs", () => {
  const job = { kind: "background", id: "82f7d7c3", sessionId: "provider-id", name: "Finished", cwd: "/repo" };

  test("lists completed and stopped jobs without a process or an activity", () => {
    const [done, stopped] = finishedClaudeJobs([
      { ...job, state: "done", startedAt: 5 },
      { ...job, id: "0b276145", state: "stopped" },
    ]);
    expect(done).toMatchObject({
      agent: "claude",
      id: "provider-id",
      title: "Finished",
      startedAt: 5,
      lifecycle: "completed",
      place: { kind: "job", id: "82f7d7c3", attach: ["claude", "attach", "82f7d7c3"] },
    });
    expect(done?.activity).toBeUndefined();
    expect(done?.pid).toBeUndefined();
    expect(stopped?.lifecycle).toBe("stopped");
    expect(sessionAction(done as Session)).toEqual({ verb: "delete" });
  });

  test("ignores running jobs, unknown states and ids that are not job ids", () => {
    expect(
      finishedClaudeJobs([
        { ...job, state: "done", pid: 4 },
        { ...job, state: "running" },
        { ...job, state: "archived" },
        { ...job, state: "done", kind: "interactive" },
        { ...job, state: "done", id: "../escape" },
        { ...job, state: "done", cwd: "relative" },
      ]),
    ).toEqual([]);
  });
});
