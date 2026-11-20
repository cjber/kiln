import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, statSync } from "node:fs";
import { accountOf } from "./accounts";
import { agyProcesses } from "./agy";
import { type ClaudeRecord, claudeInbox, claudeRecord, claudeShellRunning, claudeTranscript } from "./claude-inbox";
import { type CodexThread, codexThreads } from "./codex";
import { kittyWindows } from "./kitty";
import { callerIdentity } from "./messages";
import { museProcesses } from "./muse";
import {
  archiveOpencodeSession,
  type HeadlessProcess,
  isOpencodeService,
  matchHeadlessProcesses,
  type OpencodeListing,
  opencodeInvocation,
  opencodeSessions,
  opencodeWorkdir,
} from "./opencode";
import { piStatus } from "./pi-status";
import { attachParents, rememberParents, restartStopped } from "./saved-sessions";
import {
  type Activity,
  agents,
  gitBranch,
  type Lifecycle,
  type Missing,
  type Place,
  processStartTicks,
  type Session,
  sessionIdentity,
} from "./sessions";
import { loadSettings } from "./settings";
import { panes, screen } from "./tmux";
import { readTranscript } from "./transcript";

/**
 * A listed session's status. `claude agents` reports `shell` (a turn that ended with background shells running) as
 * `busy`, so a busy session's own record tells them apart. Claude writes a print-mode (`claude -p`, entrypoint
 * `sdk-cli`) record only as the process starts, so there the transcript says when a turn has ended, and the process then
 * waits on its background shells (`shell`) or, with none running, only on a wakeup or a message (`idle`). A failed
 * listing has no status, and stays unknown.
 *
 * An interactive Claude can stay `busy` with no turn running, as it does while it compacts an idle conversation. Its
 * pane says whether a turn runs (`turnShown`), so a session whose transcript ended its turn and whose pane shows none
 * running is idle; with no pane to read, Claude's own status stands.
 */
export function claudeStatus(
  listed: string | undefined,
  record: ClaudeRecord,
  turnEnded: boolean | undefined,
  shellRunning: () => boolean,
  turnShown: () => boolean | undefined = () => undefined,
): string | undefined {
  if (listed !== "busy") return listed;
  if (record.entrypoint !== "sdk-cli") {
    if (record.status === "shell") return "shell";
    return turnEnded && turnShown() === false ? "idle" : "busy";
  }
  if (!turnEnded) return "busy";
  return shellRunning() ? "shell" : "idle";
}

/**
 * Whether a Claude pane shows a turn running: the last row of Claude's footer reads `esc to interrupt` for as long as
 * a turn runs, and never at a prompt waiting for input. A footer cut short with `…` may have lost those words, so it
 * says nothing.
 */
export function claudeTurnShown(text: string): boolean | undefined {
  const footer = text
    .split("\n")
    .map((row) => row.trimEnd())
    .findLast(Boolean);
  if (footer === undefined) return undefined;
  if (footer.includes("esc to interrupt")) return true;
  return footer.endsWith("…") ? undefined : false;
}

/**
 * Claude's own statuses, grouped as its agent view groups them; anything newer than this list shows as
 * unknown rather than guessed. `shell` is a turn that has ended while a background shell or agent it
 * started keeps running, which Claude itself counts as working.
 */
