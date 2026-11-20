import { parseArgs } from "node:util";
import { conversationReader, endedConversationReader, type Page } from "./conversation";
import { acknowledge, peekUnread, post, takeUnread, writeOutbox } from "./mailbox";
import { callerIdentity, findRecipient, flush, frame, interrupt, reachable, route, terminal } from "./messages";
import { archiveOpencodeSession } from "./opencode";
import {
  agentName,
  discovery,
  isFullName,
  type Session,
  sessionAliases,
  sessionDirectory,
  sessionIdentity,
  sessionParents,
} from "./sessions";
import { reportSpawnExit, spawnAgent, spawnOptions, spawnUsage, watchSpawnExit } from "./spawn";
import { sessionsHidden } from "./tmux";
import { tilde } from "./tui";

const usage = `usage: kiln msg list [--json]          the sessions you can message
       kiln msg send <name|@peer|--all> <text|-> [--as <@peer>] [--json]
                                   message one session or peer, or every other session; - reads stdin
       kiln msg inbox [--as <@peer>] [--json] [--peek] [--wait <seconds>]
                                   read the messages kiln could not deliver to you
       kiln msg ack <message-id...> [--as <@peer>]
                                   acknowledge messages after forwarding them
       kiln msg interrupt <name> [--json]  stop the session's turn in progress; follow with send to redirect it
       kiln msg view <name> [--json] [--cursor <cursor>]
                                   read a session transcript page
       kiln msg whoami                 your own name
       ${spawnUsage.slice("usage: ".length)}`;

/** A peer is a mailbox identity that is not a running session, named with a leading `@`. */
const PEER = /^@[A-Za-z0-9._:-]{1,63}$/;

/**
 * A sender or recipient that is not one of kiln's sessions.
 *
 * `--as` exists so a program outside kiln (a Nebula agent, the CLI) can hold a
 * mailbox of its own: it sends as `@name`, a session answers it with
 * `kiln msg send @name`, and reads the answer with `kiln msg inbox --as @name`.
 * The leading `@` is what keeps an override from impersonating a session, whose
 * names have no `@`.
 */
export function peerName(raw: string): string {
  if (!PEER.test(raw))
    throw new Error(`a peer is @ followed by letters, digits, ".", "_", ":" or "-" (at most 64); got ${raw}`);
  return raw;
}

/** Whether a name addresses a mailbox peer rather than a running session. */
export function isPeer(name: string): boolean {
  return name.startsWith("@");
}

async function sessions(): Promise<Session[]> {
  // A process that cannot see the sessions would list none and call each one gone, so it says why instead.
  const hidden = await sessionsHidden();
  if (hidden) throw new Error(hidden);
  // Kitty windows are only for focusing; a message never goes through one.
  return (await discovery()({ kitty: false })).sessions.filter(reachable);
}

/**
 * A send from a process that cannot see the sessions, such as a spawned child in its agent's sandbox. Delivery needs
 * discovery, which only kiln outside the sandbox can do, so the message waits on disk for it. A spawned child leaves it
 * in the outbox its spawn granted, where its exit watcher resolves the name and relays it as from that child. Any other
 * caller posts to the mailbox, which kiln's list and phone server deliver from, and there only a full name finds anyone.
 */
function queueUnseen(
  hidden: string,
  name: string | undefined,
  body: string,
  me: string | undefined,
  outbox = Bun.env.KILN_OUTBOX,
): { to: string; delivered: false; reason: string } {
  if (name === undefined) throw new Error(`${hidden}; name the recipient, and kiln delivers it from outside`);
  if (name === me) throw new Error("you cannot message yourself");
  if (outbox) writeOutbox(outbox, name, body);
  else if (isFullName(name)) post(me ?? terminal, name, body);
  else throw new Error(`${hidden}; name the recipient in full, as agent:id, and kiln delivers it from outside`);
  return { to: name, delivered: false, reason: "this sandbox hides the sessions, so kiln delivers it from outside" };
}

function delivery(session: Session): string {
  const way = route(session);
  return "push" in way ? "now" : "wait" in way ? `when idle (${way.wait})` : `inbox (${way.inbox})`;
}

