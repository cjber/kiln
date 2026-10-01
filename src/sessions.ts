import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { claudeCloudSnapshot } from "./claude-cloud";
import { cloudSnapshot } from "./cloud";
import { type CodexThread, codexThreads } from "./codex";
import { kittyWindows } from "./kitty";
import { piStates } from "./pi";
import { transcriptTitle } from "./session-titles";
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
  | { kind: "cloud"; id: string; title: string; url?: string }
  | { kind: "elsewhere"; source?: string };

export type Session = {
  /** Provider identity and display name, when reported. */
  id?: string;
  title?: string;
  /** The agent's process; a Codex daemon thread has none of its own. */
  pid?: number;
  /** The live kiln session whose agent spawned this process. */
  parentSessionPid?: number;
  parentSessionId?: string;
  agent: Agent;
  piRemote?: boolean;
  cwd: string;
  startedAt: number;
  /** Last provider or transcript update, when available. */
  lastActiveAt?: number;
  /** Agent-reported status; terminal output never establishes activity. */
  activity?: Activity;
  /** The branch checked out in `cwd`, or a short commit when HEAD is detached. */
  branch?: string;
  place: Place;
};

type AgentProcess = Omit<Session, "place" | "branch"> & { pid: number; background?: Place };

type ClaudeAgent = {
  name?: string;
  sessionId?: string;
  pid: number;
  cwd: string;
  startedAt?: number;
  status?: string;
  kind?: string;
  id?: string;
};

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

