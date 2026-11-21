import { agentName, type Session, sessionDirectory, sessionIdentity } from "./sessions";

/** Notify only observed native transitions; missing sessions and unknown states reset tracking. */
export function nativeNotifications(send = notifySessionEvent) {
  let previous = new Map<string, Session["activity"]>();
  return (sessions: readonly Session[], enabled: boolean) => {
    const next = new Map<string, Session["activity"]>();
    for (const session of sessions) {
      if (session.place.kind === "cloud") continue;
      const key = sessionIdentity(session);
      if (enabled && previous.get(key) === "working" && (session.activity === "idle" || session.activity === "waiting"))
        send(session);
      next.set(key, session.activity);
    }
    previous = enabled ? next : new Map();
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
