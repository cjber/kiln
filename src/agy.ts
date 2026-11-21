import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Activity, Place, Session } from "./sessions";

/** An Antigravity CLI process before kiln knows where its terminal lives, in the shape native discovery consumes. */
export type AgyProcess = Omit<Session, "place" | "branch"> & { pid: number; background?: Place };

/** Conversation ids are UUIDs; anything else never names a database file. */
export function isAgyConversationId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Where `agy` keeps its conversation databases, its summaries and its presence locks. */
export function agyHome(env: Record<string, string | undefined> = Bun.env): string {
  return join(env.HOME || homedir(), ".gemini", "antigravity-cli");
}

/** Subcommands of `agy`; a first positional word naming one is not a conversation. */
const subcommands = new Set(
  "acp agent agents changelog help install mcp mic-serve models plugin plugins remote-control update".split(" "),
);

/** Options that take their value as the next argument, from `agy --help`. */
const valueOptions = new Set(
  "--add-dir --agent --conversation --effort --input-format --json-schema --log-file --mode --model --output-format --print-timeout --project --remote-agent --settings".split(
    " ",
  ),
);

export type AgyInvocation = { kind: "interactive"; conversationId?: string } | { kind: "exec" } | { kind: "other" };

/** What an `agy` process is running, decided on argv: print mode is a headless run, a subcommand is not a session. */
export function classifyAgy(args: readonly string[]): AgyInvocation {
  if (basename(args[0] ?? "") !== "agy") return { kind: "other" };
  let conversationId: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "-p" || arg === "--print" || arg === "--prompt" || /^--(print|prompt)=/.test(arg))
      return { kind: "exec" };
    if (arg === "-i" || arg === "--prompt-interactive") {
      index++;
      continue;
    }
    if (arg === "--conversation") {
      const value = args[index + 1];
      if (value && isAgyConversationId(value)) conversationId = value;
      index++;
      continue;
    }
    if (arg.startsWith("--conversation=")) {
      const value = arg.slice("--conversation=".length);
      if (isAgyConversationId(value)) conversationId = value;
      continue;
    }
    if (!arg.startsWith("-")) return subcommands.has(arg) ? { kind: "other" } : { kind: "interactive", conversationId };
    if (valueOptions.has(arg)) index++;
  }
  return { kind: "interactive", conversationId };
}

/** What a conversation's summary row says; `agy` writes one per conversation as soon as it has a first prompt. */
export type AgySummary = { title?: string; activity?: Activity; parentId?: string; lastActiveAt?: number };

