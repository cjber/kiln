import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Activity } from "./sessions";
import { checkout, toolPath } from "./workdir";

/** A conversation held by OpenCode's background service, which outlives the terminals attached to it. */
export type OpencodeSession = {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  activity?: Activity;
  /** The service holds a turn for it; a stopped one, even one that failed, is history. */
  running: boolean;
  title?: string;
  parentId?: string;
};

/** `live` says the service answered, so a session missing from `sessions` is known to be inactive. */
export type OpencodeListing = { sessions: OpencodeSession[]; live: boolean };

type Info = {
  id: string;
  parentID?: string;
  title?: string;
  outcome?: string;
  time: { created: number; updated: number; archived?: number };
  location: { directory: string };
};

type Active = { type?: string };

const timeoutMs = 2_000;
const listLimit = 100;

/** The commands that do something other than open a terminal session; `mini` is a smaller TUI. */
const headlessCommands = new Set([
  "acp",
  "api",
  "auth",
  "debug",
  "mcp",
  "models",
  "pair",
  "plugin",
  "reload",
  "run",
  "serve",
  "service",
  "session",
  "stats",
  "uninstall",
  "update",
  "upgrade",
]);
const flagsWithValues = new Set(["--session", "-s", "--prompt", "--server", "--log-level"]);

/**
 * Decided on argv, so a directory or prompt named after a subcommand is still one argument. A tab
 * opened inside the TUI leaves argv naming the tab it started with, so only that tab is a terminal's
 * own conversation; the service lists the rest on their own. `run` is a headless conversation, not a
 * terminal, and is matched to its process rather than opened.
 */
export type OpencodeInvocation = { id?: string; shared: boolean; headless?: boolean };

export function opencodeInvocation(args: readonly string[]): OpencodeInvocation | undefined {
  let id: string | undefined;
  let shared = true;
  let command: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index] ?? "";
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg];
    if (flag === "--standalone" || flag === "--server") shared = false;
    if (flag === "--session" || flag === "-s") id = inline ?? args[index + 1];
    if (flagsWithValues.has(flag ?? "") && inline === undefined) index++;
    else if (!arg.startsWith("-")) command ??= arg;
  }
  const valid = id && /^ses_[A-Za-z0-9]+$/.test(id) ? id : undefined;
  if (command && headlessCommands.has(command))
    return command === "run" ? { id: valid, shared, headless: true } : undefined;
  return { id: valid, shared };
}

export function isOpencodeService(args: readonly string[]): boolean {
  return args[1] === "serve" && args.includes("--service");
}

/** `opencode --session` creates the id it is given, which is how a terminal's conversation is known from its argv. */
export function newOpencodeSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

/** A live `opencode run` process and the arguments that identify the conversation it is running. */
export type HeadlessProcess = { pid: number; id?: string; cwd: string; startedAt: number };

/** How far apart a run process and the session it created may start and still be the same conversation. */
const headlessMatchMs = 10 * 60_000;

/**
 * Match each headless conversation to its `opencode run` process: by the `--session` id in argv, else by
 * the nearest process start in the same directory. The process is what carries the run's parent agent.
 */
export function matchHeadlessProcesses(
  processes: readonly HeadlessProcess[],
  sessions: readonly Pick<OpencodeSession, "id" | "cwd" | "createdAt">[],
): Map<string, number> {
  const matched = new Map<string, number>();
  const used = new Set<number>();
  for (const session of sessions) {
    const exact = processes.find((process) => !used.has(process.pid) && process.id === session.id);
    if (!exact) continue;
    matched.set(session.id, exact.pid);
    used.add(exact.pid);
  }
  for (const session of sessions) {
    if (matched.has(session.id)) continue;
    let best: HeadlessProcess | undefined;
    let closest = Number.POSITIVE_INFINITY;
    for (const process of processes) {
      if (used.has(process.pid) || process.cwd !== session.cwd) continue;
      const gap = Math.abs(process.startedAt - session.createdAt);
      if (gap <= headlessMatchMs && gap < closest) {
        best = process;
        closest = gap;
      }
    }
    if (!best) continue;
    matched.set(session.id, best.pid);
    used.add(best.pid);
  }
  return matched;
}

/** The service's own states, grouped; anything newer than this list shows as unknown rather than guessed. */
export function opencodeActivity(active: Active | undefined, pending: boolean, outcome?: string): Activity | undefined {
  if (pending) return "waiting";
  if (active) {
    switch (active.type) {
      case "running":
        return "working";
      default:
        return undefined;
    }
  }
  switch (outcome) {
    // A run that failed has stopped and needs you, the same as one asking a question.
    case "failed":
      return "waiting";
    case "succeeded":
    case "interrupted":
    case undefined:
      return "idle";
    default:
      return undefined;
  }
}

/** The read routes kiln polls, from the service's OpenAPI document. */
const routes = {
  "session.active": "/api/session/active",
  "session.list": "/api/session",
  "session.permission.list": "/api/session/{sessionID}/permission",
  "session.form.list": "/api/session/{sessionID}/form",
  "session.message.list": "/api/session/{sessionID}/message",
} as const;

/**
 * Where the background service listens and its password, as it records them for `opencode api`.
 * Only a loopback address is accepted, so the password never leaves this machine.
 */
export function opencodeService(
  path = join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json"),
): { url: string; authorization: string } {
  const { url, password } = JSON.parse(readFileSync(path, "utf8")) as { url?: unknown; password?: unknown };
  if (typeof url !== "string" || typeof password !== "string" || !password)
    throw new Error("the OpenCode service has not recorded its address");
  const origin = new URL(url);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    throw new Error("the OpenCode service is not on this machine");
  return { url: origin.origin, authorization: `Basic ${btoa(`opencode:${password}`)}` };
}

