import { archiveCodexThread } from "./codex";
import type { Session } from "./sessions";
import { kill } from "./tmux";

export type SessionAction = { verb: "close" | "archive" } | { reason: string };

/** The confirmation and execution use the same capability check. */
export function sessionAction(session: Session): SessionAction {
  switch (session.place.kind) {
    case "kiln":
      return { verb: "close" };
    case "background":
      if (session.agent === "codex") return { verb: "archive" };
      return session.place.stop
        ? { verb: "close" }
        : { reason: `${session.agent} cannot stop this session from outside; open it and quit there` };
    case "cloud":
      return { reason: "cloud tasks are read-only and cannot be closed here" };
    case "kitty":
    case "elsewhere":
      return session.pid === undefined ? { reason: `${session.agent} has no process to close` } : { verb: "close" };
  }
}

export async function runSessionAction(session: Session): Promise<true | string> {
  const action = sessionAction(session);
  if ("reason" in action) return action.reason;
  try {
    switch (session.place.kind) {
      case "kiln":
        return kill(session.place.name) || `could not close kiln session ${session.place.name}`;
      case "background": {
        if (action.verb === "archive") {
          await archiveCodexThread(session.place.id);
          return true;
        }
        const command = session.place.stop;
        if (!command) return "this session has no stop command";
        const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
        const error = await new Response(child.stderr).text();
        return (await child.exited) === 0 || error.trim() || `${command.join(" ")} failed`;
      }
      case "kitty":
      case "elsewhere":
        if (session.pid === undefined) return "this session has no process to close";
        return process.kill(session.pid, "SIGTERM");
      case "cloud":
        return "cloud tasks are read-only and cannot be closed here";
    }
  } catch (error) {
    return `could not ${action.verb} ${session.agent}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