/** A summary's `last_modified_time` (`2026-11-19 23:12:50.934965780+00:00`) in milliseconds; undefined when it does not parse. */
export function agyTime(text: string): number | undefined {
  const ms = Date.parse(text.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1"));
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Fields read from `conversation_summaries.raw_summary`, a serialized `CascadeTrajectorySummary` protobuf:
 * field 8 is repeated `waiting_steps` (length-delimited), field 18 is `has_active_children` (varint bool).
 */
export function agyRawSummaryFlags(raw: Uint8Array | null | undefined): {
  hasWaitingSteps: boolean;
  hasActiveChildren: boolean;
} {
  const empty = { hasWaitingSteps: false, hasActiveChildren: false };
  if (!raw?.length) return empty;
  let hasWaitingSteps = false;
  let hasActiveChildren = false;
  let offset = 0;
  const readVarint = (): bigint | undefined => {
    let value = 0n;
    let shift = 0n;
    while (offset < raw.length) {
      const byte = raw[offset++] as number;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
      if (shift > 63n) return undefined;
    }
    return undefined;
  };
  while (offset < raw.length) {
    const tag = readVarint();
    if (tag === undefined || tag === 0n) return empty;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    switch (wire) {
      case 0: {
        const value = readVarint();
        if (value === undefined) return empty;
        if (field === 18 && value !== 0n) hasActiveChildren = true;
        break;
      }
      case 1:
        if (offset + 8 > raw.length) return empty;
        offset += 8;
        break;
      case 2: {
        const length = readVarint();
        if (length === undefined || length > BigInt(raw.length - offset)) return empty;
        const bytes = Number(length);
        if (field === 8 && bytes > 0) hasWaitingSteps = true;
        offset += bytes;
        break;
      }
      case 5:
        if (offset + 4 > raw.length) return empty;
        offset += 4;
        break;
      default:
        return empty;
    }
  }
  return { hasWaitingSteps, hasActiveChildren };
}

/**
 * The activity a summary row reports. `agy` keeps `status` as RUNNING or BUSY while a step waits on the user for
 * approval or input, and lists those steps in `raw_summary`'s `waiting_steps`. Following agy's own notifier, waiting
 * steps count only while active (`RUNNING`, `BUSY`, or `IDLE` with active children), never while canceling or fully
 * idle; unknown statuses stay unknown.
 */
export function agyActivity(status: string, waiting = false, hasActiveChildren = false): Activity | undefined {
  switch (status) {
    case "CASCADE_RUN_STATUS_IDLE":
      return waiting && hasActiveChildren ? "waiting" : "idle";
    case "CASCADE_RUN_STATUS_RUNNING":
    case "CASCADE_RUN_STATUS_BUSY":
      return waiting ? "waiting" : "working";
    case "CASCADE_RUN_STATUS_CANCELING":
      return "working";
    default:
      return undefined;
  }
}

/** The summary rows of `ids` from `agy`'s own database, opened read-only; unreadable means none are known. */
export function readAgySummaries(ids: readonly string[], home = agyHome()): Map<string, AgySummary> {
  const found = new Map<string, AgySummary>();
  if (!ids.length) return found;
  let database: Database | undefined;
  try {
    database = new Database(join(home, "conversation_summaries.db"), { readonly: true });
    const columns = database.query("pragma table_info(conversation_summaries)").all() as { name: string }[];
    const hasRawSummary = columns.some((column) => column.name === "raw_summary");
    const select = hasRawSummary
      ? "conversation_id, title, status, parent_conversation_id, last_modified_time, raw_summary"
      : "conversation_id, title, status, parent_conversation_id, last_modified_time";
    const rows = database
      .query(`select ${select} from conversation_summaries where conversation_id in (${ids.map(() => "?").join(",")})`)
      .all(...ids) as {
      conversation_id: string;
      title: string;
      status: string;
      parent_conversation_id: string;
      last_modified_time: string;
      raw_summary?: Uint8Array | null;
    }[];
    const parentsWithChildren: string[] = [];
    for (const row of rows) {
      const flags = hasRawSummary ? agyRawSummaryFlags(row.raw_summary) : undefined;
      const activity = agyActivity(row.status, flags?.hasWaitingSteps, flags?.hasActiveChildren);
      found.set(row.conversation_id, {
        title: row.title || undefined,
        activity,
        parentId: isAgyConversationId(row.parent_conversation_id) ? row.parent_conversation_id : undefined,
        lastActiveAt: agyTime(row.last_modified_time),
      });
      if (flags?.hasActiveChildren && activity !== "waiting") parentsWithChildren.push(row.conversation_id);
    }
    if (hasRawSummary && parentsWithChildren.length) {
      const requested = new Set(ids);
      const children = database
        .query(
          `select conversation_id, parent_conversation_id, status, raw_summary from conversation_summaries where parent_conversation_id in (${parentsWithChildren.map(() => "?").join(",")}) and status in ('CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY')`,
        )
        .all(...parentsWithChildren) as {
        conversation_id: string;
        parent_conversation_id: string;
        status: string;
        raw_summary: Uint8Array | null;
      }[];
      for (const child of children) {
        if (requested.has(child.conversation_id)) continue;
        const flags = agyRawSummaryFlags(child.raw_summary);
        if (agyActivity(child.status, flags.hasWaitingSteps, flags.hasActiveChildren) === "waiting") {
          const parent = found.get(child.parent_conversation_id);
          if (parent) parent.activity = "waiting";
        }
      }
    }
  } catch {
    // A database that is locked or missing leaves the rows as unknown; the next pass reads it again.
  } finally {
    database?.close();
  }
  return found;
}

export type AgyCandidate = {
  pid: number;
  args: readonly string[];
  cwd: string;
  startedAt: number;
  /** Whether stdin is a terminal; an interactive `agy` without one is a helper, not a session. */
  terminal: boolean;
  /** The conversation database this process holds open, which names its conversation. */
  openId?: string;
};

/**
 * Session rows from `agy` process candidates. A headless `-p` run is working while its process runs and leaves when it
 * exits, like `codex exec`. An interactive session reports its status through its summary row; one with no first prompt
 * yet has no conversation, so it is named by its process until it has.
 */
export function buildAgyProcesses(
  candidates: readonly AgyCandidate[],
  summaries: ReadonlyMap<string, AgySummary>,
): AgyProcess[] {
  return candidates.flatMap((candidate) => {
    const invocation = classifyAgy(candidate.args);
    if (invocation.kind === "other") return [];
    if (invocation.kind === "interactive" && !candidate.terminal) return [];
    const id = candidate.openId ?? (invocation.kind === "interactive" ? invocation.conversationId : undefined);
    const summary = id ? summaries.get(id) : undefined;
    const base = {
      pid: candidate.pid,
      agent: "agy" as const,
      id,
      title: summary?.title,
      lastActiveAt: summary?.lastActiveAt,
      cwd: candidate.cwd,
      startedAt: candidate.startedAt,
      parentSessionId: summary?.parentId,
      parentSessionAgent: summary?.parentId ? ("agy" as const) : undefined,
    };
    return [
      invocation.kind === "exec"
        ? { ...base, activity: "working" as const, agyExec: true }
        : { ...base, activity: summary?.activity },
    ];
  });
}

function processArgs(pid: number): string[] | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

function hasTerminal(pid: number): boolean {
  try {
    return /^\/dev\/(pts\/|tty)/.test(readlinkSync(`/proc/${pid}/fd/0`));
  } catch {
    return false;
  }
}

/** The conversation id in the path of the database a process holds open: the process's own conversation. */
function openConversationId(pid: number): string | undefined {
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const match = /\/antigravity-cli\/conversations\/([0-9a-f-]{36})\.db(?:-wal|-shm)?$/i.exec(
          readlinkSync(`/proc/${pid}/fd/${fd}`),
        );
        if (match?.[1] && isAgyConversationId(match[1])) return match[1];
      } catch {
        // File descriptors can close during discovery.
      }
    }
  } catch {
    // The process may have exited.
  }
  return undefined;
}

