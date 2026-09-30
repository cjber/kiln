import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { codexThreads, type CodexThread } from "./codex";
import { kittyWindows } from "./kitty";
import { panes } from "./tmux";

export type Agent = "claude" | "codex" | "pi";

export const agents: readonly Agent[] = ["claude", "codex", "pi"];

/** What a session is doing, as far as anyone can tell: `waiting` means it stopped to ask you something. */
export type Activity = "working" | "waiting" | "idle";

/** Claude's own statuses, grouped; anything newer than this list shows as unknown rather than guessed. */
function claudeActivity(status: string | undefined): Activity | undefined {
  switch (status) {
    case "busy":
      return "working";
    case "waiting":
    case "needs_input":
    case "requires_action":
    case "blocked":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

/**
 * What Enter does with a session: attach to kiln's own tmux, focus the kitty
 * window it runs in, or run the agent's own `attach` for a session with no
 * terminal (kiln runs it in its tmux, so the way back is the same).
 */
export type Place =
  | { kind: "kiln"; name: string }
  | { kind: "kitty"; socket: string; windowId: number }
  | { kind: "background"; id: string; attach: string[]; stop?: string[] }
  | { kind: "elsewhere" };

export type Session = {
  /** The agent's process; a Codex daemon thread has none of its own. */
  pid?: number;
  agent: Agent;
  cwd: string;
  startedAt: number;
  /** Claude reports its own; kiln-owned sessions of other agents derive it from pane output. */
  activity?: Activity;
  /** The branch checked out in `cwd`, or a short commit when HEAD is detached. */
  branch?: string;
  place: Place;
};

type AgentProcess = Omit<Session, "place" | "branch"> & { pid: number; background?: Place };

type ClaudeAgent = { pid: number; cwd: string; startedAt?: number; status?: string; kind?: string; id?: string };

/** A pane that produced output this recently is mid-turn: every agent animates a spinner while working. */
const workingWindowMs = 3_000;

function startedAt(pid: number): number {
  // On Linux /proc/<pid> is created with the process, so its mtime is the start time.
  try {
    return statSync(`/proc/${pid}`).mtimeMs;
  } catch {
    return 0;
  }
}

function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesised and may contain spaces; ppid is the second field after it.
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return parent > 1 ? parent : undefined;
  } catch {
    return undefined;
  }
}

function processCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/** Read from HEAD directly: a git subprocess per session on every refresh is the slow path. */
function gitBranch(cwd: string): string | undefined {
  try {
    for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
      const dotGit = join(dir, ".git");
      if (!existsSync(dotGit)) continue;
      // A linked worktree's `.git` is a file pointing at its real git directory.
      const gitDir = statSync(dotGit).isFile()
        ? resolve(dir, readFileSync(dotGit, "utf8").replace(/^gitdir:\s*/, "").trim())
        : dotGit;
      const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
    }
  } catch {
    // An unreadable repository just has no branch to show.
  }
  return undefined;
}

/**
 * The systemd unit supervising a process. `claude-rc` keeps a Remote Control
 * server per repo, each reporting itself as interactive; a service unit is what
 * separates that daemon from an agent a person started in a terminal `.scope`.
 */
function isDaemon(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().endsWith(".service");
  } catch {
    return false;
  }
}

async function claudeProcesses(): Promise<AgentProcess[]> {
  if (!Bun.which("claude")) return [];
  const process = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore" });
  if (await process.exited) return [];
  let listed: unknown;
  try {
    listed = JSON.parse(await new Response(process.stdout).text());
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) return [];
  return (listed as ClaudeAgent[])
    .filter((item) => typeof item.pid === "number" && typeof item.cwd === "string")
    .filter((item) => !isDaemon(item.pid))
    .flatMap((item) => {
      const session = {
        pid: item.pid,
        agent: "claude" as const,
        cwd: item.cwd,
        startedAt: item.startedAt ?? startedAt(item.pid),
        activity: claudeActivity(item.status),
      };
      switch (item.kind ?? "interactive") {
        case "interactive":
          return [session];
        // `claude --bg` and agent view run a session with no terminal; `claude attach` gives it one.
        case "background":
          // `attach` and `stop` take the short job id, not the sessionId.
          if (!item.id) return [];
          return [{ ...session, background: { kind: "background" as const, id: item.id, attach: ["claude", "attach", item.id], stop: ["claude", "stop", item.id] } }];
        default:
          return [];
      }
    });
}

/** The first bare word, so a flag that merely contains a subcommand's name still counts as interactive. */
function subcommand(command: string): string | undefined {
  return command.split(/\s+/).slice(1).find((word) => !word.startsWith("-"));
}

