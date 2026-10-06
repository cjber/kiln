import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CodexThread, codexThreads } from "./codex";
import { kittyWindows } from "./kitty";
import { piStatus } from "./pi-status";
import { restartStopped } from "./saved-sessions";
import { transcriptTitle } from "./session-titles";
import { type Activity, agents, gitBranch, type Lifecycle, type Place, type Session } from "./sessions";
import { panes } from "./tmux";

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

/** Claude's end states for a background job; any other state is not treated as finished. */
function claudeLifecycle(state: string | undefined): Lifecycle | undefined {
  switch (state) {
    case "done":
      return "completed";
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}

type AgentProcess = Omit<Session, "place" | "branch"> & { pid: number; background?: Place };

type ClaudeAgent = {
  name?: string;
  sessionId?: string;
  pid?: number;
  cwd: string;
  startedAt?: number;
  status?: string;
  state?: string;
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

/** A finished job has no process; `claude attach` reopens it by its short job id. */
export function finishedClaudeJobs(listed: readonly ClaudeAgent[]): Session[] {
  return listed.flatMap((item) => {
    const lifecycle = claudeLifecycle(item.state);
    if (
      item.kind !== "background" ||
      item.pid !== undefined ||
      !lifecycle ||
      typeof item.id !== "string" ||
      !/^[a-f0-9]{8}$/.test(item.id) ||
      typeof item.cwd !== "string" ||
      !item.cwd.startsWith("/")
    )
      return [];
    return [
      {
        agent: "claude" as const,
        id: item.sessionId,
        title: item.name,
        cwd: item.cwd,
        startedAt: item.startedAt ?? 0,
        lastActiveAt: claudeTranscriptActivity(item),
        lifecycle,
        branch: gitBranch(item.cwd),
        place: { kind: "job" as const, id: item.id, attach: ["claude", "attach", item.id] },
      },
    ];
  });
}

let lastClaude: ClaudeAgent[] = [];

/** A listing that timed out or failed keeps the last rows with their status unknown, rather than emptying the list. */
export function claudeListing(source: string | undefined): ClaudeAgent[] {
  try {
    const listed: unknown = source === undefined ? undefined : JSON.parse(source);
    if (Array.isArray(listed)) {
      lastClaude = listed;
      return lastClaude;
    }
  } catch {
    // Output cut short by the timeout is a failed listing.
  }
  lastClaude = lastClaude.map(({ status, ...item }) => item);
  return lastClaude;
}

async function claudeSessions(): Promise<{ processes: AgentProcess[]; finished: Session[] }> {
  if (!Bun.which("claude")) return { processes: [], finished: [] };
  const process = Bun.spawn(["claude", "agents", "--json", "--all"], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => process.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  clearTimeout(timeout);
  const listed = claudeListing(code ? undefined : source);
  const processes = listed
    .flatMap((item) =>
      typeof item.pid === "number" && typeof item.cwd === "string" ? [{ ...item, pid: item.pid }] : [],
    )
    .filter((item) => existsSync(`/proc/${item.pid}`) && !isDaemon(item.pid))
    .flatMap((item) => {
      const transcript = claudeTranscriptPath(item);
      const session = {
        pid: item.pid,
        id: item.sessionId,
        title: transcript ? (transcriptTitle(transcript) ?? item.name) : item.name,
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
                kind: "job" as const,
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
  // A job resumed in a terminal is listed once, as the live session.
  const live = new Set(processes.map((session) => session.id));
  return {
    processes,
    finished: finishedClaudeJobs(listed).filter((job) => !job.id || !live.has(job.id)),
  };
}

/** Decided on argv, so a quoted prompt that begins with a subcommand's name is still one argument. */
export function isInteractiveCodex(args: readonly string[]): boolean {
  const word = args.slice(1).find((arg) => !arg.startsWith("-"));
  return !word || !["exec", "e", "review", "agents", "app-server", "exec-server", "mcp", "cloud"].includes(word);
}

async function pidsNamed(name: string): Promise<number[]> {
  const listed = Bun.spawn(["pgrep", "-x", name], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => listed.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(listed.stdout).text(), listed.exited]);
  clearTimeout(timeout);
  return code === 0 ? source.split("\n").filter(Boolean).map(Number) : [];
}

/** Codex has no scriptable session listing, so its live terminal sessions are found by process. */
async function codexProcesses(): Promise<AgentProcess[]> {
  return (await pidsNamed("codex")).flatMap((pid) => {
    const cwd = processCwd(pid);
    const args = processArgs(pid);
    if (!cwd || !args || !isInteractiveCodex(args) || isDaemon(pid)) return [];
    return [{ pid, agent: "codex" as const, cwd, startedAt: startedAt(pid) }];
  });
}

function hasTerminal(pid: number): boolean {
  try {
    return /^\/dev\/(pts\/|tty)/.test(readlinkSync(`/proc/${pid}/fd/0`));
  } catch {
    return false;
  }
}

/**
 * Pi replaces its argv with its name, so a terminal on stdin is what separates its TUI from the print
 * and RPC modes other programs drive. Only a Pi that kiln started reports its identity and activity.
 */
async function piProcesses(): Promise<AgentProcess[]> {
  return (await pidsNamed("pi")).flatMap((pid) => {
    const cwd = processCwd(pid);
    if (!cwd || !hasTerminal(pid) || isDaemon(pid)) return [];
    const started = startedAt(pid);
    return [{ pid, agent: "pi" as const, cwd, startedAt: started, ...piStatus(pid, started) }];
  });
}

function processArgs(pid: number): string[] | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    // The process may have exited.
    return undefined;
  }
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

/** Only Codex's execution environment establishes a daemon-owned conversation parent. */
export function inheritedCodexParent(environment: string): string | undefined {
  const entries = new Map(
    environment.split("\0").map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  const id = entries.get("CODEX_THREAD_ID") ?? entries.get("CODEX_SESSION_ID");
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : undefined;
}

function daemonParentThread(lineage: readonly number[]): string | undefined {
  try {
    const daemon = lineage.slice(1).some((pid) => {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return args[0]?.split("/").pop() === "codex" && args[1] === "app-server";
    });
    return daemon ? inheritedCodexParent(readFileSync(`/proc/${lineage[0]}/environ`, "utf8")) : undefined;
  } catch {
    return undefined;
  }
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
        kind: "thread" as const,
        id: thread.id,
        attach: ["codex", "resume", thread.id, "--remote", "unix://"],
      },
    }));
  return { processes: paired, headless };
}

/** `kitty: false` skips the window lookup, for callers that only count sessions. */
export async function listNativeSessions({ kitty = true } = {}): Promise<Session[]> {
  const readCodex = async () => {
    const processes = (await codexProcesses()).map((process) => ({
      ...process,
      threadId: codexThreadId(process.pid),
    }));
    const threads = await codexThreads(processes.flatMap((process) => (process.threadId ? [process.threadId] : [])));
    return withCodexThreads(processes, threads);
  };
  const [claude, owned, windows, codex, pi] = await Promise.all([
    claudeSessions(),
    panes(),
    kitty ? kittyWindows() : [],
    readCodex(),
    piProcesses(),
  ]);
  const running = [...claude.processes, ...codex.processes, ...pi];

  const places = new Map<number, Place>();
  for (const window of windows) {
    for (const pid of window.pids) places.set(pid, { kind: "kitty", socket: window.socket, windowId: window.id });
  }
  // A kiln pane wins over a kitty window: the window only holds the tmux client, never the agent.
  for (const pane of owned) places.set(pane.pid, { kind: "kiln", name: pane.name });

  const runningPids = new Set(running.map((process) => process.pid));
  const located = running.map(({ background, ...process }) => {
    const lineage: number[] = [];
    for (let pid: number | undefined = process.pid; pid; pid = parentPid(pid)) lineage.push(pid);
    const { ancestorSessionPid, place: found } = sessionLocation(lineage, places, runningPids);
    const inheritedParent =
      process.parentSessionId === undefined && ancestorSessionPid === undefined
        ? daemonParentThread(lineage)
        : undefined;
    const place = background ?? found ?? { kind: "elsewhere" as const, source: processSource(process.pid) };
    return {
      ...process,
      lastActiveAt: process.lastActiveAt ?? transcriptActivity(process.pid),
      ancestorSessionPid,
      parentSessionId: process.parentSessionId ?? inheritedParent,
      parentSessionAgent: inheritedParent ? ("codex" as const) : process.parentSessionAgent,
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
  const listed = [...sessions, ...codex.headless, ...claude.finished];
  return [...listed, ...restartStopped(listed)];
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
  const byPid = new Map(
    sessions.filter((session) => session.pid !== undefined).map((session) => [session.pid, session]),
  );
  return result.map((session) => {
    const parent = byPid.get(session.parentSessionPid);
    if (session.parentSessionId !== undefined || !parent?.id) return session;
    return { ...session, parentSessionId: parent.id, parentSessionAgent: parent.agent };
  });
}

/** A child can own a terminal, but cannot inherit one through another live agent. */
export function sessionLocation(
  lineage: readonly number[],
  places: ReadonlyMap<number, Place>,
  runningPids: ReadonlySet<number>,
): { ancestorSessionPid?: number; place?: Place } {
  let place: Place | undefined;
  for (const [index, pid] of lineage.entries()) {
    if (index > 0 && runningPids.has(pid)) return { ancestorSessionPid: pid, place };
    place ??= places.get(pid);
  }
  return { place };
}