export function claudeActivity(status: string | undefined): Activity | undefined {
  switch (status) {
    case "busy":
    case "shell":
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
    // A job that crashed has ended without finishing; it can still be attached to read why.
    case "crashed":
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
  /** The start of the process `pid` named when this row was listed, so a cached row never takes a later owner's. */
  processStart?: number;
};

function startedAt(pid: number): number {
  // On Linux /proc/<pid> is created with the process, so its mtime is the start time.
  try {
    return statSync(`/proc/${pid}`).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether a process is stopped by a signal, as SIGSTOP or a job-control stop leaves it until it is continued. */
export function processStopped(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The state follows the parenthesised command name: T is stopped by a signal. A tracer's stop, t, is left out: a
    // debugger or strace holds a running process there for moments at a time.
    return stat[stat.lastIndexOf(")") + 2] === "T";
  } catch {
    return false;
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

function claudeTranscriptActivity(item: ClaudeAgent): number | undefined {
  const path = claudeTranscript(item.cwd, item.sessionId);
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
    const transcript = claudeTranscript(item.cwd, item.sessionId);
    const { title, workdir } = transcript ? readTranscript(transcript) : {};
    return [
      {
        agent: "claude" as const,
        id: item.sessionId,
        title: title ?? item.name,
        cwd: item.cwd,
        workdir,
        startedAt: item.startedAt ?? 0,
        lastActiveAt: claudeTranscriptActivity(item),
        lifecycle,
        branch: gitBranch(workdir ?? item.cwd),
        place: { kind: "job" as const, id: item.id, attach: ["claude", "attach", item.id] },
      },
    ];
  });
}

let lastClaude: ClaudeAgent[] = [];

/**
 * A listing that timed out or failed keeps the last rows with their status unknown, rather than emptying the list.
 * Each process is stamped with its start when it is listed, and a kept row keeps that stamp. `kept` says the rows are
 * those last ones, none at all in a process's first listing, so a Claude running now may be absent from them.
 */
export function claudeListing(
  source: string | undefined,
  start = processStartTicks,
): { agents: ClaudeAgent[]; kept: boolean } {
  try {
    const listed: unknown = source === undefined ? undefined : JSON.parse(source);
    if (Array.isArray(listed)) {
      lastClaude = (listed as ClaudeAgent[]).map((item) =>
        typeof item.pid === "number" ? { ...item, processStart: start(item.pid) } : item,
      );
      return { agents: lastClaude, kept: false };
    }
  } catch {
    // Output cut short by the timeout is a failed listing.
  }
  lastClaude = lastClaude.map(({ status, ...item }) => item);
  return { agents: lastClaude, kept: true };
}

async function claudeSessions(
  owned: Promise<{ name: string; pid: number }[]>,
): Promise<{ processes: AgentProcess[]; finished: Session[]; kept: boolean }> {
  if (!Bun.which("claude")) return { processes: [], finished: [], kept: false };
  const process = Bun.spawn(["claude", "agents", "--json", "--all"], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => process.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  clearTimeout(timeout);
  const { agents: listed, kept } = claudeListing(code ? undefined : source);
  const kilnPanes = new Map((await owned).map((pane) => [pane.pid, pane.name]));
  const claudePids = new Set(listed.map((item) => item.pid));
  // The kiln pane a Claude runs in, as its own process or under a wrapper; never the pane of another session above it.
  const paneOf = (pid: number) => {
    for (let current: number | undefined = pid; current; current = parentPid(current)) {
      const name = kilnPanes.get(current);
      if (name !== undefined) return name;
      if (current !== pid && claudePids.has(current)) return undefined;
    }
    return undefined;
  };
  const processes = listed
    .flatMap((item) =>
      typeof item.pid === "number" && typeof item.cwd === "string" ? [{ ...item, pid: item.pid }] : [],
    )
    // A kept row's pid can belong to another process by now; only the process it was listed with is this session.
    .filter(
      (item) =>
        item.processStart !== undefined && processStartTicks(item.pid) === item.processStart && !isDaemon(item.pid),
    )
    .flatMap((item) => {
      const transcript = claudeTranscript(item.cwd, item.sessionId);
      const { title, workdir, turnEnded, limited } = transcript ? readTranscript(transcript) : {};
      const status = claudeStatus(
        item.status,
        claudeRecord(item.pid),
        turnEnded,
        () => claudeShellRunning(item.pid),
        () => {
          const pane = paneOf(item.pid);
          const shown = pane === undefined ? undefined : screen(pane);
          return shown && claudeTurnShown(shown.text);
        },
      );
      const session = {
        pid: item.pid,
        processStart: item.processStart,
        id: item.sessionId,
        title: title ?? item.name,
        agent: "claude" as const,
        cwd: processCwd(item.pid) ?? item.cwd,
        workdir,
        startedAt: item.startedAt ?? startedAt(item.pid),
        lastActiveAt: claudeTranscriptActivity(item),
        activity: claudeActivity(status),
        turnEnded: status === "shell" || undefined,
        claudeInbox: claudeInbox(item.pid) !== undefined || undefined,
        limited,
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
    kept,
    finished: finishedClaudeJobs(listed).filter((job) => !job.id || !live.has(job.id)),
  };
}

/** Decided on argv, so a quoted prompt that begins with a subcommand's name is still one argument. */
export function isInteractiveCodex(args: readonly string[]): boolean {
  let word: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index] as string;
    if (!arg.startsWith("-")) {
      word = arg;
      break;
    }
    // `-c key=value app-server`: the value of an option is not the subcommand.
    if (codexValueOptions.has(arg)) index++;
  }
  return !word || !["exec", "e", "review", "agents", "app-server", "exec-server", "mcp", "cloud"].includes(word);
}

/** Codex's global options that take their value as the next argument, from `codex --help`. */
const codexValueOptions = new Set(
  "-c --config --enable --disable --remote --remote-auth-token-env -i --image -m --model --local-provider -p --profile -s --sandbox -C --cd --add-dir -a --ask-for-approval".split(
    " ",
  ),
);

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

/** `codex exec` is headless and names its thread only after it starts, so its process is its identity. */
async function codexExecProcesses(): Promise<AgentProcess[]> {
  return (await pidsNamed("codex")).flatMap((pid) => {
    const cwd = processCwd(pid);
    const args = processArgs(pid);
    if (!cwd || !args || args[1] !== "exec" || isDaemon(pid)) return [];
    return [codexExecProcess(pid, cwd, startedAt(pid), openFiles(pid))];
  });
}

/**
 * A running `codex exec` process. It runs a single turn non-interactively, with nobody to ask anything, and exits as
 * that turn ends: while the process runs, it is working. It runs on its own app server, not Codex's shared daemon.
 */
export function codexExecProcess(pid: number, cwd: string, started: number, files: readonly string[]): AgentProcess {
  return {
    pid,
    agent: "codex",
    id: codexExecThread(files),
    cwd,
    startedAt: started,
    activity: "working",
    codexExec: true,
  };
}

function openFiles(pid: number): string[] {
  try {
    return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
      } catch {
        // File descriptors can close during discovery.
        return [];
      }
    });
  } catch {
    // The process may have exited.
    return [];
  }
}

