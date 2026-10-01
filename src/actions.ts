import { acpRequest } from "./acp-host";
import { archiveCodexThread } from "./codex";
import type { Session } from "./sessions";
import { kill } from "./tmux";
export type SessionAction = { verb: "close" | "archive" } | { reason: string };
export function sessionAction(session: Session): SessionAction {
  switch (session.place.kind) {
    case "acp":
    case "kiln":
      return { verb: "close" };
    case "background":
      if (session.place.acpId) return { verb: "close" };
      return session.agent === "codex"
        ? { verb: "archive" }
        : session.place.stop
          ? { verb: "close" }
          : { reason: "Close this session in its native terminal" };
    case "kitty":
    case "elsewhere":
      return { reason: "Close this session in its native terminal" };
    case "cloud":
      return { reason: "cloud tasks are read-only and cannot be closed here" };
  }
}
export async function runSessionAction(session: Session): Promise<true | string> {
  const action = sessionAction(session);
  if ("reason" in action) return action.reason;
  try {
    switch (session.place.kind) {
      case "acp":
        await acpRequest(`/sessions/${session.place.id}/close`, {});
        break;
      case "kiln":
        if (!kill(session.place.name)) throw new Error("tmux could not close this session");
        break;
      case "background":
        if (session.place.acpId) await acpRequest(`/sessions/${session.place.acpId}/close`, {});
        else if (session.agent === "codex") await archiveCodexThread(session.place.id);
        else if (session.place.stop) {
          const child = Bun.spawn(session.place.stop, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
          if (await child.exited) throw new Error("provider could not stop this session");
        }
        break;
      default:
        return "this session is not managed by kiln";
    }
    return true;
  } catch (error) {
    return `could not close ${session.agent}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
