import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { blame } from "./blame";
import {
  type FileEdit,
  fileChange,
  fileHistory,
  type Ledger,
  ledgers,
  lineCounts,
  splitLines,
  turnSummaries,
} from "./edits";
import { callerIdentity } from "./messages";
import { sessionTitle } from "./session-list";
import { agentName, discovery, type Session, sessionDirectory, sessionIdentity } from "./sessions";
import { tilde } from "./tui";
import { checkout } from "./workdir";

export const editsUsage = `usage: kiln edits [name] [--json]     what each prompt changed: files and lines added and removed
       kiln edits --follow                 every new edit by any session, one JSON object per line
       kiln blame <file> [--json]          which session and prompt wrote each line of a file`;

async function localSessions(): Promise<Session[]> {
  return (await discovery()({ kitty: false })).sessions.filter(
    (session) => session.id && session.place.kind !== "cloud",
  );
}

/** A name or a prefix of one that matches a single session, stopped ones included. */
function named(sessions: readonly Session[], name: string): Session {
  const exact = sessions.find((session) => sessionIdentity(session) === name);
  if (exact) return exact;
  const matches = sessions.filter(
    (session) => sessionIdentity(session).startsWith(name) || session.id?.startsWith(name),
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (!matches.length) throw new Error(`no session is called ${name}; run kiln msg list`);
  throw new Error(`${name} matches ${matches.map(sessionIdentity).join(", ")}; give more of the name`);
}

const ago = (time: number | undefined, now = Date.now()) => {
  if (!time) return "";
  const minutes = Math.floor((now - time) / 60_000);
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
};

const firstLine = (text: string, width: number) => {
  const line = text.split("\n")[0] ?? "";
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
};

/** One edit as a line of the follow stream. */
function editRecord(session: Session, ledger: Ledger, edit: FileEdit) {
  return {
    session: sessionIdentity(session),
    agent: session.agent,
    title: sessionTitle(session),
    prompt: ledger.turns[edit.turn]?.prompt,
    ...edit,
  };
}

export async function runEditsCli(command: "edits" | "blame", args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean" }, follow: { type: "boolean" } },
  });
  const read = ledgers();
  if (command === "blame") {
    const [given] = positionals;
    if (!given || positionals.length > 1 || values.follow) throw new Error(editsUsage);
    const absolute = resolve(given);
    let file = absolute;
    try {
      file = realpathSync(absolute);
    } catch {
      // A path that does not resolve is looked up as written.
    }
    const lines = splitLines(readFileSync(file, "utf8"));
    const history = fileHistory(await localSessions(), (session) => read.of(session), file);
    const owners = blame(lines, history);
    if (values.json) {
      console.log(
        JSON.stringify(
          lines.map((text, index) => {
            const owned = owners[index];
            return {
              line: index + 1,
              text,
              session: owned && sessionIdentity(owned.owner.session),
              prompt: owned?.owner.turn?.prompt,
              at: owned?.edit.at,
            };
          }),
        ),
      );
      return;
    }
    const width = String(lines.length).length;
    lines.forEach((text, index) => {
      const owned = owners[index];
      const who = owned
        ? `${sessionIdentity(owned.owner.session).slice(0, 15).padEnd(15)} ${ago(owned.edit.at).padStart(3)} ${firstLine(owned.owner.turn?.prompt ?? "", 24).padEnd(24)}`
        : " ".repeat(44);
      console.log(`${who} ${String(index + 1).padStart(width)}│${text}`);
    });
    return;
  }
  if (values.follow) {
    if (positionals.length || values.json) throw new Error(editsUsage);
    // Edits already made are the baseline; only ones made from now on are printed.
    const seen = new Set<string>();
    let first = true;
    for (;;) {
      for (const session of await localSessions()) {
        const ledger = read.of(session);
        for (const edit of ledger.edits) {
          const key = `${sessionIdentity(session)}:${edit.id}:${edit.file}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!first) console.log(JSON.stringify(editRecord(session, ledger, edit)));
        }
      }
      first = false;
      await Bun.sleep(2_000);
    }
  }
  if (positionals.length > 1) throw new Error(editsUsage);
  const all = await localSessions();
  const me = callerIdentity();
  const here = checkout(process.cwd());
  const chosen = positionals[0]
    ? [named(all, positionals[0])]
    : me && all.some((session) => sessionIdentity(session) === me)
      ? all.filter((session) => sessionIdentity(session) === me)
      : all.filter((session) => here && checkout(sessionDirectory(session)) === here);
  if (!chosen.length) throw new Error("no session works in this checkout; name one, as kiln msg list shows");
  const report = chosen.map((session) => ({ session, turns: turnSummaries(read.of(session)) }));
  if (values.json) {
    console.log(
      JSON.stringify(
        report.map(({ session, turns }) => ({
          session: sessionIdentity(session),
          title: sessionTitle(session),
          turns,
        })),
      ),
    );
    return;
  }
  for (const { session, turns } of report) {
    console.log(
      `${sessionIdentity(session)}  ${agentName(session.agent)}  ${sessionTitle(session)}  ${tilde(sessionDirectory(session))}`,
    );
    if (!turns.length) console.log("  no edits");
    for (const turn of turns) {
      console.log(
        `  ${ago(turn.at).padStart(3)}  ${firstLine(turn.prompt || "(before the first prompt)", 72)}  ${turn.files.length} files ${lineCounts(turn)}`,
      );
      for (const file of turn.files)
        console.log(`         ${tilde(file.file)}  ${fileChange(file)}${lineCounts(file)}`);
    }
  }
}