/**
 * One status read from the service. Starting `opencode api` for each cost about 0.15 s of CPU, and a refresh
 * makes two calls plus two per working session.
 */
async function get<T>(operation: keyof typeof routes, params: Record<string, string | number> = {}): Promise<T> {
  const route = routes[operation];
  const { url, authorization } = opencodeService();
  const query = new URLSearchParams();
  const path = route.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(params[name])));
  for (const [name, value] of Object.entries(params)) if (!route.includes(`{${name}}`)) query.set(name, String(value));
  const response = await fetch(`${url}${path}${query.size ? `?${query}` : ""}`, {
    headers: { Authorization: authorization },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const source = await response.text();
  if (!response.ok) throw new Error(source.split("\n")[0] || `the OpenCode service answered ${response.status}`);
  return JSON.parse(source) as T;
}

/** Writes go through the CLI, which starts the service when it is not running, so closing never loses one. */
async function cli(...args: string[]): Promise<void> {
  const child = Bun.spawn(["opencode", "api", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  const [source, problem, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (code) throw new Error(`${source}\n${problem}`.trim().split("\n")[0] || "the OpenCode service did not answer");
}

/** Asked directly, since the listing is capped; a service that cannot answer is treated as busy. */
export async function opencodeBusy(): Promise<boolean> {
  try {
    return Object.keys((await get<{ data: Record<string, Active> }>("session.active")).data).length > 0;
  } catch {
    return true;
  }
}

let last: OpencodeSession[] = [];

/** A run kiln did not start is history after this long idle; six hours covers a long subagent task. */
export const headlessIdleMs = 6 * 60 * 60 * 1_000;

/**
 * A conversation closed in OpenCode is history, but one that is still running is work with a bill:
 * hiding it leaves it spending where nobody can see or stop it, so a running one stays listed. A
 * finished one kiln did not start stays listed for six hours after its last update.
 */
export function opencodeShown(
  archived: number | undefined,
  running: boolean,
  updatedAt?: number,
  now = Date.now(),
): boolean {
  if (archived !== undefined) return running;
  return running || updatedAt === undefined || now - updatedAt < headlessIdleMs;
}

/** Prompts are read for active sessions only: a turn that stops to ask is still a running turn. */
async function read(): Promise<OpencodeSession[]> {
  const [active, listed] = await Promise.all([
    get<{ data: Record<string, Active> }>("session.active"),
    get<{ data: Info[] }>("session.list", { limit: listLimit }),
  ]);
  const waiting = new Set(
    (
      await Promise.all(
        Object.keys(active.data).map(async (id) => {
          const [permissions, forms] = await Promise.all([
            get<{ data: unknown[] }>("session.permission.list", { sessionID: id }),
            get<{ data: unknown[] }>("session.form.list", { sessionID: id }),
          ]);
          return permissions.data.length || forms.data.length ? [id] : [];
        }),
      )
    ).flat(),
  );
  return listed.data.flatMap((info) => {
    const running = info.id in active.data;
    if (!opencodeShown(info.time.archived, running, info.time.updated)) return [];
    return [
      {
        id: info.id,
        cwd: info.location.directory,
        createdAt: info.time.created,
        updatedAt: info.time.updated,
        activity: opencodeActivity(active.data[info.id], waiting.has(info.id), info.outcome),
        running,
        title: info.title,
        parentId: info.parentID,
      },
    ];
  });
}

/** A failed read keeps the last names with their status unknown. */
export async function opencodeSessions(): Promise<OpencodeListing> {
  try {
    last = await read();
    return { sessions: last, live: true };
  } catch {
    last = last.map(({ activity, ...session }) => session);
    return { sessions: last, live: false };
  }
}

type ToolPart = { type?: string; name?: string; state?: { input?: Record<string, unknown> } };
const workdirs = new Map<string, { updatedAt: number; at: number; workdir?: string }>();

/**
 * The checkout a session's latest edit or `cd` was in. It is read again only when the session has changed,
 * and at most every 30 s while it works, since a working session changes on every refresh.
 */
export async function opencodeWorkdir(session: OpencodeSession, now = Date.now()): Promise<string | undefined> {
  const saved = workdirs.get(session.id);
  if (saved && (saved.updatedAt === session.updatedAt || now - saved.at < 30_000)) return saved.workdir;
  let workdir = saved?.workdir;
  try {
    const messages = await get<{ data: { content?: ToolPart[] }[] }>("session.message.list", {
      sessionID: session.id,
      limit: 20,
    });
    for (const message of messages.data)
      for (const part of message.content ?? []) {
        const path = part.type === "tool" && part.name ? toolPath(part.name, part.state?.input ?? {}) : undefined;
        const found = path && checkout(path);
        if (found) workdir = found;
      }
  } catch {
    return workdir;
  }
  workdirs.set(session.id, { updatedAt: session.updatedAt, at: now, workdir });
  return workdir;
}

/** Stop any turn, then hide the conversation; a session that never took a prompt was never stored. */
export async function archiveOpencodeSession(id: string): Promise<void> {
  try {
    await cli("session.interrupt", "--param", `sessionID=${id}`);
    await cli("session.update", "--param", `sessionID=${id}`, "--data", '{"archived":true}');
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("SessionNotFoundError"))) throw error;
  }
}

/** The service admits a prompt durably and runs it after any turn in progress, so a busy session can take one. */
export async function promptOpencodeSession(id: string, text: string): Promise<void> {
  const { url, authorization } = opencodeService();
  const response = await fetch(`${url}/api/session/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error((await response.text()).split("\n")[0] || `the OpenCode service answered ${response.status}`);
}
