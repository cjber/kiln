import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { takeUnread } from "./mailbox";
import * as opencode from "./opencode";
import { recordSpawn } from "./saved-sessions";
import * as sessions from "./sessions";
import {
  exitHook,
  exitMessage,
  headlessCommand,
  interactiveClaudeCommand,
  reportSpawnExit,
  spawnOptions,
  spawnUsage,
} from "./spawn";
import { ended, exists, kill, respawn, start } from "./tmux";

// A private tmux server, so these tests never touch the real sessions.
Bun.env.KILN_TMUX_SERVER = `kiln-spawn-${process.pid}`;
const paneDir = mkdtempSync(join(tmpdir(), "kiln-spawn-pane-"));
afterAll(() => {
  Bun.spawnSync(["tmux", "-L", `kiln-spawn-${process.pid}`, "kill-server"], { stderr: "ignore" });
  rmSync(paneDir, { recursive: true, force: true });
});

test("spawn takes the agent, an optional directory and title, and the prompt after --", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-spawn-"));
  try {
    expect(
      spawnOptions(["opencode", "--dir", dir, "--title", "fix the tests", "--", "run the API tests", "and fix them"]),
    ).toEqual({
      agent: "opencode",
      dir,
      title: "fix the tests",
      model: undefined,
      prompt: "run the API tests and fix them",
    });
    expect(spawnOptions(["claude", "--", "--not-a-flag"], "/tmp")).toEqual({
      agent: "claude",
      dir: "/tmp",
      title: undefined,
      model: undefined,
      prompt: "--not-a-flag",
    });
    expect(spawnOptions(["claude", "--model", "claude-sonnet-5", "--", "work"], dir).model).toBe("claude-sonnet-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn defaults to the current directory and rejects a missing prompt or agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-spawn-"));
  try {
    expect(spawnOptions(["pi", "--", "check the build"], dir)).toEqual({
      agent: "pi",
      dir: resolve(dir),
      title: undefined,
      model: undefined,
      prompt: "check the build",
    });
    for (const args of [[], ["unknown", "--", "hi"], ["opencode"]])
      expect(() => spawnOptions(args, dir)).toThrow(spawnUsage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headless commands keep the id kiln chose for the child", () => {
  expect(headlessCommand(["opencode"], "opencode", "ses_x", "do the work", "task")).toEqual([
    "opencode",
    "run",
    "--session",
    "ses_x",
    "--title",
    "task",
    "do the work",
  ]);
  expect(headlessCommand(["claude"], "claude", "session-id", "do the work")).toEqual([
    "env",
    "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0",
    "claude",
    "-p",
    "--session-id",
    "session-id",
    "do the work",
  ]);
  expect(headlessCommand(["claude"], "claude", "session-id", "do the work", "sweep oss")).toEqual([
    "env",
    "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0",
    "claude",
    "-p",
    "--session-id",
    "session-id",
    "--name",
    "sweep oss",
    "do the work",
  ]);
});

test("a chosen model is passed to every provider's headless command", () => {
  expect(headlessCommand(["claude"], "claude", "id", "work", undefined, "sonnet")).toEqual([
    "env",
    "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0",
    "claude",
    "-p",
    "--session-id",
    "id",
    "--model",
    "sonnet",
    "work",
  ]);
  expect(headlessCommand(["codex"], "codex", "", "work", undefined, "gpt-5")).toEqual([
    "codex",
    "exec",
    "--model",
    "gpt-5",
    "work",
  ]);
  expect(headlessCommand(["opencode"], "opencode", "ses_1", "work", "task", "provider/model")).toEqual([
    "opencode",
    "run",
    "--session",
    "ses_1",
    "--title",
    "task",
    "--model",
    "provider/model",
    "work",
  ]);
  expect(headlessCommand(["pi"], "pi", "id", "work", undefined, "model")).toEqual([
    "pi",
    "-p",
    "--session-id",
    "id",
    "--model",
    "model",
    "-e",
    expect.any(String),
    "work",
  ]);
});

test("an exit hook quotes its command for tmux and a report names the reason", () => {
  expect(exitHook(["/home/me/bin/kiln", "msg", "exit", "claude-1", "claude:child", "claude:parent"])).toBe(
    'run-shell -b "/home/me/bin/kiln msg exit claude-1 claude:child claude:parent"',
  );
  // A path with spaces stays one word inside the hook's shell command.
  expect(exitHook(["/home/me/kiln bin/kiln", "msg", "exit", "claude-1"])).toBe(
    "run-shell -b \"'/home/me/kiln bin/kiln' msg exit claude-1\"",
  );
  expect(exitMessage("claude:child", "limit child", 1, "You've hit your limit")).toBe(
    'Child claude:child exited with status 1 while working on "limit child".\n\nLast output:\n\nYou\'ve hit your limit',
  );
  expect(exitMessage("claude:child", undefined, 0, undefined)).toBe("Child claude:child finished.");
  expect(exitMessage("claude:child", undefined, undefined, "  ")).toBe("Child claude:child ended.");
});

test("a spawned pane's exit hook runs, and its kept pane reports the status and output", async () => {
  const marker = join(paneDir, "hook-ran");
  expect(
    start(
      "limit-child",
      paneDir,
      ["sh", "-c", "echo you hit the limit; exit 3"],
      "limit child",
      false,
      exitHook(["/usr/bin/touch", marker]),
    ),
  ).toBe(true);
  for (let waited = 0; !existsSync(marker) && waited < 2_000; waited += 50) await Bun.sleep(50);
  expect(existsSync(marker)).toBe(true);
  expect(ended("limit-child")).toEqual({ status: 3, output: "you hit the limit" });
  expect(kill("limit-child")).toBe(true);
});

test("an exit before registration keeps the pane until the spawn is recorded", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "state");
  const name = "unregistered-child";
  try {
    expect(start(name, paneDir, ["sh", "-c", "echo stopped; exit 3"], "early", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    await reportSpawnExit(name, "", "");
    expect(ended(name)?.status).toBe(3);
    recordSpawn({ agent: "codex", id: "early", cwd: paneDir, startedAt: Date.now(), pane: name });
    await reportSpawnExit(name, "", "");
    expect(ended(name)).toBeUndefined();
  } finally {
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("a delayed exit report does not kill a live replacement pane", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "replacement-state");
  const name = "replacement-child";
  try {
    expect(start(name, paneDir, ["sh", "-c", "sleep 2"], "replacement", true)).toBe(true);
    recordSpawn({ agent: "codex", id: "replacement", cwd: paneDir, startedAt: Date.now(), pane: name });
    await reportSpawnExit(name, "", "");
    expect(ended(name)).toBeUndefined();
  } finally {
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("an offline child exit reaches its parent mailbox without a provider call", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "mailbox-state");
  const name = "mailbox-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    expect(start(name, paneDir, ["sh", "-c", "echo offline-limit; exit 7"], "offline", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    recordSpawn({
      agent: "codex",
      id: "offline-thread",
      cwd: paneDir,
      title: "offline",
      startedAt: Date.now(),
      pane: name,
    });
    await reportSpawnExit(name, "", "codex:parent");
    const messages = takeUnread("codex:parent");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("codex:offline-thread exited with status 7");
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("replacement during paused discovery prevents cleanup, reporting and archival", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "discovery-race-state");
  const name = "discovery-race-child";
  const server = `kiln-spawn-${process.pid}`;
  const channel = `exited-${crypto.randomUUID()}`;
  let release!: (rows: sessions.Session[]) => void;
  const barrier = new Promise<sessions.Session[]>((resolve) => {
    release = resolve;
  });
  const discovery = spyOn(sessions, "listSessions").mockImplementation(() => barrier);
  const archive = spyOn(opencode, "archiveOpencodeSession").mockResolvedValue(undefined);
  let reporting: Promise<void> | undefined;
  try {
    expect(
      start(
        name,
        paneDir,
        ["sh", "-c", "exit 7"],
        "old child",
        true,
        exitHook(["tmux", "-L", server, "wait-for", "-S", channel]),
      ),
    ).toBe(true);
    expect(await Bun.spawn(["tmux", "-L", server, "wait-for", channel]).exited).toBe(0);
    expect(ended(name)?.status).toBe(7);
    recordSpawn({ agent: "opencode", id: "ses_old", cwd: paneDir, startedAt: Date.now(), pane: name });
    reporting = reportSpawnExit(name, "", "codex:race-parent");
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(respawn(name, paneDir, ["cat"])).toBe(true);
    release([]);
    await reporting;
    expect(exists(name)).toBe(true);
    expect(ended(name)).toBeUndefined();
    expect(takeUnread("codex:race-parent")).toHaveLength(0);
    expect(archive).not.toHaveBeenCalled();
  } finally {
    release([]);
    await reporting;
    discovery.mockRestore();
    archive.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("a completed OpenCode exit reports and reaps locally without interrupting or archiving its conversation", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "completed-state");
  const name = "completed-child";
  const server = `kiln-spawn-${process.pid}`;
  const channel = `completed-${crypto.randomUUID()}`;
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  const archive = spyOn(opencode, "archiveOpencodeSession").mockResolvedValue(undefined);
  try {
    expect(
      start(
        name,
        paneDir,
        ["sh", "-c", "echo done; exit 0"],
        "completed",
        true,
        exitHook(["tmux", "-L", server, "wait-for", "-S", channel]),
      ),
    ).toBe(true);
    expect(await Bun.spawn(["tmux", "-L", server, "wait-for", channel]).exited).toBe(0);
    recordSpawn({ agent: "opencode", id: "ses_done", cwd: paneDir, startedAt: Date.now(), pane: name });
    await reportSpawnExit(name, "", "codex:completed-parent");
    expect(exists(name)).toBe(false);
    expect(takeUnread("codex:completed-parent")[0]?.body).toContain("opencode:ses_done finished");
    expect(archive).not.toHaveBeenCalled();
  } finally {
    discovery.mockRestore();
    archive.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("kiln's tmux server outlives its last session, so a start right after a reap cannot meet it shutting down", () => {
  const name = "server-keeper";
  try {
    expect(start(name, paneDir, ["sleep", "60"], "keeper")).toBe(true);
    const shown = Bun.spawnSync(["tmux", "-L", `kiln-spawn-${process.pid}`, "show-options", "-gv", "exit-empty"]);
    expect(shown.stdout.toString().trim()).toBe("off");
  } finally {
    kill(name);
  }
});

test("an interactive Claude child runs its full terminal UI with the chosen id, title and model", () => {
  expect(interactiveClaudeCommand(["mclaude", "--chrome"], "id", "-start the sweep", "sweep", "opus")).toEqual([
    "mclaude",
    "--chrome",
    "--session-id",
    "id",
    "--name",
    "sweep",
    "--model",
    "opus",
    "--",
    "-start the sweep",
  ]);
  const dir = mkdtempSync(join(tmpdir(), "kiln-spawn-"));
  expect(spawnOptions(["claude", "--interactive", "--dir", dir, "--", "work"]).interactive).toBe(true);
  expect(() => spawnOptions(["codex", "--interactive", "--dir", dir, "--", "work"])).toThrow("claude only");
});
