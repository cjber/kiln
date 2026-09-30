import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { claudeCloudSnapshot } from "./claude-cloud";
import { cloudSnapshot } from "./cloud";
import { type CodexThread, codexThreads } from "./codex";
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
  | { kind: "cloud"; id: string; title: string }
  | { kind: "elsewhere"; source?: string };

export type Session = {
  /** The agent's process; a Codex daemon thread has none of its own. */
  pid?: number;
  /** The live kiln session whose agent spawned this process. */
  parentSessionPid?: number;
  agent: Agent;
  cwd: string;
  startedAt: number;
  /** Last transcript update or terminal output, when available. */
  lastActiveAt?: number;
  /** Agent-reported status, or recent pane output when no status is available. */
  activity?: Activity;
  /** The branch checked out in `cwd`, or a short commit when HEAD is detached. */
  branch?: string;
  place: Place;
};

type AgentProcess = Omit<Session, "place" | "branch"> & { pid: number; background?: Place };

type ClaudeAgent = { pid: number; cwd: string; startedAt?: number; status?: string; kind?: string; id?: string };

/** Recent output suggests work; silence alone cannot establish that a turn has finished. */
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

/** Process names and terminal paths explain provenance without exposing command arguments. */
function processSource(pid: number): string {
  const details = [`pid ${pid}`];
  try {
    const terminal = readlinkSync(`/proc/${pid}/fd/0`);
    if (terminal.startsWith("/dev/")) details.push(terminal);
  } catch {
    // A process can exit while the list refreshes.
  }
  let immediateParent: string | undefined;
  for (let parent = parentPid(pid); parent; parent = parentPid(parent)) {
    try {
      const name = readFileSync(`/proc/${parent}/comm`, "utf8").trim();
      immediateParent ??= `parent ${name} (${parent})`;
      if (agents.some((agent) => agent === name)) {
        details.push(`spawned by ${name} (${parent})`);
        return details.join(" · ");
      }
    } catch {
      break;
    }
  }
  if (immediateParent) details.push(immediateParent);
  return details.join(" · ");
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
        ? resolve(
            dir,
            readFileSync(dotGit, "utf8")
              .replace(/^gitdir:\s*/, "")
              .trim(),
          )
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
        cwd: processCwd(item.pid) ?? item.cwd,
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
          return [
            {
              ...session,
              background: {
                kind: "background" as const,
                id: item.id,
                attach: ["claude", "attach", item.id],
                stop: ["claude", "stop", item.id],
              },
            },
          ];
        default:
          return [];
      }
    });
}

/** The first bare word, so a flag that merely contains a subcommand's name still counts as interactive. */
function subcommand(command: string): string | undefined {
  return command
    .split(/\s+/)
    .slice(1)
    .find((word) => !word.startsWith("-"));
}

export function isInteractiveCodex(command: string): boolean {
  const word = subcommand(command);
  return !word || !["exec", "e", "review", "agents", "app-server", "exec-server", "mcp", "cloud"].includes(word);
}

export function isInteractivePi(command: string): boolean {
  const words = command.split(/\s+/);
  if (words.some((word) => ["-p", "--print", "--mode", "--export", "--list-models", "-h", "--help"].includes(word)))
    return false;
  const word = subcommand(command);
  return !word || !["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"].includes(word);
}

/** Codex and pi have no scriptable session listing, so their live sessions are found by process. */
function processesNamed(agent: Agent, isInteractive: (command: string) => boolean): AgentProcess[] {
  const listed = Bun.spawnSync(["pgrep", "-a", "-x", agent], { stdout: "pipe", stderr: "ignore" });
  if (listed.exitCode !== 0) return [];
  return listed.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [rawPid, ...rest] = line.split(" ");
      const pid = Number(rawPid);
      const cwd = processCwd(pid);
      if (!cwd || !isInteractive(rest.join(" ")) || isDaemon(pid)) return [];
      return [{ pid, agent, cwd, startedAt: startedAt(pid) }];
    });
}

/** Older Codex TUIs hold a local thread lock; they must not borrow a daemon thread's status. */
function codexThreadId(pid: number): string | undefined {
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const path = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const match = path.match(/\/thread-writer-locks\/([0-9a-f-]+)\.lock$/);
        if (match) return match[1];
      } catch {
        // File descriptors can close during discovery.
      }
    }
  } catch {
    // The process may have exited.
  }
  return undefined;
}

