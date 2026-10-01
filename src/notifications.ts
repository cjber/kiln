import type { Session } from "./sessions";

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
