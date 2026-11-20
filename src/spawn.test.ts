import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as mailbox from "./mailbox";
import { outboxPath, peekUnread, takeUnread, writeOutbox } from "./mailbox";
import { findRecipient } from "./messages";
import * as opencode from "./opencode";
import { recordSpawn } from "./saved-sessions";
import * as sessions from "./sessions";
import {
  claudeGrants,
  exitHook,
  exitMessage,
  exitReporter,
  exitReportId,
  headlessCommand,
  interactiveClaudeCommand,
  reportSpawnExit,
  settleClaudeTrust,
  spawnAgent,
  spawnedCodexThread,
  spawnGrants,
  spawnOptions,
  spawnUsage,
  watchSpawnExit,
} from "./spawn";
import { ended, exists, kill, paneState, respawn, start } from "./tmux";
import { killServer } from "./tmux-server";

// A private tmux server, so these tests never touch the real sessions.
Bun.env.KILN_TMUX_SERVER = `kiln-spawn-${process.pid}`;
const paneDir = mkdtempSync(join(tmpdir(), "kiln-spawn-pane-"));
afterAll(() => {
  killServer(`kiln-spawn-${process.pid}`);
  rmSync(paneDir, { recursive: true, force: true });
});

/**
 * Wait for the `wait-for` channel a pane's exit hook signals, reading the pane meanwhile as a spawn's exit watcher does:
 * a tmux built with libutempter can lose the pane's SIGCHLD and run the hook only once a read sends it one (#230).
 */
async function hookSignalled(name: string, channel: string): Promise<number> {
  const waiting = Bun.spawn(["tmux", "-L", `kiln-spawn-${process.pid}`, "wait-for", channel]);
  let done = false;
  const exited = waiting.exited.finally(() => {
    done = true;
  });
  while (!done) {
    paneState(name);
    await Bun.sleep(20);
  }
  return exited;
}

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
    "--skip-git-repo-check",
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
  expect(headlessCommand(["muse"], "muse", "id", "work", undefined, "model")).toEqual([
    "muse",
    "exec",
    "--trust-workspace",
    "--session-id",
    "id",
    "--model",
    "model",
    "work",
  ]);
  // agy names its own conversation, so a print-mode run carries no id of kiln's.
  expect(headlessCommand(["agy"], "agy", "", "work", undefined, "m")).toEqual(["agy", "-p", "work", "--model", "m"]);
  // `exec` follows the muse word, not the whole configured command: options before it never start a session.
  expect(headlessCommand(["muse", "--provider", "echo"], "muse", "id", "work")).toEqual([
    "muse",
    "exec",
    "--trust-workspace",
    "--provider",
    "echo",
    "--session-id",
    "id",
    "work",
  ]);
});

test("a Codex child runs outside a git repository, and a Muse child loads its workspace's rules (#270, #271)", () => {
  // Codex takes the flag once and only after `exec`, so one the configured command passes moves there.
  expect(headlessCommand(["codex", "--skip-git-repo-check"], "codex", "", "go")).toEqual([
    "codex",
    "exec",
    "--skip-git-repo-check",
    "go",
  ]);
  // `--trust-workspace` is an option of `muse exec`, so it follows `exec` after any wrapper.
  expect(headlessCommand(["env", "A=1", "muse"], "muse", "id", "go")).toEqual([
    "env",
    "A=1",
    "muse",
    "exec",
    "--trust-workspace",
    "--session-id",
    "id",
    "go",
  ]);
});

for (const status of [1, 0]) {
  test(`a Codex spawn that exits with status ${status} before starting its thread fails with the reason, leaving nothing behind (#270)`, async () => {
    const saved = { state: Bun.env.XDG_STATE_HOME, config: Bun.env.XDG_CONFIG_HOME };
    const root = join(paneDir, `codex-refused-${status}`);
    const state = join(root, "state");
    mkdirSync(join(root, "config", "kiln"), { recursive: true });
    const codex = join(root, "codex.sh");
    writeFileSync(codex, `#!/bin/sh\necho 'Not inside a trusted directory.'\nexit ${status}\n`, { mode: 0o755 });
    writeFileSync(join(root, "config", "kiln", "config.toml"), `[agents]\ncodex = [${JSON.stringify(codex)}]\n`);
    Bun.env.XDG_STATE_HOME = state;
    Bun.env.XDG_CONFIG_HOME = join(root, "config");
    try {
      await expect(spawnAgent({ agent: "codex", dir: root, prompt: "go" }, "claude:parent")).rejects.toThrow(
        `Codex exited with status ${status} before it started:\nNot inside a trusted directory.`,
      );
      // No pane, outbox or exit report is left for a child that never ran.
      const listed = Bun.spawnSync([
        "tmux",
        "-L",
        `kiln-spawn-${process.pid}`,
        "list-sessions",
        "-F",
        "#{session_name}",
      ]);
      expect(
        listed.stdout
          .toString()
          .split("\n")
          .filter((session) => session.startsWith("codex-")),
      ).toEqual([]);
      const outboxes = join(outboxPath("none"), "..");
      expect(existsSync(outboxes) ? readdirSync(outboxes) : []).toEqual([]);
      expect(peekUnread("claude:parent")).toHaveLength(0);
    } finally {
      for (const [key, value] of [
        ["XDG_STATE_HOME", saved.state],
        ["XDG_CONFIG_HOME", saved.config],
      ] as const) {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      }
    }
  }, 40_000);
}

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
  // The read the watcher makes lets a tmux that lost the pane's SIGCHLD collect it and run the hook.
  for (let waited = 0; !existsSync(marker) && waited < 2_000; waited += 50) {
    paneState("limit-child");
    await Bun.sleep(50);
  }
  expect(existsSync(marker)).toBe(true);
  expect(ended("limit-child")).toEqual({ status: 3, output: "you hit the limit" });
  expect(kill("limit-child")).toBe(true);
});

