import type { Session } from "./sessions";
export type Handoff = { url: string; label: string; exact: boolean } | { reason: string };
export function phoneHandoff(session: Session): Handoff {
  if (session.place.kind === "cloud")
    return session.place.url
      ? { url: session.place.url, label: "Open task", exact: true }
      : { reason: "This task has no verified link" };
  return {
    reason:
      session.place.kind === "acp" ? "Read and control this session in kiln" : "This session is not managed by kiln",
  };
}
