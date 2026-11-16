import { parseArgs } from "node:util";
import { conversationReader } from "./conversation";
import { acknowledge, peekUnread, post, takeUnread } from "./mailbox";
import { callerIdentity, findRecipient, flush, frame, reachable, route, terminal } from "./messages";
import { archiveOpencodeSession } from "./opencode";
import {
  agentName,
  discovery,
  type Session,
  sessionAliases,
  sessionDirectory,
  sessionIdentity,
  sessionParents,
} from "./sessions";
import { reportSpawnExit, spawnAgent, spawnOptions, spawnUsage } from "./spawn";
import { tilde } from "./tui";

const usage = `usage: kiln msg list [--json]          the sessions you can message
       kiln msg send <name|@peer|--all> <text|-> [--as <@peer>] [--json]
                                   message one session or peer, or every other session; - reads stdin
       kiln msg inbox [--as <@peer>] [--json] [--peek] [--wait <seconds>]
                                   read the messages kiln could not deliver to you
       kiln msg ack <message-id...> [--as <@peer>]
                                   acknowledge messages after forwarding them
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
  // Kitty windows are only for focusing; a message never goes through one.
  return (await discovery()({ kitty: false })).sessions.filter(reachable);
}

function delivery(session: Session): string {
  const way = route(session);
  return "push" in way ? "now" : "wait" in way ? `when idle (${way.wait})` : `inbox (${way.inbox})`;
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
    const [, name, child, parent] = args;
    if (name) await reportSpawnExit(name, child ?? "", parent ?? "");
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
              row.activity ?? "unknown",
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
    case "view": {
      if (rest.length !== 1 || values.all || values.peek || values.wait !== undefined || as) break;
      const found = await sessions();
      const session = findRecipient(found, rest[0]);
      const reader = conversationReader(session);
      if (!reader) throw new Error("this session has no readable transcript");
      const page = reader(values.cursor);
      if (values.json) console.log(JSON.stringify(page, null, 2));
      else
        for (const item of page.items)
          console.log(`${item.kind}: ${item.kind === "tool" ? `${item.tool} ${item.text}` : item.text}`);
      return;
    }
  }
  throw new Error(usage);
}
