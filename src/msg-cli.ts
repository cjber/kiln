import { parseArgs } from "node:util";
import { post, takeUnread } from "./mailbox";
import { callerIdentity, findRecipient, flush, frame, reachable, route, terminal } from "./messages";
import { agentName, discovery, type Session, sessionDirectory, sessionIdentity } from "./sessions";
import { tilde } from "./tui";

const usage = `usage: kiln msg list [--json]          the sessions you can message
       kiln msg send <name|--all> <text|->  message one session, or every other one; - reads stdin
       kiln msg inbox [--json]         read the messages kiln could not deliver to you
       kiln msg whoami                 your own name`;

async function sessions(): Promise<Session[]> {
  // Kitty windows are only for focusing; a message never goes through one.
  return (await discovery()({ kitty: false })).sessions.filter(reachable);
}

function delivery(session: Session): string {
  const way = route(session);
  return "push" in way ? "now" : "wait" in way ? `when idle (${way.wait})` : `inbox (${way.inbox})`;
}

export async function runMsgCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean" }, all: { type: "boolean" } },
  });
  const [command, ...rest] = positionals;
  const me = callerIdentity();
  switch (command) {
    case "whoami":
      if (rest.length || values.json || values.all) break;
      if (!me) throw new Error("this shell does not belong to an agent session");
      console.log(me);
      return;
    case "list": {
      if (rest.length || values.all) break;
      const rows = (await sessions()).map((session) => ({
        name: sessionIdentity(session),
        agent: session.agent,
        title: session.title,
        directory: sessionDirectory(session),
        activity: session.activity,
        delivery: delivery(session),
        you: sessionIdentity(session) === me,
      }));
      if (values.json) console.log(JSON.stringify(rows, null, 2));
      else
        for (const row of rows)
          console.log(
            [
              `${row.name}${row.you ? " (you)" : ""}`,
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
      if (values.json || rest.length !== (values.all ? 1 : 2) || text === undefined) break;
      const body = (text === "-" ? await Bun.stdin.text() : text).trim();
      if (!body) throw new Error("the message is empty");
      const found = await sessions();
      const recipients = (name === undefined ? found : [findRecipient(found, name)])
        .map(sessionIdentity)
        .filter((recipient) => recipient !== me);
      if (!recipients.length) throw new Error("there is no other session to message");
      const sent = recipients.map((recipient) => post(me ?? terminal, recipient, body));
      const outcomes = await flush(found);
      for (const message of sent) {
        const outcome = outcomes.find((item) => item.message.id === message.id);
        console.log(
          outcome && !outcome.delivered
            ? `${message.to}: queued; ${outcome.reason}. It is delivered when that changes, or read with kiln msg inbox.`
            : `${message.to}: delivered`,
        );
      }
      return;
    }
    case "inbox": {
      if (rest.length || values.all) break;
      if (!me) throw new Error("this shell does not belong to an agent session, so it has no inbox");
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
