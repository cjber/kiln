import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ClaudeNotQueued, claudeInbox, claudeTranscript, InboxClosed, sendClaudeInbox } from "./claude-inbox";
import { CodexNotReady, interruptCodexSession, messageCodexSession } from "./codex";
import { conversationReader, type Item } from "./conversation";
import { claim, lastFrom, type Message, mailboxPath, pending, post, posted, release, sentSince } from "./mailbox";
import { MuseNotReady, messageMuseSession } from "./muse";
import { interruptOpencodeSession, messageOpencodeSession } from "./opencode";
import { piInbox } from "./pi-status";
import { emptyInput } from "./prompt";
import { savedRow, spawnRecord } from "./saved-sessions";
import {
  type Agent,
  agentName,
  answersTo,
  isFullName,
  type Missing,
  type Session,
  sessionDirectory,
  sessionIdentity,
  sessionParents,
} from "./sessions";
import { attachedClients, kiln, rowsAndCursor, screen, sendKey, submitText } from "./tmux";
import { tilde } from "./tui";

/** The name a message from a person at a shell, rather than an agent, carries. */
export const terminal = "terminal";

/** The name kiln's own messages about an agent's pull requests carry; nobody reads replies to it. */
export const autopilotSender = "kiln-autopilot";

/** A spawned child's exit report carries this prefix; its process is gone, so a reply has nowhere to go. */
export const spawnSender = "kiln-spawn";

/** Each child reports under its own name, so one busy parent can collect more than the per-sender send limit. */
export const spawnReportSender = (child: string) => `${spawnSender}:${child}`;

/**
 * Whether delivered text is one of kiln's own notices (an overlap or pull request warning, a child's exit report), which
 * hand a session no new work. It reads the header `frame` writes, the only place a transcript names the sender: Claude
 * records a peer message's sender as "unknown" and puts one line of its own before the header.
 */
export function kilnNotice(text: string): boolean {
  const header = text.split("\n", 2).find((line) => line.startsWith("[kiln message from "));
  return [autopilotSender, spawnSender].some((sender) => header?.startsWith(`[kiln message from ${sender}`));
}

/** The name a message typed on a paired phone carries. */
export const phoneSender = (device: string) => `phone:${device}`;
const fromPhone = (from: string) => from.startsWith(phoneSender(""));

/** Each agent puts its own session id in the environment of the commands it runs. */
const sessionVariables: Record<Agent, string> = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  opencode: "OPENCODE_SESSION_ID",
  pi: "PI_SESSION_ID",
  muse: "MUSE_SESSION_ID",
  agy: "ANTIGRAVITY_CONVERSATION_ID",
};

