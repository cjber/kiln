import { existsSync } from "node:fs";
import { type Session, sessionIdentity, sessionParents } from "./sessions";

/**
 * Act on children whose parent has exited. An idle child, with no turn running and nothing waiting on an answer, has
 * nobody left to read its work and is closed, freeing its memory. A working or waiting child is handed to its
 * grandparent when there is one, and otherwise left running for the person. A parent counts as exited only when its
 * process is gone, so a listing that missed it for a moment closes nothing. Each orphan is acted on once.
 */
export function orphanedChildren(
  close: (child: Session) => unknown,
  report: (child: Session, parent: Session, grandparent: Session) => unknown,
  alive: (pid: number) => boolean = (pid) => existsSync(`/proc/${pid}`),
) {
  let previous = new Map<string, { parent: Session; grandparent?: Session }>();
  return (sessions: readonly Session[]): void => {
    const present = new Map(sessions.map((session) => [sessionIdentity(session), session]));
    const next = new Map<string, { parent: Session; grandparent?: Session }>();
    for (const [child, { parent, grandparent }] of previous) {
      const orphan = present.get(child);
      if (!orphan || present.has(sessionIdentity(parent)) || parent.pid === undefined) continue;
      // Missing from this listing but still running: keep watching it under the parent it had.
      if (alive(parent.pid)) {
        next.set(child, { parent, grandparent });
        continue;
      }
      if (orphan.activity === "idle") close(orphan);
      else if (orphan.activity !== undefined && grandparent && present.has(sessionIdentity(grandparent)))
        report(orphan, parent, grandparent);
    }
    const parents = sessionParents(sessions);
    for (const session of sessions) {
      const parent = parents.get(session);
      if (parent) next.set(sessionIdentity(session), { parent, grandparent: parents.get(parent) });
    }
    previous = next;
  };
}
