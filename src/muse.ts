import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Place, Session } from "./sessions";

/** A Muse process before kiln knows where its terminal lives, in the shape native discovery consumes. */
export type MuseProcess = Omit<Session, "place" | "branch"> & { pid: number; background?: Place };

/** Muse session ids are UUIDs; anything else never names a registry file or a log directory. */
export function isMuseSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Where Muse keeps its session logs and its live-session registry, under the data home. */
export function museDataHome(env: Record<string, string | undefined> = Bun.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "muse");
}

type Registry = { id: string; name?: string; pid?: number; messageCapable: boolean };

/** One live-session registry record, validated: the file name, the recorded id and the pid hint must agree in shape. */
export function parseRegistry(source: string, fileId: string): Registry | undefined {
  if (!isMuseSessionId(fileId)) return undefined;
  try {
    const record = JSON.parse(source) as Record<string, unknown>;
    if (record.session_id !== fileId) return undefined;
    const hint = typeof record.process_generation_hint === "string" ? record.process_generation_hint : "";
    const pid = /^pid=(\d+)$/.exec(hint)?.[1];
    return {
      id: fileId,
      name: typeof record.session_name === "string" && record.session_name ? record.session_name : undefined,
      pid: pid ? Number(pid) : undefined,
      messageCapable: record.target_eligibility === "message_capable",
    };
  } catch {
    return undefined;
  }
}

/** Live sessions by the pid their registry records, read from `directory`; unreadable records are skipped. */
export function registryByPid(directory: string): Map<number, Registry> {
  const byPid = new Map<number, Registry>();
  try {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const record = parseRegistry(readFileSync(join(directory, entry), "utf8"), entry.slice(0, -5));
        if (record?.pid !== undefined) byPid.set(record.pid, record);
      } catch {
        // A registry file can vanish while the directory is read.
      }
    }
  } catch {
    // No registry directory means no live Muse sessions have registered.
  }
  return byPid;
}

export type ListedMuse = { name?: string; sideOf?: string };

/** The running sessions `muse sessions --json` reports, by id; malformed output lists none. */
export function parseListed(source: string): Map<string, ListedMuse> {
  const listed = new Map<string, ListedMuse>();
  try {
    const parsed = JSON.parse(source) as { sessions?: unknown };
    if (!Array.isArray(parsed.sessions)) return listed;
    for (const item of parsed.sessions as Record<string, unknown>[]) {
      if (typeof item?.sessionId !== "string" || !isMuseSessionId(item.sessionId)) continue;
      listed.set(item.sessionId, {
        name: typeof item.name === "string" && item.name ? item.name : undefined,
        sideOf: typeof item.sideOf === "string" && isMuseSessionId(item.sideOf) ? item.sideOf : undefined,
      });
    }
  } catch {
    // Output cut short by the timeout is a failed listing.
  }
  return listed;
}

/** Whether an argv word names the Muse binary, as installed (`muse`) or as its versioned payload (`muse-bin-*`). */
export function isMuseWord(word: string): boolean {
  const name = basename(word);
  return name === "muse" || name.startsWith("muse-bin-");
}

/**
 * Where `resume` or `exec` goes in a configured command: directly after the muse word, after any wrapper,
 * because Muse reads root options before a subcommand as belonging to the interactive run and an
 * `exec` behind them never starts. Falls back to after the first word, as Codex does.
 */
export function afterMuseWord(command: readonly string[]): number {
  return command.findIndex((word) => isMuseWord(word)) + 1 || 1;
}

const subcommands = new Set(
  "resume exec config export trace model-profile skills voice plugins sandbox schema serve mxp attach acp session-message sessions mcp auth login logout usage init".split(
    " ",
  ),
);

/** Muse's root options that take their value as the next argument, from `muse --help`. */
const valueOptions = new Set(
  "--agents --provider --preset --model --contributor-mode -c --config --reasoning-effort --effort --base-url --image --workspace --worktree-base --worktree-existing --permission-profile --approval-mode --approval-judge --echo-delay-ms --sandbox-network".split(
    " ",
  ),
);

export type MuseInvocation = { kind: "interactive" } | { kind: "exec"; sessionId?: string } | { kind: "other" };

/** What a Muse process is running, decided on argv: the first positional word names a subcommand or is a prompt. */
export function classifyMuse(args: readonly string[]): MuseInvocation {
  if (!isMuseWord(args[0] ?? "")) return { kind: "other" };
  let word: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--") break;
    if (!arg.startsWith("-")) {
      word = arg;
      break;
    }
    if (valueOptions.has(arg)) index++;
  }
  if (word === "exec") {
    const at = args.indexOf("--session-id");
    const sessionId = at === -1 ? undefined : args[at + 1];
    return { kind: "exec", sessionId: sessionId && isMuseSessionId(sessionId) ? sessionId : undefined };
  }
  if (word === "resume") return { kind: "interactive" };
  return word !== undefined && subcommands.has(word) ? { kind: "other" } : { kind: "interactive" };
}

export type MuseCandidate = {
  pid: number;
  args: readonly string[];
  cwd: string;
  startedAt: number;
  /** Whether stdin is a terminal; an interactive Muse without one is a helper, not a session. */
  terminal: boolean;
  /** The session log this process holds open, which outranks the registry when the two disagree. */
  logId?: string;
};