/** A running session by any of its names, or one that has ended by its full name. */
async function transcriptReader(name: string): Promise<(cursor?: string) => Page> {
  let session: Session;
  try {
    session = findRecipient(await sessions(), name);
  } catch (error) {
    const ended = endedConversationReader(name);
    if (ended) return ended;
    throw error;
  }
  const reader = conversationReader(session);
  if (!reader) throw new Error("this session has no readable transcript");
  return reader;
}

export async function runMsgCli(args: string[]): Promise<void> {
  const [first] = args;
  if (first === "spawn") {
    // Outside an agent session (a timer, a person's shell) the child starts with no parent.
    console.log(await spawnAgent(spawnOptions(args.slice(1)), callerIdentity()));
    return;
  }
  // A spawned child's kept pane calls this from its pane-died hook when its process exits.
  if (first === "exit") {
    const [, name, child, parent, run] = args;
    if (name) await reportSpawnExit(name, child ?? "", parent ?? "", run ?? "");
    return;
  }
  // A watcher the spawn started reports the same exit when a tmux that lost the pane's SIGCHLD never fires that hook.
  if (first === "watch") {
    const [, name, child, parent, run] = args;
    if (name) await watchSpawnExit(name, child ?? "", parent ?? "", run ?? "");
    return;
  }
  // Older versions wrapped a spawned OpenCode run with this; keep it working for one already running.
  if (first === "archive") {
    const child = args[1] ?? "";
    const separator = child.indexOf(":");
    if (separator > 0 && child.slice(0, separator) === "opencode")
      await archiveOpencodeSession(child.slice(separator + 1));
    return;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      all: { type: "boolean" },
      as: { type: "string" },
      peek: { type: "boolean" },
      wait: { type: "string" },
      cursor: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  const as = values.as === undefined ? undefined : peerName(values.as);
  const me = as ?? callerIdentity();
  switch (command) {
    case "whoami":
      if (rest.length || values.json || values.all || as) break;
      if (!me) throw new Error("this shell does not belong to an agent session");
      console.log(me);
      return;
    case "list": {
      if (rest.length || values.all || as) break;
      const found = await sessions();
      const parents = sessionParents(found);
      const depth = (session: Session): number => {
        let levels = 0;
        const seen = new Set<Session>([session]);
        for (let parent = parents.get(session); parent && !seen.has(parent); parent = parents.get(parent)) {
          seen.add(parent);
          levels++;
        }
        return levels;
      };
      const rows = found.map((session) => {
        const parent = parents.get(session);
        return {
          name: sessionIdentity(session),
          aliases: sessionAliases(session),
          agent: session.agent,
          title: session.title,
          directory: sessionDirectory(session),
          activity: session.activity,
          turnEnded: session.turnEnded ?? false,
          paused: session.paused ?? false,
          delivery: delivery(session),
          you: me !== undefined && (sessionIdentity(session) === me || sessionAliases(session).includes(me)),
          parent: parent ? sessionIdentity(parent) : null,
          depth: depth(session),
        };
      });
      if (values.json) console.log(JSON.stringify(rows, null, 2));
      else
        for (const row of rows)
          console.log(
            [
              `${"  ".repeat(row.depth)}${row.name}${row.you ? " (you)" : ""}`,
              agentName(row.agent),
              // Claude counts a turn that ended with a background shell or subagent still running as working.
              row.paused ? "paused" : row.turnEnded ? `${row.activity}, turn ended` : (row.activity ?? "unknown"),
              tilde(row.directory),
              row.title ?? "",
              `delivery: ${row.delivery}`,
            ].join("  "),
          );
      return;
    }
    case "send": {
      if (values.peek || values.wait !== undefined || values.cursor !== undefined) break;
      const [name, text] = values.all ? [undefined, rest[0]] : rest;
      if (rest.length !== (values.all ? 1 : 2) || text === undefined) break;
      const body = (text === "-" ? await Bun.stdin.text() : text).trim();
      if (!body) throw new Error("the message is empty");
      // A peer is not in the roster, so it is never typed into: the message waits in its mailbox.
      const peer = name !== undefined && isPeer(name) ? peerName(name) : undefined;
      if (peer !== undefined && peer === me) throw new Error("you cannot message yourself");
      const hidden = peer === undefined ? await sessionsHidden() : undefined;
      if (hidden) {
        const result = queueUnseen(hidden, name, body, me);
        console.log(values.json ? JSON.stringify([result], null, 2) : `${result.to}: queued; ${result.reason}.`);
        return;
      }
      const found = peer === undefined ? await sessions() : [];
      const recipients =
        peer !== undefined
          ? [peer]
          : (name === undefined ? found : [findRecipient(found, name)])
              .map(sessionIdentity)
              .filter((recipient) => recipient !== me);
      if (!recipients.length) throw new Error("there is no other session to message");
      const sent = recipients.map((recipient) => post(me ?? terminal, recipient, body));
      const outcomes = peer === undefined ? await flush(found, { recipients: new Set(recipients) }) : [];
      const results = sent.map((message) => {
        const outcome = outcomes.find((item) => item.message.id === message.id);
        if (isPeer(message.to))
          return {
            to: message.to,
            delivered: false,
            reason: "it is not a running session; it reads the message with kiln msg inbox",
          };
        return outcome && !outcome.delivered
          ? { to: message.to, delivered: false, reason: outcome.reason }
          : { to: message.to, delivered: true, reason: undefined };
      });
      if (values.json) console.log(JSON.stringify(results, null, 2));
      else
        for (const result of results)
          console.log(
            result.delivered
              ? `${result.to}: delivered`
              : isPeer(result.to)
                ? `${result.to}: queued; read with kiln msg inbox --as ${result.to}`
                : `${result.to}: queued; ${result.reason}. It is delivered when that changes, or read with kiln msg inbox.`,
          );
      return;
    }
    case "inbox": {
      if (rest.length || values.all || values.cursor !== undefined) break;
      if (!me)
        throw new Error("this shell does not belong to an agent session, so it has no inbox; name a peer with --as");
      const waitSeconds = values.wait === undefined ? 0 : Number(values.wait);
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 300)
        throw new Error("--wait must be 0 to 300 seconds");
      const read = () => (values.peek ? peekUnread(me) : takeUnread(me));
      let messages = read();
      const deadline = Date.now() + waitSeconds * 1000;
      while (!messages.length && Date.now() < deadline) {
        await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
        messages = read();
      }
      const found = messages.length && !values.json ? await sessions() : [];
      const sender = (from: string) => found.find((session) => sessionIdentity(session) === from);
      if (values.json) console.log(JSON.stringify(messages, null, 2));
      else if (!messages.length) console.log("no new messages");
      else console.log(messages.map((message) => frame(message, sender(message.from))).join("\n\n---\n\n"));
      return;
    }
    case "ack": {
      if (
        !rest.length ||
        values.all ||
        values.json ||
        values.peek ||
        values.wait !== undefined ||
        values.cursor !== undefined
      )
        break;
      if (!me) throw new Error("this shell does not belong to an agent session; name a peer with --as");
      console.log(acknowledge(me, rest));
      return;
    }
    case "interrupt": {
      if (
        rest.length !== 1 ||
        values.all ||
        values.peek ||
        values.wait !== undefined ||
        values.cursor !== undefined ||
        as
      )
        break;
      const session = findRecipient(await sessions(), rest[0]);
      const name = sessionIdentity(session);
      if (name === me) throw new Error("you cannot interrupt yourself");
      const stopped = await interrupt(session);
      if (values.json) console.log(JSON.stringify({ name, interrupted: stopped }));
      else console.log(stopped ? `${name}: interrupted` : `${name}: not working, nothing to interrupt`);
      return;
    }
    case "view": {
      if (rest.length !== 1 || values.all || values.peek || values.wait !== undefined || as) break;
      const page = (await transcriptReader(rest[0]))(values.cursor);
      if (values.json) console.log(JSON.stringify(page, null, 2));
      else
        for (const item of page.items)
          console.log(`${item.kind}: ${item.kind === "tool" ? `${item.tool} ${item.text}` : item.text}`);
      return;
    }
  }
  throw new Error(usage);
}
