import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { startCodexTurn } from "./codex";
import { claim, type Message, mailboxPath, pending, post, posted, release } from "./mailbox";
import { messageOpencodeSession } from "./opencode";
import { piInbox } from "./pi-status";
import { emptyInput } from "./prompt";
import { type Agent, agentName, type Session, sessionDirectory, sessionIdentity, sessionParents } from "./sessions";
import { attachedClients, kiln, rowsAndCursor, submitText } from "./tmux";
import { tilde } from "./tui";

/** The name a message from a person at a shell, rather than an agent, carries. */
export const terminal = "terminal";

/** The name kiln's own messages about an agent's pull requests carry; nobody reads replies to it. */
export const autopilotSender = "kiln-autopilot";

/** The name a message typed on a paired phone carries. */
export const phoneSender = (device: string) => `phone:${device}`;

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

/** How a message reaches a session. Only an agent's own queue takes one while it works; typing waits until its turn ends. */
export function route(session: Session, inboxExists: (pid: number) => boolean = isPiInbox): Route {
  const busy = () =>
    session.activity === "idle" || session.turnEnded
      ? undefined
      : { wait: session.activity ? `${agentName(session.agent)} is ${session.activity}` : "its status is unknown" };
  switch (session.agent) {
    case "opencode":
      return session.opencodeService
        ? { push: "opencode" }
        : {
            inbox:
              "OpenCode's background service holds no conversation for it: it has had no prompt yet, or runs on its own server",
          };
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

/**
 * What the recipient reads: who wrote, from where, and how to answer. The reply names this kiln's executable, since
 * an agent's commands may run with a PATH that has no `kiln` on it, or an older one, as under Codex's daemon.
 */
export function frame(message: Message, sender: Session | undefined, command = kiln): string {
  const where = sender
    ? ` (${[sender.title && `"${sender.title}"`, tilde(sessionDirectory(sender))].filter(Boolean).join(" in ")})`
    : "";
  const quoted = /^[\w./-]+$/.test(command) ? command : `'${command.replaceAll("'", "'\\''")}'`;
  // A person cannot be messaged back.
  const reply =
    message.from === terminal || message.from === autopilotSender || message.from.startsWith(phoneSender(""))
      ? ""
      : `\n\n[Reply with: ${quoted} msg send ${message.from} "<your reply>"]`;
  return `[kiln message from ${message.from}${where}]\n\n${message.body}${reply}`;
}

/** A transport throws this when it refused before sending anything, so the message can simply wait. */
export class NotNow extends Error {}

export type Transports = Record<
  "codex" | "opencode" | "pi" | "tmux",
  (session: Session, text: string, message: Message) => Promise<void>
>;

/** The mailbox id under which kiln asked a session's parent one of its questions. */
const askId = (session: Session, question: string) => `ask:${sessionIdentity(session)}:${question}`;

const transports: Transports = {
  codex: (session, text) => startCodexTurn(session.id ?? "", text),
  // A reply from the agent kiln asked about the open form answers it; anyone else's message waits behind it.
  opencode: (session, text, message) =>
    messageOpencodeSession(session.id ?? "", text, (form) =>
      posted(askId(session, form))?.to === message.from ? message.body : undefined,
    ),
  pi: async (session, text) => {
    const directory = piInbox(session.pid ?? 0);
    const name = `${Date.now()}-${crypto.randomUUID()}`;
    // The extension reads only `.json` files, so it never sees one half written.
    writeFileSync(join(directory, `${name}.tmp`), JSON.stringify({ text }), { mode: 0o600, flag: "wx" });
    renameSync(join(directory, `${name}.tmp`), join(directory, `${name}.json`));
  },
  tmux: async (session, text) => {
    if (session.place.kind !== "kiln") throw new NotNow("not a kiln session");
    const typing = typingHold(session.place.name);
    if (typing) throw new NotNow(typing);
    await submitText(session.place.name, text);
  },
};

/**
 * Why a kiln Claude session's terminal cannot be typed into now. Someone at it may be writing a prompt, which a paste
 * would join and Enter would send, so it waits only while its prompt box holds a draft; an open terminal alone is fine.
 */
function typingHold(name: string): string | undefined {
  const clients = attachedClients(name);
  if (clients === undefined) return "its terminal has closed";
  if (!clients) return undefined;
  const shown = rowsAndCursor(name);
  if (!shown) return "its terminal has closed";
  return emptyInput(shown.rows, shown.cursorY)
    ? undefined
    : "someone is typing in its terminal; it is delivered once that prompt is sent or cleared";
}

/**
 * Why a message for this session waits right now, in the words flush reports, when the wait ends by itself and flush
 * then delivers it. Nothing when it can go now, or when it never goes by itself: it is not running, or it reads its
 * mailbox, which `sessionAbilities` reports as `inbox`.
 */
export function heldBecause(session: Session, inboxExists?: (pid: number) => boolean): string | undefined {
  if (!reachable(session)) return undefined;
  const way = route(session, inboxExists);
  if ("wait" in way) return way.wait;
  if ("inbox" in way) return undefined;
  return way.push === "tmux" && session.place.kind === "kiln" ? typingHold(session.place.name) : undefined;
}

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
      await (options.send ?? transports)[way.push](session, frame(message, byName.get(message.from)), message);
      outcomes.push({ message, delivered: true });
    } catch (error) {
      const refused = error instanceof NotNow;
      release(message.id, !refused, path);
      const reason = error instanceof Error ? error.message : String(error);
      outcomes.push({
        message,
        delivered: false,
        reason: refused ? reason : `${reason}; it may have arrived, so it is left for kiln msg inbox`,
      });
    }
  }
  return outcomes;
}

const asked = new Set<string>();

/**
 * A subagent's question shows on no screen, so the agent that started it hears it instead, as a message from the
 * subagent that its reply answers. Each question is posted once, under its own id.
 */
export function askParents(sessions: readonly Session[], send: typeof post = post, seen = asked): number {
  const parents = sessionParents(sessions);
  let posted = 0;
  for (const session of sessions) {
    const parent = parents.get(session);
    if (session.activity !== "waiting" || !session.question || !parent || !reachable(session) || !reachable(parent))
      continue;
    const key = askId(session, session.question.id);
    if (seen.has(key)) continue;
    try {
      send(
        sessionIdentity(session),
        sessionIdentity(parent),
        `I stopped to ask this, and nobody else can see it:\n\n${session.question.text}\n\nYour reply answers it.`,
        undefined,
        undefined,
        key,
      );
      seen.add(key);
      posted++;
    } catch {
      // A full mailbox or a send limit leaves it for the next refresh.
    }
  }
  return posted;
}

let flushing = false;

/**
 * For the list and the phone server: pass subagents' questions to their parents, then deliver in the background, at
 * most one pass at a time, never throwing.
 */
export function flushInBackground(sessions: readonly Session[]): void {
  if (flushing) return;
  flushing = true;
  // A locked or broken mailbox must not take the list or the phone server down with it.
  void Promise.resolve()
    .then(() => {
      askParents(sessions);
      return pending().length ? flush(sessions) : undefined;
    })
    .catch(() => {})
    .finally(() => {
      flushing = false;
    });
}