/** Match known thread IDs first; directory matches are usable only when unambiguous. */
export function withCodexThreads(
  processes: (AgentProcess & { threadId?: string })[],
  threads: CodexThread[],
): { processes: AgentProcess[]; headless: Session[] } {
  const unpaired = [...threads];
  const identified = processes.map(({ threadId, ...process }) => {
    const thread = threadId ? unpaired.find((thread) => thread.id === threadId) : undefined;
    if (thread) unpaired.splice(unpaired.indexOf(thread), 1);
    return { process: { ...process, cwd: thread?.cwd ?? process.cwd, activity: thread?.activity }, threadId };
  });
  const paired = identified.map(({ process, threadId }) => {
    if (threadId) return process;
    const candidates = unpaired.filter((thread) => thread.cwd === process.cwd);
    const peers = processes.filter((peer) => !peer.threadId && peer.cwd === process.cwd);
    if (candidates.length !== 1 || peers.length !== 1) return process;
    const thread = candidates[0];
    if (!thread) return process;
    unpaired.splice(unpaired.indexOf(thread), 1);
    return { ...process, cwd: thread.cwd, activity: thread.activity };
  });
  // Unmatched daemon threads remain attachable even when their terminal ownership is uncertain.
  const headless = unpaired.map((thread) => ({
    agent: "codex" as const,
    cwd: thread.cwd,
    startedAt: thread.createdAt,
    activity: thread.activity,
    branch: gitBranch(thread.cwd),
    place: {
      kind: "background" as const,
      id: thread.id,
      attach: ["codex", "resume", thread.id, "--remote", "unix://"],
    },
  }));
  return { processes: paired, headless };
}

/** `kitty: false` skips the window lookup, for callers that only count sessions. */
export async function listSessions({ kitty = true, cloud = false, claudeCloud = false } = {}): Promise<Session[]> {
  const [claude, owned, windows, threads] = await Promise.all([
    claudeProcesses(),
    panes(),
    kitty ? kittyWindows() : [],
    codexThreads(),
  ]);
  const codex = withCodexThreads(
    processesNamed("codex", isInteractiveCodex).map((process) => ({
      ...process,
      threadId: codexThreadId(process.pid),
    })),
    threads,
  );
  const running = [...claude, ...codex.processes, ...processesNamed("pi", isInteractivePi)];

  const places = new Map<number, { place: Place; activityAt?: number }>();
  for (const window of windows) {
    for (const pid of window.pids)
      places.set(pid, { place: { kind: "kitty", socket: window.socket, windowId: window.id } });
  }
  // A kiln pane wins over a kitty window: the window only holds the tmux client, never the agent.
  for (const pane of owned)
    places.set(pane.pid, { place: { kind: "kiln", name: pane.name }, activityAt: pane.activityAt });

  const runningPids = new Set(running.map((process) => process.pid));
  const located = running.map(({ background, ...process }) => {
    const lineage: number[] = [];
    for (let pid: number | undefined = process.pid; pid; pid = parentPid(pid)) lineage.push(pid);
    const { ancestorSessionPid, found } = sessionLocation(lineage, places, runningPids);
    const place = background ??
      found?.place ?? {
        kind: "elsewhere" as const,
        source: processSource(process.pid),
      };
    const activity =
      process.activity ??
      (found?.activityAt !== undefined && Date.now() - found.activityAt < workingWindowMs ? "working" : undefined);
    return { ...process, ancestorSessionPid, activity, branch: gitBranch(process.cwd), place };
  });
  const sessions = located.map(({ ancestorSessionPid, ...session }) => ({
    ...session,
    parentSessionPid:
      located.find((parent) => parent.pid === ancestorSessionPid)?.place.kind === "kiln"
        ? ancestorSessionPid
        : undefined,
  }));
  return nestSessions(
    [
      ...sessions,
      ...codex.headless,
      ...(cloud ? cloudSnapshot().sessions : []),
      ...(cloud && claudeCloud ? claudeCloudSnapshot().sessions : []),
    ].sort((left, right) => left.cwd.localeCompare(right.cwd) || left.startedAt - right.startedAt),
  );
}

/** A child can own a terminal, but cannot inherit one through another live agent. */
export function sessionLocation(
  lineage: readonly number[],
  places: ReadonlyMap<number, { place: Place; activityAt?: number }>,
  runningPids: ReadonlySet<number>,
): { ancestorSessionPid?: number; found?: { place: Place; activityAt?: number } } {
  let found: { place: Place; activityAt?: number } | undefined;
  for (const [index, pid] of lineage.entries()) {
    if (index > 0 && runningPids.has(pid)) return { ancestorSessionPid: pid, found };
    found ??= places.get(pid);
  }
  return { found };
}

/** Keep children directly beneath their parent, preserving the order within each group. */
export function nestSessions(sessions: readonly Session[]): Session[] {
  const result: Session[] = [];
  const seen = new Set<Session>();
  const append = (session: Session) => {
    if (seen.has(session)) return;
    seen.add(session);
    result.push(session);
    if (session.pid !== undefined)
      for (const child of sessions) if (child.parentSessionPid === session.pid) append(child);
  };
  for (const session of sessions)
    if (!sessions.some((parent) => parent.pid !== undefined && parent.pid === session.parentSessionPid))
      append(session);
  return result;
}

/** The status bar's right side: only the counts that are non-zero, working first. */
export function summarise(sessions: readonly Session[]): string {
  const count = (activity: Activity) => sessions.filter((session) => session.activity === activity).length;
  const parts = (["working", "waiting", "idle"] as const).flatMap((activity) =>
    count(activity) ? [`${count(activity)} ${activity}`] : [],
  );
  return parts.length ? parts.join(" · ") : `${sessions.length} sessions`;
}