/**
 * Session rows from Muse process candidates. An `exec` run is working while its process runs and leaves
 * when it exits, like `codex exec`. An interactive session publishes no status, so its activity stays
 * unknown. A candidate with no session id from its argv, its open log or the registry cannot be named,
 * messaged or resumed, so it is not listed.
 */
export function buildMuseProcesses(
  candidates: readonly MuseCandidate[],
  registry: ReadonlyMap<number, Registry>,
  listed: ReadonlyMap<string, ListedMuse> | undefined,
): MuseProcess[] {
  return candidates.flatMap((candidate) => {
    const invocation = classifyMuse(candidate.args);
    if (invocation.kind === "other") return [];
    if (invocation.kind === "interactive" && !candidate.terminal) return [];
    const recorded = registry.get(candidate.pid);
    // A registry record alone never names a process: its pid can belong to a newer session by now, so a
    // registry id counts only when the live listing names that same session. The open log is the process's own.
    const id =
      invocation.kind === "exec"
        ? (invocation.sessionId ?? candidate.logId)
        : (candidate.logId ?? (recorded && listed?.has(recorded.id) ? recorded.id : undefined));
    if (!id) return [];
    const live = listed?.get(id);
    const base = {
      pid: candidate.pid,
      agent: "muse" as const,
      id,
      title: live?.name ?? recorded?.name,
      cwd: candidate.cwd,
      startedAt: candidate.startedAt,
      parentSessionId: live?.sideOf,
      parentSessionAgent: live?.sideOf ? ("muse" as const) : undefined,
    };
    return [invocation.kind === "exec" ? { ...base, activity: "working" as const, museExec: true } : base];
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

/** The session id in the path of a session log a process holds open, if it holds one. */
function openLogId(pid: number): string | undefined {
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const match = /\/muse\/sessions\/\d{4}\/\d{2}\/\d{2}\/([0-9a-f-]{36})\/session\.jsonl$/i.exec(
          readlinkSync(`/proc/${pid}/fd/${fd}`),
        );
        if (match?.[1] && isMuseSessionId(match[1])) return match[1];
      } catch {
        // File descriptors can close during discovery.
      }
    }
  } catch {
    // The process may have exited.
  }
  return undefined;
}

/** The live listing, or undefined when it could not be read: registry identity is then uncorroborated. */
async function listedSessions(): Promise<Map<string, ListedMuse> | undefined> {
  if (!Bun.which("muse")) return undefined;
  const process = Bun.spawn(["muse", "sessions", "--json"], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => process.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  clearTimeout(timeout);
  return code === 0 ? parseListed(source) : undefined;
}

/** Process ids whose name mentions muse, from `pgrep`; the versioned binary never matches an exact name. */
async function musePids(): Promise<number[]> {
  const listed = Bun.spawn(["pgrep", "muse"], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => listed.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(listed.stdout).text(), listed.exited]);
  clearTimeout(timeout);
  return code === 0 ? source.split("\n").filter(Boolean).map(Number) : [];
}

/** Every Muse session this machine is running, found by process; `muse sessions` only names the interactive ones. */
export async function museProcesses(): Promise<MuseProcess[]> {
  const candidates: MuseCandidate[] = [];
  for (const pid of await musePids()) {
    const args = processArgs(pid);
    if (!args || !isMuseWord(args[0] ?? "") || classifyMuse(args).kind === "other") continue;
    let cwd: string | undefined;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    let startedAt = 0;
    try {
      startedAt = statSync(`/proc/${pid}`).mtimeMs;
    } catch {
      continue;
    }
    candidates.push({ pid, args, cwd, startedAt, terminal: hasTerminal(pid), logId: openLogId(pid) });
  }
  if (!candidates.length) return [];
  const registry = registryByPid(join(museDataHome(), "runtime", "muse", "sessions"));
  return buildMuseProcesses(candidates, registry, await listedSessions());
}

/** A message Muse refused before delivering anything, so the message can simply wait. */
export class MuseNotReady extends Error {}

/**
 * Deliver a message to a live Muse session through its own session messaging. Bounded, because a hung
 * helper must not hold up mailbox flushing: a timeout refuses the delivery and the message waits.
 * A session whose registry record says it cannot take messages is refused the same way.
 */
export async function messageMuseSession(id: string, text: string, timeoutMs = 15_000): Promise<void> {
  if (!isMuseSessionId(id)) throw new MuseNotReady("the Muse session id is not one Muse accepts");
  try {
    const record = parseRegistry(
      readFileSync(join(museDataHome(), "runtime", "muse", "sessions", `${id}.json`), "utf8"),
      id,
    );
    if (record && !record.messageCapable) throw new MuseNotReady("this Muse session cannot take messages");
  } catch (error) {
    if (error instanceof MuseNotReady) throw error;
    // No readable registry record: the send itself is the check.
  }
  const child = Bun.spawn(["muse", "session-message", "send", "--target", id, "--json"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    child.stdin.write(text);
    child.stdin.end();
    const [problem, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new MuseNotReady(problem.trim().split("\n")[0] || "Muse refused the message");
  } finally {
    clearTimeout(timer);
  }
}
