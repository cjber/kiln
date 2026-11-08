import type { Ledger } from "./edits";
import { post } from "./mailbox";
import { autopilotSender, reachable } from "./messages";
import { sessionTitle } from "./session-list";
import { type Session, sessionIdentity } from "./sessions";
import { tilde } from "./tui";

/** One warning for one recipient; `key` names the pair of turns and the file, so it is sent once. */
export type Collision = { to: Session; other: Session; file: string; key: string };

/** The files a session edited while answering its latest prompt: the work it has not handed back yet. */
function current(ledger: Ledger): Set<string> {
  const turn = ledger.turns.length - 1;
  return new Set(ledger.edits.filter((edit) => edit.turn === turn).map((edit) => edit.file));
}

/**
 * Two running sessions editing one file. A collision is a new edit by one session to a file another running session
 * edited while answering its own latest prompt; both hear about it, once per file and pair of turns. Edits a session
 * had made before kiln first read it are history, and warn nobody.
 */
export function collisionWatch() {
  const seen = new Map<string, number>();
  return (sessions: readonly Session[], read: (session: Session) => Ledger): Collision[] => {
    const live = sessions.filter(reachable);
    const ledgers = new Map(live.map((session) => [session, read(session)]));
    const found: Collision[] = [];
    for (const [session, ledger] of ledgers) {
      const name = sessionIdentity(session);
      const from = seen.get(name);
      seen.set(name, ledger.edits.length);
      if (from === undefined) continue;
      for (const edit of ledger.edits.slice(from))
        for (const [other, theirs] of ledgers) {
          if (other === session || !current(theirs).has(edit.file)) continue;
          const pair = [`${name}#${edit.turn}`, `${sessionIdentity(other)}#${theirs.turns.length - 1}`]
            .sort()
            .join("+");
          for (const [to, from] of [
            [session, other],
            [other, session],
          ] as const)
            found.push({ to, other: from, file: edit.file, key: `edits:${edit.file}:${pair}:${sessionIdentity(to)}` });
        }
    }
    for (const name of seen.keys()) if (!live.some((session) => sessionIdentity(session) === name)) seen.delete(name);
    return found;
  };
}

/** What a session is told about another one editing the same file. */
export function collisionMessage({ other, file }: Collision): string {
  const name = sessionIdentity(other);
  return (
    `${name} (${sessionTitle(other)}) is also editing ${tilde(file)}, which you changed for your current prompt. ` +
    `Read \`git diff -- ${file}\` before you commit, revert or reformat it, and agree who changes what with ` +
    `\`kiln msg send ${name} "..."\`.`
  );
}

/** Post each collision once under its key; returns how many were posted. */
export function warn(collisions: readonly Collision[], send: typeof post = post): number {
  let posted = 0;
  for (const collision of collisions)
    try {
      send(
        autopilotSender,
        sessionIdentity(collision.to),
        collisionMessage(collision),
        undefined,
        undefined,
        collision.key,
      );
      posted++;
    } catch {
      // A full mailbox or a send limit drops this warning; the next new edit to the file can raise it again.
    }
  return posted;
}