/** The first line of a file, read in pieces: a rollout grows to megabytes and only its opening record is wanted. */
function firstLine(path: string): string | undefined {
  try {
    const file = openSync(path, "r");
    try {
      const chunk = Buffer.alloc(65_536);
      const pieces: Buffer[] = [];
      for (;;) {
        const read = readSync(file, chunk, 0, chunk.length, null);
        if (!read) return undefined;
        const end = chunk.subarray(0, read).indexOf(10);
        pieces.push(Buffer.from(chunk.subarray(0, end === -1 ? read : end)));
        if (end !== -1) return Buffer.concat(pieces).toString("utf8");
      }
    } finally {
      closeSync(file);
    }
  } catch {
    return undefined;
  }
}

/** A rollout's opening record never changes, so each file is read once. */
const rolloutThreads = new Map<string, { id: string; parent?: string } | undefined>();

function rolloutThread(path: string): { id: string; parent?: string } | undefined {
  if (rolloutThreads.has(path)) return rolloutThreads.get(path);
  const line = firstLine(path);
  // The record is written after the file is opened, so an empty rollout is read again on the next pass.
  if (line === undefined) return undefined;
  let thread: { id: string; parent?: string } | undefined;
  try {
    const record = JSON.parse(line) as { type?: unknown; payload?: { id?: unknown; parent_thread_id?: unknown } };
    if (record.type === "session_meta" && typeof record.payload?.id === "string")
      thread = {
        id: record.payload.id,
        parent: typeof record.payload.parent_thread_id === "string" ? record.payload.parent_thread_id : undefined,
      };
  } catch {
    // Not a rollout this version of kiln can read.
  }
  rolloutThreads.set(path, thread);
  return thread;
}

/**
 * The thread a `codex exec` run answers as, which is the id its commands see in `CODEX_THREAD_ID`. The process
 * holds a rollout for it and one for each sub-agent it starts; every sub-agent's rollout names the thread that
 * started it, so the run's own thread is the one with no parent.
 */
