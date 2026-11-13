import { parseArgs } from "node:util";
import { post, takeUnread } from "./mailbox";
import { callerIdentity, findRecipient, flush, frame, reachable, route, terminal } from "./messages";
import { archiveOpencodeSession } from "./opencode";
import { agentName, discovery, type Session, sessionDirectory, sessionIdentity, sessionParents } from "./sessions";
import { spawnAgent, spawnOptions, spawnUsage } from "./spawn";
import { tilde } from "./tui";

const usage = `usage: kiln msg list [--json]          the sessions you can message
       kiln msg send <name|@peer|--all> <text|-> [--as <@peer>] [--json]
                                   message one session or peer, or every other session; - reads stdin
       kiln msg inbox [--as <@peer>] [--json]
                                   read the messages kiln could not deliver to you
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
  // The wrapper around a spawned OpenCode run calls this when the run exits.
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
    options: { json: { type: "boolean" }, all: { type: "boolean" }, as: { type: "string" } },
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
          agent: session.agent,
          title: session.title,
          directory: sessionDirectory(session),
          activity: session.activity,
          delivery: delivery(session),
          you: sessionIdentity(session) === me,
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
      const [name, text] = values.all ? [undefined, rest[0]] : rest;
      if (rest.length !== (values.all ? 1 : 2) || text === undefined) break;
      const body = (text === "-" ? await Bun.stdin.text() : text).trim();
      if (!body) throw new Error("the message is empty");
      const found = await sessions();
      // A peer is not in the roster, so it is never typed into: the message waits in its mailbox.
      const peer = name !== undefined && isPeer(name) ? peerName(name) : undefined;
      if (peer !== undefined && peer === me) throw new Error("you cannot message yourself");
      const recipients =
        peer !== undefined
          ? [peer]
          : (name === undefined ? found : [findRecipient(found, name)])
              .map(sessionIdentity)
              .filter((recipient) => recipient !== me);
      if (!recipients.length) throw new Error("there is no other session to message");
      const sent = recipients.map((recipient) => post(me ?? terminal, recipient, body));
      const outcomes = await flush(found);
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
      if (rest.length || values.all) break;
      if (!me)
        throw new Error("this shell does not belong to an agent session, so it has no inbox; name a peer with --as");
      const messages = takeUnread(me);
      const found = messages.length ? await sessions() : [];
      const sender = (from: string) => found.find((session) => sessionIdentity(session) === from);
      if (values.json) console.log(JSON.stringify(messages, null, 2));
      else if (!messages.length) console.log("no new messages");
      else console.log(messages.map((message) => frame(message, sender(message.from))).join("\n\n---\n\n"));
      return;
    }
  }
  throw new Error(usage);
}