test("an interactive Claude held at a startup dialog fails the spawn and closes its session", async () => {
  const name = "dialog-child";
  const argv = ["sh", "-c", "echo 'Allow external CLAUDE.md file imports?'; sleep 30"];
  expect(start(name, paneDir, argv, "dialog", false, "")).toBe(true);
  try {
    await expect(
      settleClaudeTrust(name, crypto.randomUUID(), { dir: paneDir }, argv, "dialog", "", 300),
    ).rejects.toThrow("Its screen showed:\nAllow external CLAUDE.md file imports?");
    expect(exists(name)).toBe(false);
  } finally {
    kill(name);
  }
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

test("a spawned child's exit is reported when tmux never runs its pane-died hook", async () => {
  // A tmux built with libutempter can lose a pane command's SIGCHLD, so its pane-died hook never fires (#230).
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "watched-state");
  const name = "watched-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    expect(start(name, paneDir, ["sh", "-c", "echo missed hook; exit 5"], "watched", true)).toBe(true);
    recordSpawn({
      agent: "codex",
      id: "watched-thread",
      cwd: paneDir,
      title: "watched",
      startedAt: Date.now(),
      pane: name,
    });
    await watchSpawnExit(name, "", "codex:parent", "", 20);
    const messages = takeUnread("codex:parent");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("codex:watched-thread exited with status 5");
    expect(ended(name)).toBeUndefined();
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("an exit watcher stops once its session is closed", async () => {
  const name = "watched-close";
  expect(start(name, paneDir, ["sleep", "60"], "watched close", true)).toBe(true);
  const watching = watchSpawnExit(name, "", "codex:close-parent", "", 20);
  await Bun.sleep(100);
  kill(name);
  // tmux 3.8 answers a read of a missing session with empty formats and status 0 (#235).
  expect(paneState("never-started")).toBe("gone");
  expect(await Promise.race([watching.then(() => "stopped"), Bun.sleep(2_000).then(() => "still watching")])).toBe(
    "stopped",
  );
});

test("an exit watcher leaves a respawned pane to whoever respawned it", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "watched-respawn-state");
  const name = "watched-respawn";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    expect(start(name, paneDir, ["sleep", "60"], "watched respawn", true)).toBe(true);
    recordSpawn({ agent: "codex", id: "watched-respawn", cwd: paneDir, startedAt: Date.now(), pane: name });
    const watching = watchSpawnExit(name, "", "codex:respawn-parent", "", 20);
    await Bun.sleep(100);
    expect(respawn(name, paneDir, ["sh", "-c", "exit 6"])).toBe(true);
    await watching;
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    expect(ended(name)?.status).toBe(6);
    expect(takeUnread("codex:respawn-parent")).toHaveLength(0);
  } finally {
    discovery.mockRestore();
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

test("every exit of a resumed child reaches the parent recorded for that run", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "resumed-state");
  const name = "resumed-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    // A resume reuses the conversation id, so each run is told apart by the start time its spawn recorded.
    const runs = [
      { startedAt: 1_000, parent: "codex:first-parent", status: 3 },
      { startedAt: 2_000, parent: "codex:first-parent", status: 4 },
      { startedAt: 3_000, parent: "codex:second-parent", status: 5 },
    ];
    for (const run of runs) {
      expect(start(name, paneDir, ["sh", "-c", `exit ${run.status}`], "resumed", true)).toBe(true);
      for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
      recordSpawn({ agent: "claude", id: "resumed-conversation", cwd: paneDir, startedAt: run.startedAt, pane: name });
      await reportSpawnExit(name, "", run.parent);
      expect(exists(name)).toBe(false);
    }
    expect(takeUnread("codex:first-parent").map((message) => message.body)).toEqual([
      "Child claude:resumed-conversation exited with status 3.",
      "Child claude:resumed-conversation exited with status 4.",
    ]);
    expect(takeUnread("codex:second-parent").map((message) => message.body)).toEqual([
      "Child claude:resumed-conversation exited with status 5.",
    ]);
    // The hook and the watcher reporting one run read the same record, so they share one message id.
    const record = { agent: "claude" as const, id: "resumed-conversation", startedAt: 3_000 };
    expect(exitReportId(record)).toBe(exitReportId({ ...record }));
    expect(exitReportId(record)).not.toBe(exitReportId({ ...record, startedAt: 2_000 }));
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("a stale run's delayed exit hook neither reaps a resumed run nor reports it to the stale parent", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "stale-hook-state");
  const name = "stale-hook-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    const record = { agent: "claude" as const, id: "stale-hook-conversation", cwd: paneDir, pane: name };
    // Run A exits and its watcher reports it, while A's pane-died hook is still delayed.
    expect(start(name, paneDir, ["sh", "-c", "exit 3"], "stale", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    recordSpawn({ ...record, parent: "codex:old-parent", startedAt: 1_000 });
    await reportSpawnExit(name, "", "codex:old-parent", "1000");
    expect(exists(name)).toBe(false);
    // Run B resumes the conversation under another parent, in a pane of the same name, and exits.
    recordSpawn({ ...record, parent: "codex:new-parent", startedAt: 2_000 });
    expect(start(name, paneDir, ["sh", "-c", "exit 4"], "stale", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    // A's delayed hook fires now, bound to run A.
    await reportSpawnExit(name, "", "codex:old-parent", "1000");
    expect(exists(name)).toBe(true);
    await reportSpawnExit(name, "", "codex:new-parent", "2000");
    expect(exists(name)).toBe(false);
    expect(takeUnread("codex:old-parent").map((message) => message.body)).toEqual([
      "Child claude:stale-hook-conversation exited with status 3.",
    ]);
    expect(takeUnread("codex:new-parent").map((message) => message.body)).toEqual([
      "Child claude:stale-hook-conversation exited with status 4.",
    ]);
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("a delayed exit hook without a run neither reaps a run-bound resumed run nor reports it", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "legacy-hook-state");
  const name = "legacy-hook-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    const record = { agent: "claude" as const, id: "legacy-hook-conversation", cwd: paneDir, pane: name };
    // Run A exits and its watcher reports it, while A's hook, which names no run, is still delayed.
    expect(start(name, paneDir, ["sh", "-c", "exit 3"], "legacy", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    recordSpawn({ ...record, parent: "codex:old-parent", startedAt: 1_000, runBound: true });
    await reportSpawnExit(name, "", "codex:old-parent", "1000");
    expect(exists(name)).toBe(false);
    // Run B resumes the conversation under another parent, in a pane of the same name, and exits.
    recordSpawn({ ...record, parent: "codex:new-parent", startedAt: 2_000, runBound: true });
    expect(start(name, paneDir, ["sh", "-c", "exit 4"], "legacy", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    // A's delayed hook fires now and names no run.
    await reportSpawnExit(name, "", "codex:old-parent");
    expect(exists(name)).toBe(true);
    await reportSpawnExit(name, "", "codex:new-parent", "2000");
    expect(exists(name)).toBe(false);
    expect(takeUnread("codex:old-parent").map((message) => message.body)).toEqual([
      "Child claude:legacy-hook-conversation exited with status 3.",
    ]);
    expect(takeUnread("codex:new-parent").map((message) => message.body)).toEqual([
      "Child claude:legacy-hook-conversation exited with status 4.",
    ]);
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test.each(["1000", ""])(
  "a run replaced while its reporter's discovery is paused is neither read nor reaped by it (run %p)",
  async (run) => {
    const state = Bun.env.XDG_STATE_HOME;
    Bun.env.XDG_STATE_HOME = join(paneDir, `replaced-run-state-${run || "none"}`);
    const name = `replaced-run-child-${run || "none"}`;
    let release!: (rows: sessions.Session[]) => void;
    const barrier = new Promise<sessions.Session[]>((resolve) => {
      release = resolve;
    });
    const discovery = spyOn(sessions, "listSessions").mockImplementation(() => barrier);
    let reporting: Promise<void> | undefined;
    try {
      const record = { agent: "claude" as const, id: "replaced-run-conversation", cwd: paneDir, pane: name };
      expect(start(name, paneDir, ["sh", "-c", "exit 3"], "replaced", true)).toBe(true);
      for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
      recordSpawn({ ...record, parent: "codex:old-parent", startedAt: 1_000 });
      // Run A's reporter, bound to its run or from a hook naming none, pauses in discovery.
      reporting = reportSpawnExit(name, "", "", run);
      expect(discovery).toHaveBeenCalledTimes(1);
      // Meanwhile A is reaped, and run B resumes in a pane of the same name under another parent and exits.
      kill(name);
      recordSpawn({ ...record, parent: "codex:new-parent", startedAt: 2_000, runBound: true });
      expect(start(name, paneDir, ["sh", "-c", "exit 4"], "replaced", true)).toBe(true);
      for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
      release([]);
      await reporting;
      expect(ended(name)?.status).toBe(4);
      expect(takeUnread("codex:old-parent")).toHaveLength(0);
      expect(takeUnread("codex:new-parent")).toHaveLength(0);
    } finally {
      release([]);
      await reporting;
      discovery.mockRestore();
      kill(name);
      if (state === undefined) delete Bun.env.XDG_STATE_HOME;
      else Bun.env.XDG_STATE_HOME = state;
    }
  },
);

test("a resumed child that exits before its spawn settles reports to the new parent under a new exit id", async () => {
  const saved = {
    state: Bun.env.XDG_STATE_HOME,
    config: Bun.env.XDG_CONFIG_HOME,
    claude: Bun.env.CLAUDE_CONFIG_DIR,
  };
  const root = join(paneDir, "resumed-early");
  const state = join(root, "state");
  const dir = join(root, "work");
  mkdirSync(join(root, "config", "kiln"), { recursive: true });
  mkdirSync(join(root, "claude"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  Bun.env.XDG_STATE_HOME = state;
  Bun.env.XDG_CONFIG_HOME = join(root, "config");
  Bun.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const server = `kiln-spawn-${process.pid}`;
  // The pane's exit hook runs in the tmux server's environment, so it reads this test's state too.
  Bun.spawnSync(["tmux", "-L", server, "set-environment", "-g", "XDG_STATE_HOME", state]);
  const id = crypto.randomUUID();
  const name = `claude-${id.replaceAll("-", "").slice(0, 20)}`;
  // A Claude that exits before it registers its session, noting the spawn record its exit reporters would read.
  const seen = join(root, "seen.json");
  const claude = join(root, "claude.sh");
  const reader = `import { spawnRecord } from ${JSON.stringify(resolve(import.meta.dir, "saved-sessions.ts"))}; await Bun.write(${JSON.stringify(seen)}, JSON.stringify(spawnRecord(${JSON.stringify(name)}) ?? null));`;
  writeFileSync(claude, `#!/bin/sh\nXDG_STATE_HOME='${state}' '${process.execPath}' -e '${reader}'\nexit 7\n`, {
    mode: 0o755,
  });
  writeFileSync(join(root, "config", "kiln", "config.toml"), `[agents]\nclaude = [${JSON.stringify(claude)}]\n`);
  try {
    // The run before this one exited and was reported to its own parent.
    recordSpawn({
      agent: "claude",
      id,
      cwd: dir,
      title: "resumed",
      parent: "codex:old-parent",
      startedAt: 1_000,
      pane: name,
    });
    expect(
      await spawnAgent(
        {
          agent: "claude",
          dir,
          prompt: "carry on",
          interactive: true,
          resume: { id, codeMode: false, title: "resumed" },
        },
        "codex:new-parent",
      ),
    ).toBe(`claude:${id}`);
    const record = JSON.parse(await Bun.file(seen).text());
    expect(record).toMatchObject({ agent: "claude", id, parent: "codex:new-parent" });
    expect(record.startedAt).not.toBe(1_000);
    let messages = takeUnread("codex:new-parent");
    for (let waited = 0; messages.length === 0 && waited < 15_000; waited += 100) {
      await Bun.sleep(100);
      messages = takeUnread("codex:new-parent");
    }
    expect(messages.map((message) => message.body)).toEqual([
      `Child claude:${id} exited with status 7 while working on "resumed".`,
    ]);
    expect(messages[0]?.id).toBe(exitReportId({ agent: "claude", id, startedAt: record.startedAt }));
    expect(takeUnread("codex:old-parent")).toHaveLength(0);
  } finally {
    kill(name);
    Bun.spawnSync(["tmux", "-L", server, "set-environment", "-gu", "XDG_STATE_HOME"]);
    for (const [key, value] of [
      ["XDG_STATE_HOME", saved.state],
      ["XDG_CONFIG_HOME", saved.config],
      ["CLAUDE_CONFIG_DIR", saved.claude],
    ] as const) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}, 30_000);

test("a resume replaces a pane whose agent was killed, rather than calling it running (#276)", async () => {
  const saved = {
    state: Bun.env.XDG_STATE_HOME,
    config: Bun.env.XDG_CONFIG_HOME,
    claude: Bun.env.CLAUDE_CONFIG_DIR,
  };
  const root = join(paneDir, "resumed-dead");
  const state = join(root, "state");
  const dir = join(root, "work");
  mkdirSync(join(root, "config", "kiln"), { recursive: true });
  mkdirSync(join(root, "claude"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  Bun.env.XDG_STATE_HOME = state;
  Bun.env.XDG_CONFIG_HOME = join(root, "config");
  Bun.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const server = `kiln-spawn-${process.pid}`;
  Bun.spawnSync(["tmux", "-L", server, "set-environment", "-g", "XDG_STATE_HOME", state]);
  const id = crypto.randomUUID();
  const name = `claude-${id.replaceAll("-", "").slice(0, 20)}`;
  const claude = join(root, "claude.sh");
  writeFileSync(claude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "config", "kiln", "config.toml"), `[agents]\nclaude = [${JSON.stringify(claude)}]\n`);
  try {
    // The earlier run was SIGKILLed, as an OOM killer does, and its kept pane stayed dead: nothing reaped it.
    expect(start(name, dir, ["sh", "-c", "kill -KILL $$"], "killed", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 5_000; waited += 50) await Bun.sleep(50);
    expect(ended(name)?.status).toBe(137);
    recordSpawn({
      agent: "claude",
      id,
      cwd: dir,
      title: "killed",
      parent: "codex:killed-parent",
      startedAt: 1_000,
      pane: name,
      runBound: true,
    });
    expect(
      await spawnAgent({
        agent: "claude",
        dir,
        prompt: "carry on",
        interactive: true,
        resume: { id, codeMode: false, title: "killed" },
      }),
    ).toBe(`claude:${id}`);
    // The killed run is reported to its parent before its pane is replaced.
    expect(takeUnread("codex:killed-parent").map((message) => message.body)).toEqual([
      `Child claude:${id} exited with status 137 while working on "killed".`,
    ]);
  } finally {
    kill(name);
    Bun.spawnSync(["tmux", "-L", server, "set-environment", "-gu", "XDG_STATE_HOME"]);
    for (const [key, value] of [
      ["XDG_STATE_HOME", saved.state],
      ["XDG_CONFIG_HOME", saved.config],
      ["CLAUDE_CONFIG_DIR", saved.claude],
    ] as const) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}, 30_000);

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
    expect(await hookSignalled(name, channel)).toBe(0);
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
    expect(await hookSignalled(name, channel)).toBe(0);
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

test("a watcher reports a child whose pane is gone before its exit can be read", async () => {
  // A pane's session can end before tmux has its status: a person closed it, tmux restarted, or a build without
  // remain-on-exit removed it. The record still names the child, so the report is made rather than lost (#240).
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "gone-state");
  const name = "gone-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    expect(start(name, paneDir, ["sleep", "60"], "gone", true)).toBe(true);
    recordSpawn({
      agent: "claude",
      id: "gone-session",
      cwd: paneDir,
      title: "gone work",
      startedAt: 2_000,
      pane: name,
      runBound: true,
    });
    expect(kill(name)).toBe(true);
    // A watcher left from an earlier run of the conversation must not report this run, even with no pane to check.
    await watchSpawnExit(name, "claude:gone-session", "claude:gone-parent", "1000", 20);
    await reportSpawnExit(name, "claude:gone-session", "claude:gone-parent");
    expect(peekUnread("claude:gone-parent")).toHaveLength(0);
    await watchSpawnExit(name, "claude:gone-session", "claude:gone-parent", "2000", 20);
    const messages = peekUnread("claude:gone-parent");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain('claude:gone-session ended while working on "gone work"');
    // The hook and the watcher can both report one exit; the message id keeps that one message.
    await reportSpawnExit(name, "claude:gone-session", "claude:gone-parent", "2000");
    expect(peekUnread("claude:gone-parent")).toHaveLength(1);
    // A send to the child now names its exit rather than a missing session.
    expect(() => findRecipient([], "claude:gone-session")).toThrow("claude:gone-session has exited");
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("a watcher that reads an exit while it is reported cannot report it without its status", async () => {
  // The hook and the watcher are separate processes. A reporter used to close the pane before posting, so a watcher
  // that read the pane in between found it gone and posted a status-less report first, which the message id then kept.
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "claim-order-state");
  const name = "claim-order-child";
  const server = `kiln-spawn-${process.pid}`;
  const channel = `claimed-${crypto.randomUUID()}`;
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  const realPost = mailbox.post;
  let seenAtPost: ReturnType<typeof paneState> | undefined;
  let watching: Promise<void> | undefined;
  // Run the watcher's read at the moment the first reporter posts, the step a second process can take in that window.
  const posting = spyOn(mailbox, "post").mockImplementation((...args: Parameters<typeof mailbox.post>) => {
    if (!watching) {
      seenAtPost = paneState(name);
      watching = watchSpawnExit(name, "claude:claim-order", "claude:claim-parent", "3000", 20);
    }
    return realPost(...args);
  });
  try {
    expect(
      start(
        name,
        paneDir,
        ["sh", "-c", "exit 7"],
        "claim order",
        true,
        exitHook(["tmux", "-L", server, "wait-for", "-S", channel]),
      ),
    ).toBe(true);
    expect(await hookSignalled(name, channel)).toBe(0);
    recordSpawn({
      agent: "claude",
      id: "claim-order",
      cwd: paneDir,
      title: "claim order",
      startedAt: 3_000,
      pane: name,
      runBound: true,
    });
    await reportSpawnExit(name, "claude:claim-order", "claude:claim-parent", "3000");
    await watching;
    expect(seenAtPost).toMatchObject({ status: 7 });
    const messages = peekUnread("claude:claim-parent");
    expect(messages.map((message) => message.body)).toEqual([
      'Child claude:claim-order exited with status 7 while working on "claim order".',
    ]);
    expect(exists(name)).toBe(false);
  } finally {
    posting.mockRestore();
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("a reporter that stops before closing a pane leaves its exit, with its status, to the next", async () => {
  // A reporter writes nothing before it posts and closes the pane only after, so one that stops or fails at any step
  // leaves the dead pane and its status for the hook or the watcher to report.
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "stopped-state");
  const name = "stopped-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    expect(start(name, paneDir, ["sh", "-c", "exit 7"], "stopped", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    recordSpawn({
      agent: "claude",
      id: "stopped",
      cwd: paneDir,
      title: "stopped",
      startedAt: 5_000,
      pane: name,
      runBound: true,
    });
    // One reporter read the exit and stopped there.
    expect(paneState(name)).toMatchObject({ status: 7 });
    // Another could not post.
    const failing = spyOn(mailbox, "post").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      await reportSpawnExit(name, "claude:stopped", "claude:stopped-parent", "5000");
    } finally {
      failing.mockRestore();
    }
    expect(ended(name)?.status).toBe(7);
    expect(peekUnread("claude:stopped-parent")).toHaveLength(0);
    // The hook and the watcher of that run still report it once, with its status, and close the pane.
    await reportSpawnExit(name, "claude:stopped", "claude:stopped-parent", "5000");
    await watchSpawnExit(name, "claude:stopped", "claude:stopped-parent", "5000", 20);
    expect(peekUnread("claude:stopped-parent").map((message) => message.body)).toEqual([
      'Child claude:stopped exited with status 7 while working on "stopped".',
    ]);
    expect(exists(name)).toBe(false);
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("an exit hook or watcher reads the spawn's tmux server, without a UTF-8 locale", async () => {
  // Neither runs in the spawner's process, so neither has its settings. One that read kiln's default server, or a tmux
  // reply printed for a client without a UTF-8 locale, found no pane and reported the child as ended without its status,
  // ahead of the report that had it.
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "reporter-state");
  const home = join(paneDir, "reporter-home");
  mkdirSync(home, { recursive: true });
  const name = "reporter-child";
  try {
    expect(start(name, paneDir, ["sh", "-c", "echo reporter; exit 7"], "reporter", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    recordSpawn({
      agent: "claude",
      id: "reporter",
      cwd: paneDir,
      title: "reporter",
      startedAt: 6_000,
      pane: name,
      runBound: true,
    });
    // Only what a hook started by a server without a locale has: no tmux server named, and no LANG.
    const env = { PATH: Bun.env.PATH ?? "", HOME: home, XDG_STATE_HOME: Bun.env.XDG_STATE_HOME };
    for (const command of ["exit", "watch"]) {
      const argv = exitReporter(command, name, "claude:reporter", "claude:reporter-parent", "6000");
      expect(await Bun.spawn(argv, { env, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
    }
    expect(peekUnread("claude:reporter-parent").map((message) => message.body)).toEqual([
      'Child claude:reporter exited with status 7 while working on "reporter".\n\nLast output:\n\nreporter',
    ]);
    expect(exists(name)).toBe(false);
  } finally {
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
}, 30_000);

test("a spawn with no caller reports its exit to the parent its record names", async () => {
  // A spawn from a shell, a timer or a detached worker records no caller, but the parent found for it later by process
  // ancestry is in the record, so its exit still reaches the session that started it (#240).
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "recorded-parent-state");
  const name = "recorded-parent-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    expect(start(name, paneDir, ["sh", "-c", "echo recorded; exit 4"], "recorded", true)).toBe(true);
    for (let waited = 0; !ended(name) && waited < 2_000; waited += 20) await Bun.sleep(20);
    recordSpawn({
      agent: "codex",
      id: "recorded-thread",
      cwd: paneDir,
      title: "recorded",
      parent: "codex:recorded-parent",
      startedAt: Date.now(),
      pane: name,
    });
    await reportSpawnExit(name, "", "");
    const messages = peekUnread("codex:recorded-parent");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("codex:recorded-thread exited with status 4");
  } finally {
    discovery.mockRestore();
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

test("a resumed Claude child carries on its conversation in the directory it began in", () => {
  const config = mkdtempSync(join(tmpdir(), "kiln-spawn-config-"));
  const dir = mkdtempSync(join(tmpdir(), "kiln-spawn-"));
  const previous = Bun.env.CLAUDE_CONFIG_DIR;
  Bun.env.CLAUDE_CONFIG_DIR = config;
  try {
    const id = "0f9a28c0-019a-4c72-9821-825fd64311f6";
    mkdirSync(join(config, "projects", "-somewhere"), { recursive: true });
    writeFileSync(
      join(config, "projects", "-somewhere", `${id}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: dir, sessionId: id })}\n`,
    );
    const options = spawnOptions(["claude", "--resume", `claude:${id}`, "--", "carry on"], "/tmp");
    expect(options).toMatchObject({ agent: "claude", dir, resume: { id, codeMode: false } });
    expect(headlessCommand(["claude"], "claude", id, "carry on", undefined, undefined, options.resume)).toEqual([
      "env",
      "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0",
      "claude",
      "-p",
      "--resume",
      id,
      "carry on",
    ]);
    // Claude resumes a Code Mode conversation only with Code Mode on.
    expect(
      interactiveClaudeCommand(["claude"], id, "carry on", undefined, undefined, "/account", { id, codeMode: true }),
    ).toEqual([
      "env",
      "CLAUDE_CONFIG_DIR=/account",
      "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1",
      "claude",
      "--resume",
      id,
      "--",
      "carry on",
    ]);
    // Claude will not resume a Code Mode conversation with Remote Control on, even when the configured command has it.
    const codeMode = { id, codeMode: true };
    expect(headlessCommand(["claude", "--remote-control"], "claude", id, "go", undefined, undefined, codeMode)).toEqual(
      [
        "env",
        "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0",
        "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1",
        "claude",
        "-p",
        "--resume",
        id,
        "go",
      ],
    );
    expect(
      interactiveClaudeCommand(["claude", "--remote-control"], id, "go", undefined, undefined, "/account", codeMode),
    ).not.toContain("--remote-control");
    expect(
      interactiveClaudeCommand(["claude", "--remote-control"], id, "go", undefined, undefined, "/account", {
        id,
        codeMode: false,
      }),
    ).toContain("--remote-control");
    expect(() => spawnOptions(["claude", "--resume", "1c949e39", "--", "go"])).toThrow(
      "no Claude conversation 1c949e39",
    );
    expect(() => spawnOptions(["claude", "--resume", id, "--dir", dir, "--", "go"])).toThrow("drop --dir");
    expect(() => spawnOptions(["pi", "--resume", id, "--", "go"])).toThrow("claude only");
  } finally {
    if (previous === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
    else Bun.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(config, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an interactive Claude child runs its full terminal UI with the chosen id, title, model and config dir", () => {
  expect(interactiveClaudeCommand(["claude"], "id", "work", undefined, undefined, "/account").slice(0, 5)).toEqual([
    "env",
    "CLAUDE_CONFIG_DIR=/account",
    "claude",
    "--session-id",
    "id",
  ]);
  // Without a config dir the child uses the home default, not one kiln's tmux server inherited.
  expect(interactiveClaudeCommand(["mclaude", "--chrome"], "id", "-start the sweep", "sweep", "opus")).toEqual([
    "env",
    "-u",
    "CLAUDE_CONFIG_DIR",
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

test("a spawned Codex run is named by the thread whose writer lock it holds", async () => {
  const thread = "01a1e476-5fbb-78d0-9ae0-1402282e804b";
  const locks = join(paneDir, "thread-writer-locks");
  mkdirSync(locks, { recursive: true });
  // Codex opens the lock a moment after it starts, once it has chosen the thread.
  const run = Bun.spawn(["sh", "-c", 'sleep 0.2; exec 3>"$1"; sleep 10', "sh", join(locks, `${thread}.lock`)]);
  try {
    expect(await spawnedCodexThread(run.pid)).toBe(thread);
  } finally {
    run.kill();
  }
  // A run that exits before it starts a thread has none, and the wait ends with it.
  const quit = Bun.spawn(["sh", "-c", "exit 1"]);
  await quit.exited;
  const started = Date.now();
  expect(await spawnedCodexThread(quit.pid, 10_000)).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("an exit watcher relays what a sandboxed child left in its outbox, as from that child (#264)", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "outbox-state");
  const name = "outbox-child";
  const discovery = spyOn(sessions, "listSessions").mockResolvedValue([]);
  try {
    expect(start(name, paneDir, ["sleep", "60"], "outbox", true)).toBe(true);
    recordSpawn({ agent: "codex", id: "outbox-thread", cwd: paneDir, startedAt: Date.now(), pane: name });
    const watching = watchSpawnExit(name, "", "claude:outbox-parent", "", 20);
    mkdirSync(outboxPath(name), { recursive: true });
    writeOutbox(outboxPath(name), "claude:outbox-parent", "review done");
    writeOutbox(outboxPath(name), "reviewer", "lost?");
    writeOutbox(outboxPath(name), "codex:outbox-thread", "me");
    let messages: mailbox.Message[] = [];
    for (let waited = 0; !messages.length && waited < 2_000; waited += 20) {
      await Bun.sleep(20);
      messages = peekUnread("claude:outbox-parent");
    }
    expect(messages.map(({ from, body }) => ({ from, body }))).toEqual([
      { from: "codex:outbox-thread", body: "review done" },
    ]);
    // A name that finds no one, or the child's own, comes back to the child with the reason, since it was told "queued".
    // Sends in one millisecond have no order between them, so these are compared sorted.
    const notices = peekUnread("codex:outbox-thread").map(({ from, body }) => ({ from, body }));
    expect(notices.sort((a, b) => a.body.localeCompare(b.body))).toEqual([
      {
        from: "kiln-spawn:codex:outbox-thread",
        body: "Your message to codex:outbox-thread was not delivered: you cannot message yourself\n\nme",
      },
      {
        from: "kiln-spawn:codex:outbox-thread",
        body: "Your message to reviewer was not delivered: no running session is called reviewer; run kiln msg list\n\nlost?",
      },
    ]);
    // Codex's sandbox leaves an empty mount point for each name it protects; the exit report clears them and the outbox.
    mkdirSync(join(outboxPath(name), ".codex"));
    kill(name);
    await watching;
    expect(existsSync(outboxPath(name))).toBe(false);
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("an exit without discovery relays full names, and the resumed run relays the rest (#264)", async () => {
  const state = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(paneDir, "outbox-offline-state");
  const name = "outbox-offline";
  const child = "claude:offline-child";
  const discovery = spyOn(sessions, "listSessions").mockRejectedValue(new Error("discovery down"));
  const first = { agent: "claude" as const, id: "offline-child", cwd: paneDir, pane: name, runBound: true };
  const box = (run: number) => outboxPath(`${name}.${run}`);
  try {
    expect(start(name, paneDir, ["sleep", "60"], "outbox", true)).toBe(true);
    recordSpawn({ ...first, startedAt: 1_000 });
    mkdirSync(box(1_000), { recursive: true });
    writeOutbox(box(1_000), "claude:offline-parent", "done");
    writeOutbox(box(1_000), "reviewer", "later");
    kill(name);
    await reportSpawnExit(name, child, "claude:offline-parent", "1000");
    expect(peekUnread("claude:offline-parent").map(({ from, body }) => ({ from, body }))[0]).toEqual({
      from: child,
      body: "done",
    });
    expect(readdirSync(box(1_000)).filter((file) => file.endsWith(".json"))).toHaveLength(1);

    // The resumed run has its own outbox, and relays what the first one left once discovery is back.
    discovery.mockResolvedValue([]);
    expect(start(name, paneDir, ["sleep", "60"], "outbox", true)).toBe(true);
    recordSpawn({ ...first, startedAt: 2_000 });
    mkdirSync(box(2_000), { recursive: true });
    kill(name);
    await reportSpawnExit(name, child, "claude:offline-parent", "2000");
    expect(peekUnread(child).map(({ body }) => body)).toEqual([
      "Your message to reviewer was not delivered: no running session is called reviewer; run kiln msg list\n\nlater",
    ]);
    expect(existsSync(box(1_000))).toBe(false);
    expect(existsSync(box(2_000))).toBe(false);
  } finally {
    discovery.mockRestore();
    kill(name);
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
  }
});

test("a Codex child in a linked worktree may write that worktree's git metadata (#264)", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-grants-"));
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(git("init", "-q", "main").exitCode).toBe(0);
    expect(
      git("-C", "main", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x")
        .exitCode,
    ).toBe(0);
    expect(git("-C", "main", "worktree", "add", "-q", join(root, "tree")).exitCode).toBe(0);
    const common = join(realpathSync(root), "main", ".git");
    expect(spawnGrants("codex", join(root, "tree"), "/outbox")).toEqual([
      "/outbox",
      join(common, "worktrees", "tree"),
      join(common, "objects"),
      join(common, "refs"),
      join(common, "logs"),
    ]);
    // A plain checkout keeps Codex's own rule for its .git, and Claude's sandbox already opens a worktree's metadata.
    expect(spawnGrants("codex", join(root, "main"), "/outbox")).toEqual(["/outbox"]);
    expect(spawnGrants("claude", join(root, "tree"), "/outbox")).toEqual(["/outbox"]);
    expect(headlessCommand(["codex"], "codex", "", "go", undefined, undefined, undefined, ["/a", "/b"])).toEqual([
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--add-dir",
      "/a",
      "--add-dir",
      "/b",
      "go",
    ]);
    // Claude grants its sandbox the outbox: --add-dir would first ask whether to trust it, and hold the child there.
    const grant = (allowWrite: string[], more = {}) =>
      JSON.stringify({ ...more, sandbox: { filesystem: { allowWrite } } });
    expect(claudeGrants(["claude"], root, ["/outbox"])).toEqual(["claude", "--settings", grant(["/outbox"])]);
    // Claude reads only the last --settings, so the one the configured command passes carries the grant.
    const inline = JSON.stringify({ model: "opus", sandbox: { filesystem: { allowWrite: ["/mine"] } } });
    expect(claudeGrants(["claude", "--settings", "{}", "--settings", inline, "--chrome"], root, ["/outbox"])).toEqual([
      "claude",
      "--settings",
      "{}",
      "--settings",
      grant(["/mine", "/outbox"], { model: "opus" }),
      "--chrome",
    ]);
    writeFileSync(join(root, "team.json"), JSON.stringify({ env: { A: "1" } }));
    expect(claudeGrants(["claude", "--settings=team.json"], root, ["/outbox"])).toEqual([
      "claude",
      "--settings",
      grant(["/outbox"], { env: { A: "1" } }),
    ]);
    expect(() => claudeGrants(["claude", "--settings", '{"sandbox": []}'], root, ["/outbox"])).toThrow(
      "is not a JSON object",
    );
    const interactive = interactiveClaudeCommand(claudeGrants(["claude"], root, ["/outbox"]), "id", "go");
    expect(interactive).not.toContain("--add-dir");
    expect(interactive).toContain(grant(["/outbox"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
