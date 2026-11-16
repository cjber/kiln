import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand, resumeStopped } from "./launcher";
import { pickSessions } from "./resume-cli";
import { restartStopped } from "./saved-sessions";
import type { Session } from "./sessions";
import { defaults } from "./settings";
import { exists, start, survives } from "./tmux";
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
