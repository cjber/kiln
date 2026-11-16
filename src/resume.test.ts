import { Database } from "bun:sqlite";
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand, resumeStopped } from "./launcher";
import { pickSessions } from "./resume-cli";
import { restartStopped } from "./saved-sessions";
import type { Session } from "./sessions";
import { defaults } from "./settings";
import { awaitStart, exists, respawn, start, survives } from "./tmux";
import { killServer } from "./tmux-server";

// A private tmux server, so these tests never touch the real sessions.
Bun.env.KILN_TMUX_SERVER = `kiln-test-${process.pid}`;
// The agent's environment is what kiln gives it, not whatever the test runner inherited.
delete Bun.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE;
const dir = mkdtempSync(join(tmpdir(), "kiln-resume-"));
afterAll(() => {
  killServer(`kiln-test-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
});

const stopped = (id: string, agent: Session["agent"] = "claude"): Session => ({
  agent,
  id,
  cwd: dir,
  startedAt: 1,
  lifecycle: "stopped",
  place: { kind: "saved" },
});

test("a kept pane reports why its command quit, and a running one is left alone", async () => {
  expect(start("quits", dir, ["sh", "-c", "echo no login; exit 3"], "quits", true)).toBe(true);
  expect(await survives("quits", 2_000, 50)).toEqual({ status: 3, output: "no login" });
  expect(exists("quits")).toBe(false);
  expect(start("runs", dir, ["sleep", "30"], "runs", true)).toBe(true);
  expect(await survives("runs", 300, 50)).toBe(true);
  expect(exists("runs")).toBe(true);
});

test("a command that closes its terminal before it exits is reported with its own status", async () => {
  // tmux marks a pane dead once its terminal closes, which can be before it has the command's exit status.
  const closes = "trap '' HUP; echo cannot be resumed; exec >&- 2>&- <&-; sleep 0.3; exit 1";
  expect(start("closes", dir, ["sh", "-c", closes], "closes", true)).toBe(true);
  expect(await survives("closes", 2_000, 50)).toEqual({ status: 1, output: "cannot be resumed" });
  expect(start("killed", dir, ["sh", "-c", "echo stopped; kill -TERM $$"], "killed", true)).toBe(true);
  expect(await survives("killed", 2_000, 50)).toEqual({ status: 143, output: "stopped" });
});

test("a command that closes its terminal and runs on counts as running once its grace period ends", async () => {
  const pidFile = join(dir, "runs-on.pid");
  const runsOn = `trap '' HUP; echo $$ > ${pidFile}; exec >&- 2>&- <&-; exec sleep 30`;
  expect(start("runs-on", dir, ["sh", "-c", runsOn], "runs on", true)).toBe(true);
  try {
    const watched = survives("runs-on", 300, 50);
    expect(await Promise.race([watched, Bun.sleep(3_000).then(() => "still waiting")])).toBe(true);
  } finally {
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  }
  // Released, its session closes as usual once the command exits.
  for (let waited = 0; exists("runs-on") && waited < 2_000; waited += 50) await Bun.sleep(50);
  expect(exists("runs-on")).toBe(false);
});

/** Answer reads of `/proc` with `answer`, as a system that hides or fakes process state would; other reads pass through. */
function fakeProc(answer: (path: string) => string) {
  const read = fs.readFileSync;
  return spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) =>
    String(path).startsWith("/proc/")
      ? answer(String(path))
      : read(path, options as BufferEncoding)) as typeof fs.readFileSync);
}

test("a dead pane whose command cannot be inspected is released once its grace period ends", async () => {
  const pidFile = join(dir, "hidden.pid");
  const runsOn = `trap '' HUP; echo $$ > ${pidFile}; exec >&- 2>&- <&-; exec sleep 30`;
  const denied = fakeProc((path) => {
    throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
  });
  try {
    expect(start("hidden", dir, ["sh", "-c", runsOn], "hidden", true)).toBe(true);
    const watched = survives("hidden", 100, 50);
    expect(await Promise.race([watched, Bun.sleep(3_000).then(() => "still waiting")])).toBe(true);
  } finally {
    denied.mockRestore();
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  }
});

test("a command that exits without tmux collecting its status is reported once its grace period ends", async () => {
  const pidFile = join(dir, "uncollected.pid");
  const runsOn = `trap '' HUP; echo $$ > ${pidFile}; echo never collected; exec >&- 2>&- <&-; exec sleep 30`;
  // The command reads as exited while it runs on, so the nudge to tmux never yields a status.
  const zombie = fakeProc(() => "1 (sleep) Z 0 0 0");
  try {
    expect(start("uncollected", dir, ["sh", "-c", runsOn], "uncollected", true)).toBe(true);
    const watched = survives("uncollected", 100, 50);
    const result = await Promise.race([watched, Bun.sleep(3_000).then(() => "still waiting")]);
    // A tmux that marks a pane dead only once its command exits, such as 3.8, never asks about the process here.
    if (zombie.mock.calls.some(([path]) => String(path).startsWith("/proc/"))) {
      expect(result).toEqual({ status: -1, output: "never collected" });
      expect(exists("uncollected")).toBe(false);
    } else expect(result).toBe(true);
  } finally {
    zombie.mockRestore();
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  }
});

test("a server that exits while a dead pane is read reports the session gone", async () => {
  const server = Bun.env.KILN_TMUX_SERVER;
  Bun.env.KILN_TMUX_SERVER = `kiln-gone-${process.pid}`;
  const pidFile = join(dir, "gone.pid");
  const closes = `trap '' HUP; echo $$ > ${pidFile}; exec >&- 2>&- <&-; exec sleep 30`;
  // The server exits between the read of a dead pane without a status and the signal sent to it.
  const signal = spyOn(process, "kill").mockImplementation(() => {
    killServer(`kiln-gone-${process.pid}`);
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  });
  try {
    expect(start("gone", dir, ["sh", "-c", closes], "gone", true)).toBe(true);
    const result = await survives("gone", 300, 50);
    // A tmux that marks a pane dead only once its command exits, such as 3.8, has nothing to signal here.
    expect(result).toEqual(signal.mock.calls.length ? { status: -1, output: "" } : true);
  } finally {
    signal.mockRestore();
    killServer(`kiln-gone-${process.pid}`);
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    Bun.env.KILN_TMUX_SERVER = server;
  }
});

/**
 * Respawn `name` with a healthy command right after the first read of its pane that `when` accepts, as a concurrent
 * reconnect can between a watcher's read and its action. Says whether it has.
 */
function respawnAfterRead(name: string, when: (read: string) => boolean) {
  const spawn = Bun.spawnSync;
  const state = { respawned: false };
  const spy = spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options?: object) => {
    const result = spawn(command, options);
    const read = command.some((part) => String(part).startsWith("#{pane_dead}\t")) ? result.stdout.toString() : "";
    if (!state.respawned && read && when(read)) {
      state.respawned = true;
      expect(respawn(name, dir, ["sleep", "30"])).toBe(true);
    }
    return result;
  }) as typeof Bun.spawnSync);
  return { state, restore: () => spy.mockRestore() };
}

/** Whether a session's window still keeps its pane once its command exits. */
const kept = (name: string) =>
  Bun.spawnSync([
    "tmux",
    "-L",
    String(Bun.env.KILN_TMUX_SERVER),
    "show-options",
    "-w",
    "-v",
    "-t",
    `=${name}:`,
    "remain-on-exit",
  ])
    .stdout.toString()
    .trim() === "on";

test("a pane respawned after a watcher reads it running is left kept for its new command", async () => {
  expect(start("respawned-running", dir, ["sleep", "30"], "respawned running", true)).toBe(true);
  const replaced = respawnAfterRead("respawned-running", (read) => read.startsWith("0\t"));
  try {
    expect(await survives("respawned-running", 0, 50)).toBe(true);
  } finally {
    replaced.restore();
  }
  expect(replaced.state.respawned).toBe(true);
  expect(exists("respawned-running")).toBe(true);
  expect(kept("respawned-running")).toBe(true);
});

test("a pane respawned after a watcher reads its exit is left running", async () => {
  expect(start("respawned-exit", dir, ["sh", "-c", "echo old; exit 3"], "respawned exit", true)).toBe(true);
  const replaced = respawnAfterRead("respawned-exit", (read) => /^1\t\d/.test(read));
  try {
    expect(await survives("respawned-exit", 2_000, 50)).toBe(true);
  } finally {
    replaced.restore();
  }
  expect(replaced.state.respawned).toBe(true);
  expect(exists("respawned-exit")).toBe(true);
});

test("a pane respawned after a launch is read as hung is left running", async () => {
  expect(start("respawned-hung", dir, ["sleep", "30"], "respawned hung", true)).toBe(true);
  const replaced = respawnAfterRead("respawned-hung", (read) => read.startsWith("0\t"));
  try {
    expect(await awaitStart("respawned-hung", async () => false, 0, 50)).toBe(true);
  } finally {
    replaced.restore();
  }
  expect(replaced.state.respawned).toBe(true);
  expect(exists("respawned-hung")).toBe(true);
});

test("a pane respawned after a watcher reads its command as exiting is not abandoned", async () => {
  const pidFile = join(dir, "respawned-exiting.pid");
  const runsOn = `trap '' HUP; echo $$ > ${pidFile}; exec >&- 2>&- <&-; exec sleep 30`;
  // The old command reads as exited without a status, so the deadline abandons it.
  const zombie = fakeProc(() => "1 (sleep) Z 0 0 0");
  const replaced = respawnAfterRead("respawned-exiting", (read) => read.startsWith("1\t\t\t"));
  try {
    expect(start("respawned-exiting", dir, ["sh", "-c", runsOn], "respawned exiting", true)).toBe(true);
    // A tmux that marks a pane dead only once its command exits, such as 3.8, reads it running and releases it.
    for (let waited = 0; !existsSync(pidFile) && waited < 2_000; waited += 50) await Bun.sleep(50);
    await Bun.sleep(100);
    expect(await survives("respawned-exiting", 0, 50)).toBe(true);
    expect(exists("respawned-exiting")).toBe(true);
    if (replaced.state.respawned) expect(kept("respawned-exiting")).toBe(true);
  } finally {
    replaced.restore();
    zombie.mockRestore();
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  }
});

/** A fake provider listing: the agent counts as running in its pane once it has written `marker`. */
const listedOnce = (marker: string) => ({ started: async () => existsSync(marker), timeoutMs: 5_000, pollMs: 50 });

test("a resumed agent that quits at launch is started once more", async () => {
  const marker = join(dir, "tried");
  const listed = join(dir, "flaky-listed");
  const flaky = `if [ -e ${marker} ]; then touch ${listed}; sleep 30; else touch ${marker}; echo lock busy; exit 1; fi`;
  const settings = { ...defaults, remoteControl: false, agents: { ...defaults.agents, claude: ["sh", "-c", flaky] } };
  const result = await resumeStopped(stopped("flaky"), settings, undefined, listedOnce(listed));
  expect(result).toHaveProperty("name");
  expect(exists((result as { name: string }).name)).toBe(true);
});

test("an agent that keeps quitting is reported with what it printed", async () => {
  const settings = {
    ...defaults,
    remoteControl: false,
    agents: { ...defaults.agents, claude: ["sh", "-c", "echo config locked; exit 2"] },
  };
  expect(await resumeStopped(stopped("broken"), settings, undefined, listedOnce(join(dir, "never")))).toEqual({
    problem: "Claude exited with status 2: config locked",
  });
});

test("an agent that quits after a while, before its provider lists it, is reported and stays stopped", async () => {
  const before = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(dir, "state");
  try {
    const session = stopped("slow-refusal");
    const path = join(dir, "state", "kiln", "sessions.sqlite");
    const boots = () =>
      new Database(path, { readonly: true }).query("SELECT boot FROM sessions WHERE id = 'slow-refusal'").all();
    // A row a restart stopped: saved in an earlier boot.
    restartStopped([{ ...session, pid: process.pid, place: { kind: "kiln", name: "old" } }]);
    new Database(path).query("UPDATE sessions SET boot = 'earlier'").run();
    const settings = {
      ...defaults,
      remoteControl: false,
      agents: { ...defaults.agents, claude: ["sh", "-c", "sleep 0.5; echo cannot be resumed; exit 1"] },
    };
    // Refreshes while the agent briefly ran saw the conversation, as `kiln serve` does, which marks it resumed.
    const refresh = setInterval(
      () => restartStopped([{ ...session, pid: process.pid, place: { kind: "kiln", name: "claude-x" } }]),
      50,
    );
    try {
      expect(await resumeStopped(session, settings, undefined, listedOnce(join(dir, "never")))).toEqual({
        problem: "Claude exited with status 1: cannot be resumed",
      });
    } finally {
      clearInterval(refresh);
    }
    expect(boots()).toEqual([{ boot: "earlier" }]);
  } finally {
    if (before === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = before;
  }
});

test("an agent that quits while discovery is awaited is reported, not left as a dead pane", async () => {
  const marker = join(dir, "listed-then-quit");
  expect(
    start("late-quit", dir, ["sh", "-c", `touch ${marker}; sleep 0.3; echo gone; exit 4`], "late-quit", true),
  ).toBe(true);
  // Discovery lists the agent, then takes long enough over another provider that the agent quits meanwhile.
  const started = async () => {
    if (!existsSync(marker)) return false;
    await Bun.sleep(1_000);
    return true;
  };
  expect(await awaitStart("late-quit", started, 5_000, 50)).toEqual({ status: 4, output: "gone" });
  expect(exists("late-quit")).toBe(false);
});

test("a listing taken while a failed resume ran does not take the stopped row over", async () => {
  const before = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(dir, "stale-state");
  try {
    const session = stopped("stale-listing");
    const path = join(dir, "stale-state", "kiln", "sessions.sqlite");
    restartStopped([{ ...session, pid: process.pid, place: { kind: "kiln", name: "old" } }]);
    new Database(path).query("UPDATE sessions SET boot = 'earlier'").run();
    const pidFile = join(dir, "stale-listing-pid");
    const settings = {
      ...defaults,
      remoteControl: false,
      agents: { ...defaults.agents, claude: ["sh", "-c", `echo $$ > ${pidFile}; sleep 0.3; exit 1`] },
    };
    expect(await resumeStopped(session, settings, undefined, listedOnce(join(dir, "never")))).toEqual({
      problem: "Claude exited with status 1",
    });
    // A refresh that listed the agent while it ran, and writes only now that the resume has failed.
    const pid = Number(readFileSync(pidFile, "utf8"));
    restartStopped([{ ...session, pid, place: { kind: "kiln", name: "claude-stale-listing" } }]);
    expect(new Database(path, { readonly: true }).query("SELECT boot FROM sessions").all()).toEqual([
      { boot: "earlier" },
    ]);
    expect(restartStopped([]).map((item) => item.id)).toEqual(["stale-listing"]);
  } finally {
    if (before === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = before;
  }
});

test("an agent its provider never lists is stopped and reported with what it shows", async () => {
  const settings = {
    ...defaults,
    remoteControl: false,
    agents: { ...defaults.agents, claude: ["sh", "-c", "echo 'Turn on Code Mode? (y/n)'; sleep 30"] },
  };
  const watch = { started: async () => false, timeoutMs: 500, pollMs: 50 };
  const result = await resumeStopped(stopped("prompting"), settings, undefined, watch);
  expect(result).toEqual({ problem: "Claude did not start: Turn on Code Mode? (y/n)" });
  expect(exists("claude-prompting")).toBe(false);
});

test("a conversation Claude recorded in Code Mode resumes with Code Mode on and no Remote Control", async () => {
  const before = Bun.env.CLAUDE_CONFIG_DIR;
  const config = join(dir, "claude");
  Bun.env.CLAUDE_CONFIG_DIR = config;
  try {
    const project = join(config, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "code-mode-id.jsonl"),
      `${JSON.stringify({ type: "repl-mode", replMode: true, sessionId: "code-mode-id" })}\n`,
    );
    const out = join(dir, "code-mode-argv");
    const fake = `printf '%s %s\\n' "$CLAUDE_CODE_EXPERIMENTAL_CODE_MODE" "$*" > ${out}; sleep 30`;
    const settings = {
      ...defaults,
      remoteControl: true,
      agents: { ...defaults.agents, claude: ["sh", "-c", fake, "sh"] },
    };
    expect(await resumeStopped(stopped("code-mode-id"), settings, "continue", listedOnce(out))).toHaveProperty("name");
    expect(readFileSync(out, "utf8")).toBe("1 --resume code-mode-id -- continue\n\n");
  } finally {
    if (before === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
    else Bun.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("Code Mode drops Remote Control, including from the configured command", () => {
  const settings = {
    ...defaults,
    remoteControl: true,
    agents: { ...defaults.agents, claude: ["mclaude", "--chrome", "--remote-control"] },
  };
  expect(agentCommand("claude", settings, "abc", "go on", true)).toEqual([
    "mclaude",
    "--chrome",
    "--resume",
    "abc",
    "--",
    "go on",
  ]);
  expect(agentCommand("claude", settings, "abc")).toEqual([
    "mclaude",
    "--chrome",
    "--remote-control",
    "--resume",
    "abc",
  ]);
});

test("names pick stopped sessions by whole name or unique prefix", () => {
  const rows = [stopped("abc123"), stopped("abd456"), stopped("abc123", "codex")];
  expect(pickSessions(rows, ["claude:abc"], "stopped")).toEqual([rows[0] as Session]);
  expect(pickSessions(rows, ["abd"], "stopped")).toEqual([rows[1] as Session]);
  expect(() => pickSessions(rows, ["abc"], "stopped")).toThrow("more than one");
  expect(() => pickSessions(rows, ["zzz"], "stopped")).toThrow('no stopped session "zzz"');
});