/** The conversation a running `agy` holds open, for a spawn that cannot choose its id. */
export function agyConversationId(pid: number): string | undefined {
  return openConversationId(pid);
}

/** Process ids named exactly `agy`, from `pgrep`. */
async function agyPids(): Promise<number[]> {
  const listed = Bun.spawn(["pgrep", "-x", "agy"], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => listed.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(listed.stdout).text(), listed.exited]);
  clearTimeout(timeout);
  return code === 0 ? source.split("\n").filter(Boolean).map(Number) : [];
}

/** Every Antigravity CLI session this machine is running, found by process. */
export async function agyProcesses(): Promise<AgyProcess[]> {
  const candidates: AgyCandidate[] = [];
  for (const pid of await agyPids()) {
    const args = processArgs(pid);
    if (!args || classifyAgy(args).kind === "other") continue;
    let cwd: string;
    let startedAt: number;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
      startedAt = statSync(`/proc/${pid}`).mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ pid, args, cwd, startedAt, terminal: hasTerminal(pid), openId: openConversationId(pid) });
  }
  if (!candidates.length) return [];
  const ids = candidates.flatMap((candidate) => {
    const id = candidate.openId ?? (classifyAgy(candidate.args) as { conversationId?: string }).conversationId;
    return id ? [id] : [];
  });
  return buildAgyProcesses(candidates, readAgySummaries(ids));
}
