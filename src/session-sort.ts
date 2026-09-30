import { basename } from "node:path";
import { nestSessions, type Session } from "./sessions";

export const sessionSorts = ["last_active", "age", "harness", "directory", "project"] as const;
export type SessionSort = (typeof sessionSorts)[number];

export function sortSessions(sessions: readonly Session[], order: SessionSort): Session[] {
  const compare = (left: Session, right: Session): number => {
    switch (order) {
      case "last_active":
        return (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0);
      case "age":
        return left.startedAt - right.startedAt;
      case "harness":
        return left.agent.localeCompare(right.agent);
      case "directory":
        return left.cwd.localeCompare(right.cwd);
      case "project":
        return basename(left.cwd).localeCompare(basename(right.cwd));
    }
  };
  return nestSessions(
    [...sessions].sort(
      (left, right) => compare(left, right) || left.cwd.localeCompare(right.cwd) || left.startedAt - right.startedAt,
    ),
  );
}
