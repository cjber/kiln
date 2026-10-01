import { acpRequest } from "./acp-host";
import type { Session } from "./sessions";
export type SessionAction = { verb: "close" } | { reason: string };
export function sessionAction(session: Session): SessionAction {
  return session.place.kind === "acp"
    ? { verb: "close" }
    : { reason: "cloud tasks are read-only and cannot be closed here" };
}
export async function runSessionAction(session: Session): Promise<true | string> {
  const action = sessionAction(session);
  if ("reason" in action) return action.reason;
  if (session.place.kind !== "acp") return "this session is not managed by kiln";
  try {
    await acpRequest(`/sessions/${session.place.id}/close`, {});
    return true;
  } catch (error) {
    return `could not close ${session.agent}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
