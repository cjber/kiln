import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { startCodexTurn } from "./codex";
import { claim, type Message, mailboxPath, pending, release } from "./mailbox";
import { promptOpencodeSession } from "./opencode";
import { piInbox } from "./pi-status";
import { type Agent, agentName, type Session, sessionDirectory, sessionIdentity } from "./sessions";
import { submitText } from "./tmux";
import { tilde } from "./tui";

/** The name a message from a person at a shell, rather than an agent, carries. */
export const terminal = "terminal";

/** Each agent puts its own session id in the environment of the commands it runs. */
const sessionVariables: Record<Agent, string> = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  opencode: "OPENCODE_SESSION_ID",
  pi: "PI_SESSION_ID",
};

/** Which agent a process is, from its argv; Pi is a Node script. */
export function processAgent(args: readonly string[]): Agent | undefined {
  const name = basename(args[0] ?? "");
  if (name === "claude" || name === "codex" || name === "opencode") return name;
  if (name === "pi" || args.slice(0, 2).some((arg) => arg.includes("/pi-coding-agent/"))) return "pi";
  return undefined;
}

function nearestAgent(pid = process.ppid): Agent | undefined {
  for (let current: number | undefined = pid; current && current > 1; ) {
    try {
      const agent = processAgent(readFileSync(`/proc/${current}/cmdline`, "utf8").split("\0"));
      if (agent) return agent;
      const stat: string = readFileSync(`/proc/${current}/stat`, "utf8");
      current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The calling session's name. An agent started from another inherits that one's id too, so the nearest agent
 * process above the caller decides which id is its own.
 */
export function callerIdentity(
  environment: Record<string, string | undefined> = Bun.env,
  nearest: Agent | null = nearestAgent() ?? null,
): string | undefined {
  const present = (Object.entries(sessionVariables) as [Agent, string][]).filter(([, name]) => environment[name]);
  const own = nearest ? present.find(([agent]) => agent === nearest) : present.length === 1 ? present[0] : undefined;
  return own && `${own[0]}:${environment[own[1]]}`;
}

/** Sessions that can be written to: running, with a provider id their agent also knows itself by. */
export function reachable(session: Session): boolean {
  return (
    session.id !== undefined &&
    session.lifecycle === undefined &&
    session.place.kind !== "cloud" &&
    session.place.kind !== "saved"
  );
}

/** A full name, or a prefix of one or of the bare id that matches a single session. */
export function findRecipient(sessions: readonly Session[], name: string): Session {
  const candidates = sessions.filter(reachable);
  const exact = candidates.find((session) => sessionIdentity(session) === name);
  if (exact) return exact;
  const matches = candidates.filter(
    (session) => sessionIdentity(session).startsWith(name) || session.id?.startsWith(name),
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (!matches.length) throw new Error(`no running session is called ${name}; run kiln msg list`);
  throw new Error(`${name} matches ${matches.map(sessionIdentity).join(", ")}; give more of the name`);
}

export type Route =
  /** Kiln can put the message in front of the agent now. */
  | { push: "codex" | "opencode" | "pi" | "tmux" }
  /** It can, once the agent stops working or asking. */
  | { wait: string }
  /** The agent has to read it with `kiln msg inbox`. */
  | { inbox: string };

/** How a message reaches a session. Only an agent's own queue takes one while it works; typing waits until it is idle. */
export function route(session: Session, inboxExists: (pid: number) => boolean = isPiInbox): Route {
  const busy = () =>
    session.activity === "idle"
      ? undefined
      : { wait: session.activity ? `${agentName(session.agent)} is ${session.activity}` : "its status is unknown" };
  switch (session.agent) {
    case "opencode":
      return session.opencodeService
        ? { push: "opencode" }
        : { inbox: "it runs outside OpenCode's background service" };
    case "pi":
      return session.pid !== undefined && inboxExists(session.pid)
        ? { push: "pi" }
        : { inbox: "it was not started by kiln, or before kiln could message it" };
    case "codex":
      // Only a thread on Codex's shared daemon reports a status, and only that daemon can start its turn.
      return session.activity === undefined
        ? { inbox: "it is not on Codex's shared daemon" }
        : (busy() ?? { push: "codex" });
    case "claude":
      return session.place.kind === "kiln"
        ? (busy() ?? { push: "tmux" })
        : { inbox: "kiln can only type into Claude sessions it started" };
  }
}

function isPiInbox(pid: number): boolean {
  try {
    return statSync(piInbox(pid)).isDirectory();
  } catch {
    return false;
  }
}

/** What the recipient reads: who wrote, from where, and how to answer. */
export function frame(message: Message, sender: Session | undefined): string {
  const where = sender
    ? ` (${[sender.title && `"${sender.title}"`, tilde(sessionDirectory(sender))].filter(Boolean).join(" in ")})`
    : "";
  const reply = message.from === terminal ? "" : `\n\n[Reply with: kiln msg send ${message.from} "<your reply>"]`;
  return `[kiln message from ${message.from}${where}]\n\n${message.body}${reply}`;
}

export type Transports = Record<
  "codex" | "opencode" | "pi" | "tmux",
  (session: Session, text: string) => Promise<void>
>;

const transports: Transports = {
  codex: (session, text) => startCodexTurn(session.id ?? "", text),
  opencode: (session, text) => promptOpencodeSession(session.id ?? "", text),
  pi: async (session, text) => {
    const directory = piInbox(session.pid ?? 0);
    const name = `${Date.now()}-${crypto.randomUUID()}`;
    // The extension reads only `.json` files, so it never sees one half written.
    writeFileSync(join(directory, `${name}.tmp`), JSON.stringify({ text }), { mode: 0o600, flag: "wx" });
    renameSync(join(directory, `${name}.tmp`), join(directory, `${name}.json`));
  },
  tmux: async (session, text) => {
    if (session.place.kind !== "kiln") throw new Error("not a kiln session");
    await submitText(session.place.name, text);
  },
};

export type Outcome = { message: Message; delivered: true } | { message: Message; delivered: false; reason: string };

/**
 * Put every pending message that can be delivered in front of its recipient. The list, the phone server and each
 * `kiln msg` call this; a message is claimed before it is sent, so only one of them sends it.
 */
export async function flush(
  sessions: readonly Session[],
  options: { path?: string; send?: Transports; inboxExists?: (pid: number) => boolean } = {},
): Promise<Outcome[]> {
  const path = options.path ?? mailboxPath();
  const byName = new Map(sessions.filter(reachable).map((session) => [sessionIdentity(session), session]));
  const outcomes: Outcome[] = [];
  for (const message of pending(path)) {
    const session = byName.get(message.to);
    if (!session) {
      outcomes.push({ message, delivered: false, reason: "it is not running; it can read it later" });
      continue;
    }
    const way = route(session, options.inboxExists);
    if (!("push" in way)) {
      outcomes.push({ message, delivered: false, reason: "wait" in way ? way.wait : way.inbox });
      continue;
    }
    if (!claim(message.id, path)) continue;
    try {
      await (options.send ?? transports)[way.push](session, frame(message, byName.get(message.from)));
      outcomes.push({ message, delivered: true });
    } catch (error) {
      release(message.id, path);
      outcomes.push({ message, delivered: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

let flushing = false;

/** For the list and the phone server: deliver in the background, at most one pass at a time, never throwing. */
export function flushInBackground(sessions: readonly Session[]): void {
  if (flushing || !pending().length) return;
  flushing = true;
  void flush(sessions)
    .catch(() => {})
    .finally(() => {
      flushing = false;
    });
}