export function isInteractiveCodex(command: string): boolean {
  const word = subcommand(command);
  return !word || !["exec", "e", "review", "agents", "app-server", "exec-server", "mcp", "cloud"].includes(word);
}

export function isInteractivePi(command: string): boolean {
  const words = command.split(/\s+/);
  if (words.some((word) => ["-p", "--print", "--mode", "--export", "--list-models", "-h", "--help"].includes(word))) return false;
  const word = subcommand(command);
  return !word || !["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"].includes(word);
}

/** Codex and pi have no scriptable session listing, so their live sessions are found by process. */
function processesNamed(agent: Agent, isInteractive: (command: string) => boolean): AgentProcess[] {
  const listed = Bun.spawnSync(["pgrep", "-a", "-x", agent], { stdout: "pipe", stderr: "ignore" });
  if (listed.exitCode !== 0) return [];
  return listed.stdout.toString().split("\n").filter(Boolean).flatMap((line) => {
    const [rawPid, ...rest] = line.split(" ");
    const pid = Number(rawPid);
    const cwd = processCwd(pid);
    if (!cwd || !isInteractive(rest.join(" ")) || isDaemon(pid)) return [];
    return [{ pid, agent, cwd, startedAt: startedAt(pid) }];
  });
}

/**
 * Every live `codex` TUI keeps a thread on the daemon, which does not say which
 * TUI holds it, so they pair up by directory in start order. A paired TUI takes
 * its thread's status; a thread left over runs with no terminal (`codex agents`).
 */
function withCodexThreads(processes: AgentProcess[], threads: CodexThread[]): { processes: AgentProcess[]; headless: Session[] } {
  const unpaired = [...threads].sort((left, right) => left.createdAt - right.createdAt);
  const paired = [...processes].sort((left, right) => left.startedAt - right.startedAt).map((process) => {
    const index = unpaired.findIndex((thread) => thread.cwd === process.cwd);
    if (index < 0) return process;
    const [thread] = unpaired.splice(index, 1);
    return { ...process, activity: thread?.activity };
  });
  const headless = unpaired.map((thread) => ({
    agent: "codex" as const,
    cwd: thread.cwd,
    startedAt: thread.createdAt,
    activity: thread.activity,
    branch: gitBranch(thread.cwd),
    place: { kind: "background" as const, id: thread.id, attach: ["codex", "resume", thread.id, "--remote", "unix://"] },
  }));
  return { processes: paired, headless };
}

/** `kitty: false` skips the window lookup, for callers that only count sessions. */
export async function listSessions({ kitty = true } = {}): Promise<Session[]> {
  const [claude, owned, windows, threads] = await Promise.all([claudeProcesses(), panes(), kitty ? kittyWindows() : [], codexThreads()]);
  const codex = withCodexThreads(processesNamed("codex", isInteractiveCodex), threads);
  const running = [...claude, ...codex.processes, ...processesNamed("pi", isInteractivePi)];

  const places = new Map<number, { place: Place; activityAt?: number }>();
  for (const window of windows) {
    for (const pid of window.pids) places.set(pid, { place: { kind: "kitty", socket: window.socket, windowId: window.id } });
  }
  // A kiln pane wins over a kitty window: the window only holds the tmux client, never the agent.
  for (const pane of owned) places.set(pane.pid, { place: { kind: "kiln", name: pane.name }, activityAt: pane.activityAt });

  const located = running.map(({ background, ...process }) => {
    let found: { place: Place; activityAt?: number } | undefined;
    for (let pid: number | undefined = process.pid; pid && !found; pid = parentPid(pid)) found = places.get(pid);
    const place = background ?? found?.place ?? { kind: "elsewhere" as const };
    const activity = process.activity
      ?? (found?.activityAt === undefined ? undefined : Date.now() - found.activityAt < workingWindowMs ? "working" : "idle");
    return { ...process, activity, branch: gitBranch(process.cwd), place };
  });
  return [...located, ...codex.headless]
    .sort((left, right) => left.cwd.localeCompare(right.cwd) || left.startedAt - right.startedAt);
}

/** The status bar's right side: only the counts that are non-zero, working first. */
export function summarise(sessions: readonly Session[]): string {
  const count = (activity: Activity) => sessions.filter((session) => session.activity === activity).length;
  const parts = (["working", "waiting", "idle"] as const).flatMap((activity) => count(activity) ? [`${count(activity)} ${activity}`] : []);
  return parts.length ? parts.join(" · ") : `${sessions.length} sessions`;
}