export function codexExecThread(
  files: readonly string[],
  read: (path: string) => { id: string; parent?: string } | undefined = rolloutThread,
): string | undefined {
  const threads = files
    .filter((path) => /\/sessions\/.*\/rollout-[^/]+\.jsonl$/.test(path))
    .flatMap((path) => read(path) ?? []);
  const roots = threads.filter((thread) => thread.parent === undefined);
  return roots.length === 1 ? roots[0]?.id : undefined;
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

/**
 * A list refresh only asks a service that is running, since its recorded address outlives it. A terminal
 * started outside kiln names no session in argv and stays unknown.
 */
async function readOpencode() {
  const found = (await pidsNamed("opencode")).map((pid) => ({ pid, args: processArgs(pid) ?? [] }));
  const processes = found
    .flatMap(({ pid, args }) => {
      const invocation = opencodeInvocation(args);
      const cwd = processCwd(pid);
      if (!invocation || invocation.headless || !cwd || !hasTerminal(pid) || isDaemon(pid)) return [];
      return [{ pid, agent: "opencode" as const, cwd, startedAt: startedAt(pid), ...invocation }];
    })
    .map(stamped);
  // `opencode run` has no terminal. Its process is what carries the parent agent when kiln did not start it.
  const headless = found.flatMap(({ pid, args }) => {
    const invocation = opencodeInvocation(args);
    const cwd = processCwd(pid);
    if (!invocation?.headless || !cwd || isDaemon(pid)) return [];
    return [{ pid, id: invocation.id, cwd, startedAt: startedAt(pid) }];
  });
  const running = found.some(({ args }) => isOpencodeService(args));
  // Every conversation a live process names in argv, even when the capped list leaves it out.
  const held = [
    ...new Set([
      ...processes.flatMap((process) => (process.shared && process.id ? [process.id] : [])),
      ...headless.flatMap((run) => (run.id ? [run.id] : [])),
    ]),
  ];
  const listing = running ? await opencodeSessions(held) : { sessions: [], live: false };
  // Only the sessions the list shows: a terminal's own, ones a run names, and ones the service is running.
  const shown = new Set(held);
  const workdirs = new Map<string, string>();
  await Promise.all(
    listing.sessions
      .filter((session) => session.running || shown.has(session.id))
      .map(async (session) => {
        const workdir = await opencodeWorkdir(session);
        if (workdir) workdirs.set(session.id, workdir);
      }),
  );
  return withOpencodeSessions(
    processes,
    listing,
    workdirs,
    matchHeadlessProcesses(headless, listing.sessions),
    headless,
  );
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

/**
 * The thread a Codex process works in, from the writer lock it holds for that thread while it runs. Older Codex TUIs
 * hold a local thread lock; they must not borrow a daemon thread's status.
 */
export function codexThreadId(pid: number): string | undefined {
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

/** A terminal pairs by the id in its argv only; a private server's sessions are not the shared service's. */
export function withOpencodeSessions(
  processes: (AgentProcess & { shared: boolean })[],
  { sessions }: OpencodeListing,
  workdirs: ReadonlyMap<string, string> = new Map(),
  headlessPids: ReadonlyMap<string, number> = new Map(),
  runs: readonly HeadlessProcess[] = [],
): { processes: AgentProcess[]; headless: Session[] } {
  const paired = new Set<string>();
  const located = processes.map(({ shared, ...process }) => {
    if (!shared || !process.id) return process;
    paired.add(process.id);
    const session = sessions.find((session) => session.id === process.id);
    return {
      ...process,
      title: session?.title,
      cwd: session?.cwd ?? process.cwd,
      workdir: workdirs.get(process.id),
      // A session with no prompt yet is not stored, so what it is doing is unknown rather than idle.
      activity: session?.activity,
      question: session?.question,
      lastActiveAt: session?.updatedAt,
      parentSessionId: session?.parentId,
      opencodeService: session !== undefined,
    };
  });
  // Stopped sessions are history, but one running after its terminal left, or a headless run, can be attached to.
  // A run carries the PID that connects it to the agent whose shell started it.
  const headless = sessions
    .filter((session) => !paired.has(session.id))
    .map((session) => ({
      agent: "opencode" as const,
      id: session.id,
      pid: headlessPids.get(session.id),
      parentSessionId: session.parentId,
      title: session.title,
      cwd: session.cwd,
      workdir: workdirs.get(session.id),
      startedAt: session.createdAt,
      lastActiveAt: session.updatedAt,
      activity: session.activity,
      question: session.question,
      opencodeService: true,
      branch: gitBranch(workdirs.get(session.id) ?? session.cwd),
      place: {
        kind: "thread" as const,
        id: session.id,
        attach: ["opencode", "--session", session.id],
      },
    }));
  // A run names its conversation in argv even when the service's page leaves it out or no service is running.
  // Its process, directory and start are exact; what it is doing is not known, so the row carries no activity.
  const known = new Set([
    ...processes.flatMap((process) => (process.id ? [process.id] : [])),
    ...sessions.map((session) => session.id),
  ]);
  const orphaned = new Map<string, HeadlessProcess>();
  for (const run of runs) {
    if (!run.id || known.has(run.id)) continue;
    known.add(run.id);
    orphaned.set(run.id, run);
  }
  return {
    processes: located,
    headless: [
      ...headless,
      ...[...orphaned.values()].map((run) => {
        const id = run.id as string;
        return {
          agent: "opencode" as const,
          id,
          pid: run.pid,
          cwd: run.cwd,
          startedAt: run.startedAt,
          branch: gitBranch(run.cwd),
          place: {
            kind: "thread" as const,
            id,
            attach: ["opencode", "--session", id],
          },
        };
      }),
    ],
  };
}

/**
 * A process with its start read as soon as its provider lists it, before the other providers answer, so a pid the
 * kernel hands to another process meanwhile is not taken for it.
 */
function stamped<Process extends { pid: number }>(process: Process): Process & { processStart?: number } {
  return { ...process, processStart: processStartTicks(process.pid) };
}

/**
 * `kitty: false` skips the window lookup, for callers that only count sessions. A state file that cannot be used costs
 * only the stopped rows, and says why in `problem`.
 */
export async function listNativeSessions({
  kitty = true,
} = {}): Promise<{ sessions: Session[]; problem: string; missing?: Missing }> {
  const readCodex = async () => {
    const processes = (await codexProcesses()).map(stamped).map((process) => ({
      ...process,
      threadId: codexThreadId(process.pid),
    }));
    const threads = await codexThreads(processes.flatMap((process) => (process.threadId ? [process.threadId] : [])));
    return withCodexThreads(processes, threads);
  };
  const ownedPanes = panes();
  const [claude, owned, windows, codex, codexExec, pi, opencode, muse, agy] = await Promise.all([
    claudeSessions(ownedPanes),
    ownedPanes,
    kitty ? kittyWindows() : [],
    readCodex(),
    codexExecProcesses().then((processes) => processes.map(stamped)),
    piProcesses().then((processes) => processes.map(stamped)),
    readOpencode(),
    museProcesses().then((processes) => processes.map(stamped)),
    agyProcesses().then((processes) => processes.map(stamped)),
  ]);
  const running = [
    ...claude.processes,
    ...codex.processes,
    ...codexExec,
    ...opencode.processes,
    ...pi,
    ...muse,
    ...agy,
  ];
  const headless = [...codex.headless, ...opencode.headless, ...claude.finished];

  const places = new Map<number, Place>();
  for (const window of windows) {
    for (const pid of window.pids) places.set(pid, { kind: "kitty", socket: window.socket, windowId: window.id });
  }
  // A kiln pane wins over a kitty window: the window only holds the tmux client, never the agent.
  for (const pane of owned) places.set(pane.pid, { kind: "kiln", name: pane.name });

  const runningPids = new Set([
    ...running.map((process) => process.pid),
    ...headless.flatMap((session) => (session.pid === undefined ? [] : [session.pid])),
  ]);
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
      branch: gitBranch(process.workdir ?? process.cwd),
      place,
    };
  });
  const sessions = deduplicateSessions(
    located.map(({ ancestorSessionPid, ...session }) => ({
      ...session,
      parentSessionPid: ancestorSessionPid,
    })),
  );
  // A headless process keeps the ancestry of the agent whose Bash call started it, when kiln did not start it.
  const nested = headless.map((session) => {
    if (session.pid === undefined) return session;
    const lineage: number[] = [];
    for (let pid: number | undefined = session.pid; pid; pid = parentPid(pid)) lineage.push(pid);
    const { ancestorSessionPid } = sessionLocation(lineage, places, runningPids);
    if (ancestorSessionPid !== undefined) return { ...session, parentSessionPid: ancestorSessionPid };
    // A run started with `nohup ... &` outlives the shell that started it, so its ancestry ends at init. It still
    // carries the session id its agent gives every command it runs.
    const inherited = environParent(session.pid);
    return inherited && inherited !== sessionIdentity(session) ? { ...session, spawnParent: inherited } : session;
  });
  // A stopped process does nothing until it is continued, so what its agent last reported is not what it is doing.
  const listed = [...sessions, ...nested].map((session) =>
    session.pid !== undefined && processStopped(session.pid)
      ? { ...session, paused: true, activity: undefined, turnEnded: undefined }
      : session,
  );
  let stopped: Session[] = [];
  let problem = "";
  try {
    stopped = restartStopped(listed);
  } catch (error) {
    problem = `Stopped sessions unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const found = withAccounts(attachParents([...listed, ...stopped]));
  rememberParents(found);
  const missing = claude.kept ? { reason: "claude agents failed or timed out", agent: "claude" as const } : undefined;
  return { sessions: await closeFinishedChildren(found), problem, missing };
}

/** Name the account each running session was started on, read from its process's environment. */
function withAccounts(sessions: Session[]): Session[] {
  let accounts: ReturnType<typeof loadSettings>["accounts"];
  try {
    accounts = loadSettings().accounts;
  } catch {
    // A settings file that does not load is reported by the list itself; sessions just show no account.
    return sessions;
  }
  return sessions.map((session) => {
    if (session.pid === undefined) return session;
    try {
      const environment = Object.fromEntries(
        readFileSync(`/proc/${session.pid}/environ`, "utf8")
          .split("\0")
          .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
      );
      const account = accountOf(session.agent, environment, accounts);
      return account ? { ...session, account } : session;
    } catch {
      // The process is gone or not ours to read: no account to show.
      return session;
    }
  });
}

/**
 * An OpenCode sub-session is done once no run process holds it and its last turn ended without needing anyone.
 * One that failed or asks something reports `waiting` and stays.
 */
export function finishedOpencodeChildren(sessions: readonly Session[]): Session[] {
  return sessions.filter(
    (session) =>
      session.agent === "opencode" &&
      session.place.kind === "thread" &&
      session.pid === undefined &&
      session.activity === "idle" &&
      (session.spawnParent !== undefined || session.parentSessionId !== undefined),
  );
}

/** Archive finished sub-sessions so they leave the list; one whose archive fails stays listed. */
async function closeFinishedChildren(sessions: Session[]): Promise<Session[]> {
  const done = new Set(finishedOpencodeChildren(sessions));
  await Promise.all(
    [...done].map(async (session) => {
      if (session.place.kind !== "thread") return;
      try {
        await archiveOpencodeSession(session.place.id);
      } catch {
        done.delete(session);
      }
    }),
  );
  return sessions.filter((session) => !done.has(session));
}

/** The agent session a process was started from, by the session variable it inherited; none when unclear. */
export function environParent(pid: number, read = (path: string) => readFileSync(path, "utf8")): string | undefined {
  try {
    const environment = Object.fromEntries(
      read(`/proc/${pid}/environ`)
        .split("\0")
        .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
    );
    // With no nearest agent, only an unambiguous single session variable names the parent.
    return callerIdentity(environment, null);
  } catch {
    return undefined;
  }
}

/** Keep one client per confirmed daemon conversation, preferring a terminal kiln can open. */
export function deduplicateSessions(sessions: readonly Session[]): Session[] {
  const result: Session[] = [];
  const indices = new Map<string, number>();
  for (const session of sessions) {
    if ((session.agent !== "codex" && session.agent !== "opencode") || session.id === undefined) {
      result.push(session);
      continue;
    }
    const index = indices.get(`${session.agent}:${session.id}`);
    if (index === undefined) {
      indices.set(`${session.agent}:${session.id}`, result.length);
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