/** Which agent a process is, from its argv; Pi is a Node script. */
export function processAgent(args: readonly string[]): Agent | undefined {
  const name = basename(args[0] ?? "");
  if (name === "claude" || name === "codex" || name === "opencode") return name;
  if (name === "agy") return "agy";
  if (name === "muse" || name.startsWith("muse-bin-")) return "muse";
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

/**
 * A spawned child's last exit report, unless the conversation has been run again since it was written: the report
 * tells of the run that ended, and a resumed child is a later run that has not.
 */
export function lastExit(
  child: string,
  report = lastFrom(spawnReportSender(child)),
  run = isFullName(child)
    ? savedRow({ agent: child.slice(0, child.indexOf(":")) as Agent, id: child.slice(child.indexOf(":") + 1) })
    : undefined,
): Message | undefined {
  return report && (run === undefined || report.createdAt >= run.startedAt) ? report : undefined;
}

/** A full name, or a prefix of one or of the bare id that matches a single session. */
export function findRecipient(
  sessions: readonly Session[],
  name: string,
  exitReport: (name: string) => Message | undefined = lastExit,
  /** From discovery: a name `sessions` lacks, which that source could have listed, is then not known to be gone. */
  missing?: Missing,
): Session {
  const candidates = sessions.filter(reachable);
  const exact = candidates.find((session) => answersTo(session, name));
  if (exact) return exact;
  const matches = candidates.filter(
    (session) => sessionIdentity(session).startsWith(name) || session.id?.startsWith(name),
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (!matches.length) {
    // A spawned child that has exited left its exit report, so a sender can tell it from a mistyped name.
    const exit = exitReport(name);
    if (exit)
      throw new Error(
        `${name} has exited; kiln reported at ${new Date(exit.createdAt).toISOString()}: ${exit.body.split("\n")[0]}`,
      );
    const agent = name.includes(":") ? name.slice(0, name.indexOf(":")) : undefined;
    if (missing && (missing.agent === undefined || agent === undefined || agent === missing.agent))
      throw new Error(`${missing.reason}, so kiln cannot tell whether ${name} is running`);
    throw new Error(`no running session is called ${name}; run kiln msg list`);
  }
  throw new Error(`${name} matches ${matches.map(sessionIdentity).join(", ")}; give more of the name`);
}

export type Route =
  /** Kiln can put the message in front of the agent now. */
  | { push: "claude" | "codex" | "opencode" | "pi" | "muse" | "tmux" }
  /** It can, once the agent stops working or asking. */
  | { wait: string }
  /** The agent has to read it with `kiln msg inbox`. */
  | { inbox: string };

/** How a message reaches a session. Only an agent's own queue takes one while it works; typing waits until its turn ends. */
export function route(session: Session, inboxExists: (pid: number) => boolean = isPiInbox, from?: string): Route {
  // Nothing a stopped process holds, its own queue included, is read until it continues.
  if (session.paused) return { wait: "its process is stopped; it is delivered once the process continues" };
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
      // Only that daemon can start a turn; a thread whose status it does not report, or an exec run, is not on it.
      return session.activity === undefined || session.codexExec
        ? { inbox: "it is not on Codex's shared daemon" }
        : session.activity === "waiting" && !session.turnEnded
          ? { wait: "Codex is waiting" }
          : { push: "codex" };
    case "claude":
      // Claude frames whatever its inbox takes as another session's message, so the person's own words from a phone are
      // typed at the prompt of a terminal kiln started, where Claude reads them as theirs.
      if (from !== undefined && fromPhone(from) && session.place.kind === "kiln") return busy() ?? { push: "tmux" };
      // Claude's inbox queues a message while a turn runs, as Codex's daemon does; a question waits for its answer.
      if (session.claudeInbox)
        return session.activity === "waiting" && !session.turnEnded
          ? { wait: "Claude is waiting" }
          : { push: "claude" };
      return session.place.kind === "kiln"
        ? (busy() ?? { push: "tmux" })
        : { inbox: "it has no Claude inbox, and kiln can only type into Claude sessions it started" };
    case "muse":
      // Muse's own session messaging queues a message with its live session, as Claude's inbox does.
      if (session.museExec) return { inbox: "it is a headless muse exec run, with no live session to message" };
      return session.id !== undefined ? { push: "muse" } : { inbox: "kiln does not know its Muse session id" };
    case "agy":
      // agy has no push transport: kiln types into a terminal it started once the turn ends, which its summary row reports.
      if (session.agyExec) return { inbox: "it is a headless agy -p run, with no terminal to type into" };
      return session.place.kind === "kiln"
        ? (busy() ?? { push: "tmux" })
        : { inbox: "kiln can only type into agy sessions it started" };
  }
}

export type Interruption = { via: "codex" | "opencode" | "tmux" } | { unsupported: string };

/** How kiln stops a session's turn in progress, or why it cannot. */
export function interruption(session: Session): Interruption {
  // An exec run has no terminal input, even in a kiln pane, and is not on the shared daemon.
  if (session.codexExec) return { unsupported: "a codex exec run takes no input" };
  if (session.museExec) return { unsupported: "a muse exec run takes no input" };
  if (session.agyExec) return { unsupported: "an agy -p run takes no input" };
  // Muse never reports whether it is working, so Escape could land on an idle prompt and clear a draft.
  if (session.agent === "muse")
    return { unsupported: "Muse does not report when it is working, so kiln cannot tell a turn from an idle prompt" };
  // Escape is how an agent's own terminal ends a turn. OpenCode's TUI wants it twice, so its service stops it instead.
  if (session.place.kind === "kiln" && session.agent !== "opencode") return { via: "tmux" };
  switch (session.agent) {
    case "claude":
      return { unsupported: "kiln can only press keys in Claude sessions it started" };
    case "codex":
      return session.activity === undefined ? { unsupported: "it is not on Codex's shared daemon" } : { via: "codex" };
    case "opencode":
      return session.opencodeService
        ? { via: "opencode" }
        : { unsupported: "OpenCode's background service holds no conversation for it" };
    case "pi":
      return { unsupported: "kiln can only press keys in Pi sessions it started" };
    case "agy":
      return { unsupported: "kiln can only press keys in agy sessions it started" };
  }
}

/**
 * Stop a session's turn in progress. False when it is not working, so there is nothing to stop: Escape on an idle
 * prompt or an unknown state could clear someone's typing.
 */
export async function interrupt(session: Session): Promise<boolean> {
  const way = interruption(session);
  if ("unsupported" in way) throw new Error(`cannot interrupt ${sessionIdentity(session)}: ${way.unsupported}`);
  if (session.activity !== "working") return false;
  switch (way.via) {
    case "codex":
      return interruptCodexSession(session.id ?? "");
    case "opencode":
      await interruptOpencodeSession(session.id ?? "");
      return true;
    case "tmux":
      if (session.place.kind !== "kiln" || attachedClients(session.place.name) === undefined)
        throw new Error("its terminal has closed");
      if (!sendKey(session.place.name, "Escape")) throw new Error(`could not press Escape in ${session.place.name}`);
      return true;
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
 * The kiln a reply runs: this one's executable, since an agent's commands may run with a PATH that has no `kiln` on it,
 * or an older one, as under Codex's daemon. A kiln that keeps running after its executable was removed or moved, as an
 * upgrade to another install path leaves it, names the `kiln` on PATH instead of a path that no longer runs.
 */
export function replyCommand(own = kiln): string {
  return existsSync(own) ? own : (Bun.which("kiln") ?? "kiln");
}

/** What the recipient reads: who wrote, from where, and how to answer. */
export function frame(message: Message, sender: Session | undefined, command = replyCommand()): string {
  const where = sender
    ? ` (${[sender.title && `"${sender.title}"`, tilde(sessionDirectory(sender))].filter(Boolean).join(" in ")})`
    : "";
  const quoted = /^[\w./-]+$/.test(command) ? command : `'${command.replaceAll("'", "'\\''")}'`;
  // A person cannot be messaged back.
  const reply =
    message.from === terminal ||
    message.from === autopilotSender ||
    message.from.startsWith(spawnSender) ||
    fromPhone(message.from)
      ? ""
      : `\n\n[Reply with: ${quoted} msg send ${message.from} "<your reply>"]`;
  return `[kiln message from ${message.from}${where}]\n\n${message.body}${reply}`;
}

/** What a transport puts in front of the recipient: the person's own phone words as they wrote them, typed as theirs. */
export function typedText(message: Message, sender: Session | undefined): string {
  return fromPhone(message.from) ? message.body : frame(message, sender);
}

/** A transport throws this when it refused before sending anything, so the message can simply wait. */
export class NotNow extends Error {}

/** The recipient holds the message until a person answers its prompt; the error says where. */
export class HeldForApproval extends Error {}

/**
 * Whether a Claude pane shows its prompt for a message from another session, which Claude holds rather than queues
 * when its settings or the two sessions' permission modes say a person has to let it in. Claude reports that hold
 * only to the sender's own inbox, which kiln does not have, so the pane is the one place it shows.
 */
export function approvalShown(text: string): boolean {
  return text.includes("Deliver this message to Claude");
}

export type Transports = Record<
  "claude" | "codex" | "opencode" | "pi" | "muse" | "tmux",
  (session: Session, text: string, message: Message) => Promise<void>
>;

/** The mailbox id under which kiln asked a session's parent one of its questions. */
const askId = (session: Session, question: string) => `ask:${sessionIdentity(session)}:${question}`;

const transports: Transports = {
  claude: async (session, text) => {
    const inbox = session.pid === undefined ? undefined : claudeInbox(session.pid);
    const transcript = claudeTranscript(session.cwd, session.id);
    if (!inbox || !transcript) throw new NotNow("its Claude inbox has closed");
    try {
      await sendClaudeInbox(inbox, text, transcript);
    } catch (error) {
      if (error instanceof InboxClosed) throw new NotNow(error.message);
      const shown = error instanceof ClaudeNotQueued && session.place.kind === "kiln" && screen(session.place.name);
      if (shown && approvalShown(shown.text))
        throw new HeldForApproval(
          `held at Claude's message approval prompt in ${sessionIdentity(session)}; approve it there`,
        );
      throw error;
    }
  },
  codex: async (session, text) => {
    try {
      await messageCodexSession(session.id ?? "", text);
    } catch (error) {
      if (error instanceof CodexNotReady) throw new NotNow(error.message);
      throw error;
    }
  },
  // A reply from the agent kiln asked about the open form answers it; anyone else's message waits behind it.
  opencode: (session, text, message) =>
    messageOpencodeSession(session.id ?? "", text, (form) =>
      posted(askId(session, form))?.to === message.from ? message.body : undefined,
    ),
  muse: async (session, text) => {
    try {
      await messageMuseSession(session.id ?? "", text);
    } catch (error) {
      if (error instanceof MuseNotReady) throw new NotNow(error.message);
      throw error;
    }
  },
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
export function heldBecause(
  session: Session,
  inboxExists?: (pid: number) => boolean,
  from?: string,
): string | undefined {
  if (!reachable(session)) return undefined;
  const way = route(session, inboxExists, from);
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
  options: {
    path?: string;
    send?: Transports;
    inboxExists?: (pid: number) => boolean;
    recipients?: ReadonlySet<string>;
  } = {},
): Promise<Outcome[]> {
  const path = options.path ?? mailboxPath();
  const byName = new Map(sessions.filter(reachable).map((session) => [sessionIdentity(session), session]));
  const messages = pending(path).filter((message) => !options.recipients || options.recipients.has(message.to));
  const queues = new Map<string, Message[]>();
  for (const message of messages) {
    const queue = queues.get(message.to) ?? [];
    queue.push(message);
    queues.set(message.to, queue);
  }
  const outcomes = new Map<string, Outcome>();
  await Promise.all(
    [...queues.values()].map(async (queue) => {
      // The route depends on the sender, so a message held for typing must also hold the ones queued behind it, or a
      // later message reaches the agent first.
      let held: string | undefined;
      for (const message of queue) {
        const session = byName.get(message.to);
        if (!session) {
          outcomes.set(message.id, { message, delivered: false, reason: "it is not running; it can read it later" });
          continue;
        }
        if (held) {
          outcomes.set(message.id, { message, delivered: false, reason: held });
          continue;
        }
        const way = route(session, options.inboxExists, message.from);
        if (!("push" in way)) {
          if ("wait" in way) held = way.wait;
          outcomes.set(message.id, { message, delivered: false, reason: "wait" in way ? way.wait : way.inbox });
          continue;
        }
        if (!claim(message.id, path)) continue;
        try {
          const text =
            way.push === "tmux"
              ? typedText(message, byName.get(message.from))
              : frame(message, byName.get(message.from));
          await (options.send ?? transports)[way.push](session, text, message);
          outcomes.set(message.id, { message, delivered: true });
        } catch (error) {
          const refused = error instanceof NotNow;
          release(message.id, !refused, path);
          const reason = error instanceof Error ? error.message : String(error);
          if (refused) held = reason;
          outcomes.set(message.id, {
            message,
            delivered: false,
            reason:
              refused || error instanceof HeldForApproval
                ? reason
                : `${reason}; it may have arrived, so it is left for kiln msg inbox`,
          });
        }
      }
    }),
  );
  return messages.flatMap((message) => {
    const outcome = outcomes.get(message.id);
    return outcome ? [outcome] : [];
  });
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

/** The mailbox id of kiln's report that a child's turn ended: one per reply, however many processes saw it end. */
export const turnReportId = (child: string, reply: string) => `turn:${child}:${reply}`;

/** What a child's turn left, read from its own conversation; undefined when its provider keeps none kiln reads. */
export function lastTurn(session: Session): { started?: number; reply?: { id: string; text: string } } | undefined {
  const read = conversationReader(session);
  if (!read) return undefined;
  let items: Item[];
  try {
    items = read().items;
  } catch {
    return undefined;
  }
  return currentTurn(items);
}

/**
 * The latest turn in a conversation: when its prompt arrived and the reply that followed it. A typed prompt, a peer
 * message and a task notification each start a turn, and a reply from before that prompt belongs to an earlier turn.
 */
export function currentTurn(items: readonly Item[]): { started?: number; reply?: { id: string; text: string } } {
  const start = items.findLastIndex((item) => item.kind === "you" || item.kind === "notice");
  const reply = items.slice(start + 1).findLast((item) => item.kind === "agent");
  return {
    started: items[start]?.at,
    reply: reply && "text" in reply ? { id: reply.id, text: reply.text } : undefined,
  };
}

/**
 * A child whose own turn ended tells the session that started it, unless it messaged that session itself during the
 * turn: its state, its last reply, and how to close it once its work is in. One report per reply, under its own id, so
 * the list and the phone server, which both see the turn end, post it once. Returns whether a report was posted.
 */
export function reportTurnEnd(
  child: Session,
  parent: Session,
  send: typeof post = post,
  turn: typeof lastTurn = lastTurn,
  messaged: (from: string, to: string, since: number) => boolean = sentSince,
  headless: (pane: string) => boolean = (pane) => {
    const record = spawnRecord(pane);
    return record !== undefined && !record.interactive;
  },
): boolean {
  if (!reachable(child) || !reachable(parent)) return false;
  // A headless child's process exits with its turn, and its exit report carries the same last output.
  if (child.place.kind === "kiln" && headless(child.place.name)) return false;
  const name = sessionIdentity(child);
  const to = sessionIdentity(parent);
  const ended = turn(child);
  // No reply in this turn: nothing new to report. The TUI runs this too, so it prints nothing.
  if (!ended?.reply) return false;
  if (ended.started !== undefined && messaged(name, to, ended.started)) return false;
  const titled = child.title ? ` ("${child.title}")` : "";
  const state =
    child.activity === "waiting"
      ? "is waiting on input or an approval"
      : child.turnEnded
        ? "ended its turn while its background work still runs"
        : "finished its turn";
  const next =
    child.activity === "waiting"
      ? `Answer it with: kiln msg send ${name} "<your reply>"`
      : child.turnEnded
        ? `It reports again when that work is done.`
        : `If its work is in, close it: kiln close ${name}`;
  try {
    send(
      spawnReportSender(name),
      to,
      `Child ${name}${titled} ${state} without messaging you.\n\nLast output:\n\n${ended.reply.text.trim()}\n\n${next}`,
      undefined,
      undefined,
      turnReportId(name, ended.reply.id),
    );
    return true;
  } catch {
    // A full mailbox or a send limit: the child's reply stays in its conversation for the parent to read.
    return false;
  }
}

/**
 * Hand a child whose parent has exited to its grandparent: its reports would otherwise go to a mailbox nobody reads, and
 * a working child left with no reader runs on unseen.
 */
export function reportOrphan(child: Session, parent: Session, grandparent: Session, send: typeof post = post): boolean {
  if (!reachable(child) || !reachable(grandparent)) return false;
  const name = sessionIdentity(child);
  const titled = child.title ? ` ("${child.title}")` : "";
  const state = child.activity === "waiting" ? "is waiting on input or an approval" : "is still working";
  try {
    send(
      spawnReportSender(name),
      sessionIdentity(grandparent),
      `Child ${name}${titled} ${state}, but ${sessionIdentity(parent)}, which started it, has exited. Its reports would reach nobody, so it is yours now.\n\nMessage it with: kiln msg send ${name} "<your message>"\nWhen its work is in, close it: kiln close ${name}`,
      undefined,
      undefined,
      `orphan:${name}:${sessionIdentity(parent)}`,
    );
    return true;
  } catch {
    // A full mailbox or a send limit: the child stays listed for the person.
    return false;
  }
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
