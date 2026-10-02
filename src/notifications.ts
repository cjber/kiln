import { type Session, sessionIdentity } from "./sessions";

/** Notify only observed native transitions; missing sessions and unknown states reset tracking. */
export function nativeNotifications(send = notifySessionEvent) {
  let previous = new Map<string, Session["activity"]>();
  return (sessions: readonly Session[], enabled: boolean) => {
    const next = new Map<string, Session["activity"]>();
    for (const session of sessions) {
      if (session.place.kind === "cloud" || session.place.kind === "acp") continue;
      const key = sessionIdentity(session);
      if (enabled && previous.get(key) === "working" && (session.activity === "idle" || session.activity === "waiting"))
        send(session);
      next.set(key, session.activity);
    }
    previous = enabled ? next : new Map();
  };
}

export function notifySessionEvent(session: Session): void {
  const command = Bun.which("notify-send");
  if (!command) return;
  try {
    const child = Bun.spawn(
      [
        command,
        "--app-name=kiln",
        "--",
        `${session.title || `${session.agent} session`} · ${session.activity === "waiting" ? "Needs input" : "Turn finished"}`,
        `${session.agent} · ${session.cwd}`.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const timeout = setTimeout(() => child.kill(), 5_000);
    void child.exited.finally(() => clearTimeout(timeout));
  } catch {
    // Desktop notifications are optional, including on machines without a notification service.
  }
}
