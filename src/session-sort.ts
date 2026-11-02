import { basename } from "node:path";
import { nestSessions, type Session, sessionDirectory } from "./sessions";

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
        return (left.place.kind === "cloud" ? left.place.title : sessionDirectory(left)).localeCompare(
          right.place.kind === "cloud" ? right.place.title : sessionDirectory(right),
        );
      case "project":
        return (left.place.kind === "cloud" ? left.place.title : basename(sessionDirectory(left))).localeCompare(
          right.place.kind === "cloud" ? right.place.title : basename(sessionDirectory(right)),
        );
    }
  };
  return nestSessions(
    [...sessions].sort(
      (left, right) =>
        compare(left, right) ||
        (order === "directory" || order === "project" ? (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0) : 0) ||
        sessionDirectory(left).localeCompare(sessionDirectory(right)) ||
        left.startedAt - right.startedAt,
    ),
  );
}
