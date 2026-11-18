import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { takeUnread } from "./mailbox";
import * as opencode from "./opencode";
import { recordSpawn } from "./saved-sessions";
import * as sessions from "./sessions";
import {
  exitHook,
  exitMessage,
  exitReportId,
  headlessCommand,
  interactiveClaudeCommand,
  reportSpawnExit,
  settleClaudeTrust,
  spawnAgent,
  spawnedCodexThread,
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
    await watchSpawnExit(name, "", "codex:parent", 20);
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
  const watching = watchSpawnExit(name, "", "codex:close-parent", 20);
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
    const watching = watchSpawnExit(name, "", "codex:respawn-parent", 20);
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