function claudeTranscriptPath(item: ClaudeAgent): string | undefined {
  if (!item.sessionId || !/^[A-Za-z0-9-]+$/.test(item.sessionId)) return undefined;
  return join(
    Bun.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "projects",
    item.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${item.sessionId}.jsonl`,
  );
}

function claudeTranscriptActivity(item: ClaudeAgent): number | undefined {
  const path = claudeTranscriptPath(item);
  try {
    return path ? statSync(path).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

async function claudeProcesses(): Promise<AgentProcess[]> {
  if (!Bun.which("claude")) return [];
  const process = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => process.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  clearTimeout(timeout);
  if (code) return [];
  let listed: unknown;
  try {
    listed = JSON.parse(source);
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) return [];
  return (listed as ClaudeAgent[])
    .filter((item) => typeof item.pid === "number" && typeof item.cwd === "string")
    .filter((item) => existsSync(`/proc/${item.pid}`) && !isDaemon(item.pid))
    .flatMap((item) => {
      const transcript = claudeTranscriptPath(item);
      const session = {
        pid: item.pid,
        id: item.sessionId,
        title: transcript ? (transcriptTitle(transcript, "claude") ?? item.name) : item.name,
        agent: "claude" as const,
        cwd: processCwd(item.pid) ?? item.cwd,
        startedAt: item.startedAt ?? startedAt(item.pid),
        lastActiveAt: claudeTranscriptActivity(item),
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
async function processesNamed(agent: Agent, isInteractive: (command: string) => boolean): Promise<AgentProcess[]> {
  const listed = Bun.spawn(["pgrep", "-a", "-x", agent], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => listed.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(listed.stdout).text(), listed.exited]);
  clearTimeout(timeout);
  if (code !== 0) return [];
  return source
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [rawPid, ...rest] = line.split(" ");
      const pid = Number(rawPid);
      const cwd = processCwd(pid);
      if (!cwd || !isInteractive(rest.join(" ")) || isDaemon(pid)) return [];
      let args: string[];
      try {
        args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      } catch (error) {
        if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
        throw error;
      }
      const nameIndex = args.findIndex((arg) => arg === "--name" || arg === "-n");
      const sessionIndex = args.indexOf("--session");
      const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
      const title =
        agent === "pi"
          ? sessionFile?.endsWith(".jsonl")
            ? transcriptTitle(resolve(cwd, sessionFile), "pi")
            : nameIndex >= 0
              ? args[nameIndex + 1]
              : undefined
          : undefined;
      return [{ pid, agent, cwd, title, startedAt: startedAt(pid) }];
    });
}

/** Open transcript files establish recent activity without reading conversation contents. */
function transcriptActivity(pid: number): number | undefined {
  let latest: number | undefined;
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const path = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (path.endsWith(".jsonl") && (path.includes("/projects/") || path.includes("/sessions/")))
          latest = latestActivity(latest, statSync(path).mtimeMs);
      } catch {
        // File descriptors can close during discovery.
      }
    }
  } catch {
    // The process may have exited.
  }
  return latest;
}

function latestActivity(...times: (number | undefined)[]): number | undefined {
  const valid = times.filter((time): time is number => time !== undefined && Number.isFinite(time) && time > 0);
  return valid.length ? Math.max(...valid) : undefined;
}

/** A resumed terminal reports its identity in argv even when the daemon owns its lock. */
export function resumedCodexThread(args: readonly string[]): string | undefined {
  const id = args[2];
  return args[1] === "resume" && id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ? id
    : undefined;
}

/** Older Codex TUIs hold a local thread lock; they must not borrow a daemon thread's status. */
function codexThreadId(pid: number): string | undefined {
  try {
    const resumed = resumedCodexThread(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"));
    if (resumed) return resumed;
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

/** A task is a thread, not a terminal client; never guess ownership from its directory. */
export function withCodexThreads(
  processes: (AgentProcess & { threadId?: string })[],
  threads: CodexThread[],
): { processes: AgentProcess[]; headless: Session[] } {
  const unpaired = [...threads];
  const paired = processes.flatMap(({ threadId, ...process }) => {
    if (!threadId) return threads.length ? [] : [process];
    const thread = threads.find((thread) => thread.id === threadId);
    if (thread && unpaired.includes(thread)) unpaired.splice(unpaired.indexOf(thread), 1);
    return [
      {
        ...process,
        id: threadId,
        title: thread?.title,
        cwd: thread?.cwd ?? process.cwd,
        activity: thread?.activity,
        lastActiveAt: thread?.updatedAt,
        parentSessionId: thread?.parentThreadId,
      },
    ];
  });
  // Unmatched daemon threads remain attachable even when their terminal ownership is uncertain.
  const headless = unpaired
    .filter((thread) => thread.activity !== undefined)
    .map((thread) => ({
      agent: "codex" as const,
      id: thread.id,
      parentSessionId: thread.parentThreadId,
      title: thread.title,
      cwd: thread.cwd,
      startedAt: thread.createdAt,
      lastActiveAt: thread.updatedAt,
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
  const readCodex = async () => {
    const processes = (await processesNamed("codex", isInteractiveCodex)).map((process) => ({
      ...process,
      threadId: codexThreadId(process.pid),
    }));
    const threads = await codexThreads(processes.flatMap((process) => (process.threadId ? [process.threadId] : [])));
    return withCodexThreads(processes, threads);
  };
  const [claude, owned, windows, codex, pi] = await Promise.all([
    claudeProcesses(),
    panes(),
    kitty ? kittyWindows() : [],
    readCodex(),
    processesNamed("pi", isInteractivePi),
  ]);
  const states = await piStates(pi.map(({ pid }) => pid));
  const running = [
    ...claude,
    ...codex.processes,
    ...pi.map((session) => {
      const state = states.get(session.pid);
      return state
        ? {
            ...session,
            id: state.sessionId,
            title: state.title,
            cwd: state.cwd,
            activity: state.activity,
            lastActiveAt: state.updatedAt,
            piRemote: true,
          }
        : session;
    }),
  ];

  const places = new Map<number, { place: Place }>();
  for (const window of windows) {
    for (const pid of window.pids)
      places.set(pid, { place: { kind: "kitty", socket: window.socket, windowId: window.id } });
  }
  // A kiln pane wins over a kitty window: the window only holds the tmux client, never the agent.
  for (const pane of owned) places.set(pane.pid, { place: { kind: "kiln", name: pane.name } });

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
    return {
      ...process,
      lastActiveAt: process.lastActiveAt ?? transcriptActivity(process.pid),
      ancestorSessionPid,
      branch: gitBranch(process.cwd),
      place,
    };
  });
  const sessions = deduplicateSessions(
    located.map(({ ancestorSessionPid, ...session }) => ({
      ...session,
      parentSessionPid: ancestorSessionPid,
    })),
  );
  return nestSessions(
    [
      ...sessions,
      ...codex.headless,
      ...(cloud ? cloudSnapshot().sessions : []),
      ...(cloud && claudeCloud ? claudeCloudSnapshot().sessions : []),
    ].sort((left, right) => left.cwd.localeCompare(right.cwd) || left.startedAt - right.startedAt),
  );
}

/** Keep one client per confirmed Codex task, preferring a terminal kiln can open. */
export function deduplicateSessions(sessions: readonly Session[]): Session[] {
  const result: Session[] = [];
  const indices = new Map<string, number>();
  for (const session of sessions) {
    if (session.agent !== "codex" || session.id === undefined) {
      result.push(session);
      continue;
    }
    const index = indices.get(session.id);
    if (index === undefined) {
      indices.set(session.id, result.length);
      result.push(session);
    } else if (result[index]?.place.kind === "elsewhere" && session.place.kind !== "elsewhere") {
      result[index] = session;
    }
  }
  return result;
}

/** A child can own a terminal, but cannot inherit one through another live agent. */
export function sessionLocation(
  lineage: readonly number[],
  places: ReadonlyMap<number, { place: Place }>,
  runningPids: ReadonlySet<number>,
): { ancestorSessionPid?: number; found?: { place: Place } } {
  let found: { place: Place } | undefined;
  for (const [index, pid] of lineage.entries()) {
    if (index > 0 && runningPids.has(pid)) return { ancestorSessionPid: pid, found };
    found ??= places.get(pid);
  }
  return { found };
}

/** Resolve provider-first parents once, rejecting cycles and any path into one. */
export function sessionParents(sessions: readonly Session[], queried?: Session): Map<Session, Session | undefined> {
  const candidates = queried && !sessions.includes(queried) ? [...sessions, queried] : sessions;
  const ids = new Map<string, Session[]>();
  const pids = new Map<number, Session[]>();
  for (const session of sessions) {
    if (session.id !== undefined) {
      const key = `${session.agent}:${session.id}`;
      const group = ids.get(key) ?? [];
      group.push(session);
      ids.set(key, group);
    }
    if (session.pid !== undefined) {
      const group = pids.get(session.pid) ?? [];
      group.push(session);
      pids.set(session.pid, group);
    }
  }
  const parents = new Map<Session, Session | undefined>();
  for (const session of candidates) {
    const provider =
      session.parentSessionId === undefined
        ? undefined
        : ids.get(`${session.agent}:${session.parentSessionId}`)?.find((parent) => parent !== session);
    const process =
      session.parentSessionPid === undefined
        ? undefined
        : pids.get(session.parentSessionPid)?.find((parent) => parent !== session);
    parents.set(session, provider ?? process);
  }
  const valid = new Map<Session, boolean>();
  for (const session of candidates) {
    const path = new Set<Session>();
    let ancestor: Session | undefined = session;
    while (ancestor && !valid.has(ancestor) && !path.has(ancestor)) {
      path.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    const accepted = ancestor === undefined || valid.get(ancestor) === true;
    for (const member of path) valid.set(member, accepted);
  }
  for (const session of candidates) if (!valid.get(session)) parents.set(session, undefined);
  return parents;
}

/** Provider relationships survive daemon execution, where children have no terminal PID. */
export function sessionParent(session: Session, sessions: readonly Session[]): Session | undefined {
  return sessionParents(sessions, session).get(session);
}

/** Keep children directly beneath their parent, preserving the order within each group. */
export function nestSessions(sessions: readonly Session[]): Session[] {
  const parents = sessionParents(sessions);
  const children = new Map<Session | undefined, Session[]>();
  for (const session of sessions) {
    const parent = parents.get(session);
    const group = children.get(parent) ?? [];
    group.push(session);
    children.set(parent, group);
  }
  const result: Session[] = [];
  const seen = new Set<Session>();
  const pending = [...(children.get(undefined) ?? [])].reverse();
  while (pending.length) {
    const session = pending.pop();
    if (!session || seen.has(session)) continue;
    seen.add(session);
    result.push(session);
    const descendants = children.get(session) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) {
      const child = descendants[index];
      if (child) pending.push(child);
    }
  }
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
