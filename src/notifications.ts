import { reportTurnEnd } from "./messages";
import { agentName, type Session, sessionDirectory, sessionIdentity, sessionParents } from "./sessions";

/** Whether a session's own turn runs: working, and not only through a background shell, subagent or child. */
const turnRunning = (session: Session) => session.activity === "working" && !session.turnEnded;

/**
 * The sessions whose own turn ended since the last call, from the agents' reported status. Background work or a
 * child finishing after the turn ended is not a turn ending. A session first seen, or one whose status is unknown,
 * resets its tracking, so a restart or a failed listing reports nothing.
 */
export function turnEnds() {
  let previous = new Map<string, boolean>();
  return (sessions: readonly Session[]): Session[] => {
    const next = new Map<string, boolean>();
    const ended: Session[] = [];
    for (const session of sessions) {
      if (session.place.kind === "cloud" || session.lifecycle || session.activity === undefined) continue;
      const key = sessionIdentity(session);
      const running = turnRunning(session);
      if (previous.get(key) && !running) ended.push(session);
      next.set(key, running);
    }
    previous = next;
    return ended;
  };
}

/**
 * Act on observed turn ends. A session kiln nests under a parent reports to that parent, which started it and waits on
 * it; only a top-level session tells the person, and only while notifications are on.
 */
export function nativeNotifications(
  send = notifySessionEvent,
  report: (child: Session, parent: Session) => unknown = reportTurnEnd,
) {
  const ends = turnEnds();
  return (sessions: readonly Session[], enabled: boolean) => {
    const ended = ends(sessions);
    if (!ended.length) return;
    const parents = sessionParents(sessions);
    for (const session of ended) {
      const parent = parents.get(session);
      if (parent) report(session, parent);
      else if (enabled) send(session);
    }
  };
}

/**
 * The notification server's category for each kind of kiln notification, so a desktop can give each its own
 * sound or style (mako matches `[app-name=kiln category=kiln.needs-input]`).
 */
export type NotificationCategory = "kiln.needs-input" | "kiln.turn-finished" | "kiln.usage";

export function notifySessionEvent(session: Session): void {
  const waiting = session.activity === "waiting";
  notify(
    waiting ? "kiln.needs-input" : "kiln.turn-finished",
    `${session.title || `${agentName(session.agent)} session`} · ${waiting ? "Needs input" : "Turn finished"}`,
    `${agentName(session.agent)} · ${sessionDirectory(session)}`,
  );
}

/** A desktop notification from kiln; `body` is plain text. */
export function notify(category: NotificationCategory, summary: string, body = ""): void {
  const command = Bun.which("notify-send");
  if (!command) return;
  try {
    const child = Bun.spawn(
      [
        command,
        "--app-name=kiln",
        `--category=${category}`,
        "--",
        summary,
        body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const timeout = setTimeout(() => child.kill(), 5_000);
    void child.exited.finally(() => clearTimeout(timeout));
  } catch {
    // Desktop notifications are optional, including on machines without a notification service.
  }
}
