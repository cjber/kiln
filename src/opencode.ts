import type { Activity } from "./sessions";

/** A conversation held by OpenCode's background service, which outlives the terminals attached to it. */
export type OpencodeSession = {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  activity?: Activity;
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

/** Decided on argv, so a directory or prompt named after a subcommand is still one argument. */
export function opencodeInvocation(args: readonly string[]): { id?: string; shared: boolean } | undefined {
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
  if (command && headlessCommands.has(command)) return undefined;
  return { id: id && /^ses_[A-Za-z0-9]+$/.test(id) ? id : undefined, shared };
}

export function isOpencodeService(args: readonly string[]): boolean {
  return args[1] === "serve" && args.includes("--service");
}

/** `opencode --session` creates the id it is given, which is how a terminal's conversation is known from its argv. */
export function newOpencodeSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
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

/** Every call goes through the CLI, which holds the service's address and password. */
async function api<T>(...args: string[]): Promise<T> {
  const child = Bun.spawn(["opencode", "api", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  const [source, problem, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (code) throw new Error(`${source}\n${problem}`.trim().split("\n")[0] || "the OpenCode service did not answer");
  // A write can answer with an empty body.
  return (source.trim() ? JSON.parse(source) : undefined) as T;
}

let last: OpencodeSession[] = [];

/** Prompts are read for active sessions only: a turn that stops to ask is still a running turn. */
async function read(): Promise<OpencodeSession[]> {
  const [active, listed] = await Promise.all([
    api<{ data: Record<string, Active> }>("session.active"),
    api<{ data: Info[] }>("session.list", "--param", `limit=${listLimit}`),
  ]);
  const waiting = new Set(
    (
      await Promise.all(
        Object.keys(active.data).map(async (id) => {
          const sessionID = `sessionID=${id}`;
          const [permissions, forms] = await Promise.all([
            api<{ data: unknown[] }>("session.permission.list", "--param", sessionID),
            api<{ data: unknown[] }>("session.form.list", "--param", sessionID),
          ]);
          return permissions.data.length || forms.data.length ? [id] : [];
        }),
      )
    ).flat(),
  );
  return listed.data.flatMap((info) =>
    info.time.archived === undefined
      ? [
          {
            id: info.id,
            cwd: info.location.directory,
            createdAt: info.time.created,
            updatedAt: info.time.updated,
            activity: opencodeActivity(active.data[info.id], waiting.has(info.id), info.outcome),
            title: info.title,
            parentId: info.parentID,
          },
        ]
      : [],
  );
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

/** Stop any turn, then hide the conversation; a session that never took a prompt was never stored. */
export async function archiveOpencodeSession(id: string): Promise<void> {
  try {
    await api("session.interrupt", "--param", `sessionID=${id}`);
    await api("session.update", "--param", `sessionID=${id}`, "--data", '{"archived":true}');
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("SessionNotFoundError"))) throw error;
  }
}
