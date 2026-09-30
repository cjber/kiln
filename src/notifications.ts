import type { Session } from "./sessions";

/** Silence, approval pauses and disappearing sessions are not evidence of a completed turn. */
export function turnNotifications(send: (session: Session) => void = notifyTurnEnded) {
  let working = new Set<string>();
  return (sessions: readonly Session[], enabled: boolean) => {
    const next = new Set<string>();
    for (const session of sessions) {
      if (session.place.kind === "cloud") continue;
      const key = session.id
        ? `${session.agent}:id:${session.id}`
        : session.pid !== undefined
          ? `${session.agent}:${session.pid}:${session.startedAt}`
          : session.place.kind === "background"
            ? `${session.agent}:id:${session.place.id}`
            : undefined;
      if (!key) continue;
      if (session.activity === "idle") {
        if (enabled && working.has(key)) send(session);
      } else if (enabled && (session.activity === "working" || working.has(key))) {
        next.add(key);
      }
    }
    working = next;
  };
}

function notifyTurnEnded(session: Session): void {
  const command = Bun.which("notify-send");
  if (!command) return;
  try {
    const child = Bun.spawn(
      [
        command,
        "--app-name=kiln",
        "--",
        `${session.agent} turn finished`,
        session.cwd.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const timeout = setTimeout(() => child.kill(), 5_000);
    void child.exited.finally(() => clearTimeout(timeout));
  } catch {
    // Desktop notifications are optional, including on machines without a notification service.
  }
}
