import { describe, expect, test } from "bun:test";

import {
  isInteractiveCodex,
  isInteractivePi,
  nestSessions,
  type Place,
  resumedCodexThread,
  type Session,
  sessionLocation,
  withCodexThreads,
} from "./sessions";

describe("isInteractiveCodex", () => {
  test("keeps a plain session, a resume, and flags that merely contain a subcommand name", () => {
    expect(isInteractiveCodex("codex")).toBe(true);
    expect(isInteractiveCodex("codex resume 0199c-abc")).toBe(true);
    expect(isInteractiveCodex("codex --search --dangerously-bypass-approvals-and-sandbox")).toBe(true);
  });

  test("drops the non-session subcommands", () => {
    for (const command of [
      "codex exec 'do a thing'",
      "codex review",
      "codex agents",
      "codex app-server",
      "codex mcp list",
    ]) {
      expect(isInteractiveCodex(command)).toBe(false);
    }
  });
});

describe("isInteractivePi", () => {
  test("keeps a plain session and one started with a message", () => {
    expect(isInteractivePi("pi")).toBe(true);
    expect(isInteractivePi("pi --continue")).toBe(true);
    expect(isInteractivePi("pi fix the flaky test")).toBe(true);
  });

  test("drops print mode, rpc mode and the management subcommands", () => {
    for (const command of ["pi -p 'summarise'", "pi --mode rpc", "pi install npm:foo", "pi update", "pi auth status"]) {
      expect(isInteractivePi(command)).toBe(false);
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

  test("ambiguous terminals remain unknown while daemon threads stay attachable", () => {
    const result = withCodexThreads([process(1), process(2)], threads);
    expect(result.processes.map((item) => item.activity)).toEqual([undefined, undefined]);
    expect(result.headless.map((item) => item.place.kind)).toEqual(["background", "background"]);
  });

  test("one terminal with multiple threads remains unknown", () => {
    expect(withCodexThreads([process(1)], threads).processes[0]?.activity).toBeUndefined();
  });

  test("known IDs are removed before matching an unambiguous remaining terminal", () => {
    const result = withCodexThreads([process(1), process(2, "older")], threads);
    expect(result.processes.map((item) => item.activity)).toEqual(["working", "idle"]);
    expect(result.headless).toEqual([]);
  });

  test("two terminals cannot share a single daemon status", () => {
    const result = withCodexThreads([process(1), process(2)], threads.slice(0, 1));
    expect(result.processes.map((item) => item.activity)).toEqual([undefined, undefined]);
  });
});

describe("nested sessions", () => {
  const parent: Session = { pid: 1, agent: "codex", cwd: "/z", startedAt: 1, place: { kind: "kiln", name: "parent" } };
  const child: Session = {
    pid: 2,
    parentSessionPid: 1,
    agent: "claude",
    cwd: "/a",
    startedAt: 2,
    place: { kind: "elsewhere" },
  };
  const other: Session = { pid: 3, agent: "pi", cwd: "/b", startedAt: 3, place: { kind: "elsewhere" } };
  test("a child sorts beneath its parent even when its directory sorts first", () => {
    expect(nestSessions([child, other, parent])).toEqual([other, parent, child]);
  });
  test("a child stays visible when its parent is absent", () => {
    expect(nestSessions([child, other])).toEqual([child, other]);
  });
});

describe("session placement", () => {
  const parentPlace: { place: Place } = {
    place: { kind: "kiln" as const, name: "parent" },
  };
  const childPlace: { place: Place } = {
    place: { kind: "kitty" as const, socket: "@kitty", windowId: 7 },
  };
  test("a piped child neither opens its parent's terminal nor borrows pane activity", () => {
    expect(sessionLocation([2, 3, 1, 4], new Map([[4, parentPlace]]), new Set([1, 2]))).toEqual({
      ancestorSessionPid: 1,
      found: undefined,
    });
  });
  test("a child with its own terminal stays openable", () => {
    expect(
      sessionLocation(
        [2, 3, 1, 4],
        new Map([
          [3, childPlace],
          [4, parentPlace],
        ]),
        new Set([1, 2]),
      ),
    ).toEqual({ ancestorSessionPid: 1, found: childPlace });
  });
  test("a shell between a top-level agent and its pane still resolves", () => {
    expect(sessionLocation([2, 3, 4], new Map([[4, parentPlace]]), new Set([2]))).toEqual({ found: parentPlace });
  });
});

test("resumed daemon terminals retain their explicit thread ID", () => {
  const id = "01a0f263-aa24-75d3-ae9a-4d2440758175";
  expect(resumedCodexThread(["codex", "resume", id, "--remote", "unix://"])).toBe(id);
  expect(resumedCodexThread(["codex", "--config", "resume", id])).toBeUndefined();
  expect(resumedCodexThread(["codex", "resume", "--last"])).toBeUndefined();
  expect(resumedCodexThread(["codex", "--config", "prompt=resume", id])).toBeUndefined();
});
