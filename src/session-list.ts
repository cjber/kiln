import { basename } from "node:path";
import { type SessionSort, sortSessions } from "./session-sort";
import type { Session } from "./sessions";

export function sessionKey(session: Session): string {
  if (session.pid !== undefined) return `pid:${session.pid}`;
  switch (session.place.kind) {
    case "cloud":
    case "background":
      return `${session.agent}:${session.place.kind}:${session.place.id}`;
    case "kiln":
      return `kiln:${session.place.name}`;
    case "kitty":
      return `kitty:${session.place.socket}:${session.place.windowId}`;
    case "elsewhere":
      return `${session.agent}:${session.cwd}`;
  }
}

export function sessionTitle(session: Session): string {
  const title = session.place.kind === "cloud" ? session.place.title : session.title;
  return (
    title?.replace(/\s+/g, " ").trim() || session.id || `${session.agent}${session.pid ? ` · pid ${session.pid}` : ""}`
  );
}

export type ListRow =
  | { kind: "header"; key: string; name: string; directory?: string }
  | { kind: "session"; key: string; session: Session; depth: number; children: number };

/** Unopenable children stay reachable through their visible parent; unopenable roots stay hidden. */
export function sessionRows(
  sessions: readonly Session[],
  order: SessionSort,
  filter: string,
  expanded: ReadonlySet<string>,
): ListRow[] {
  const ordered = sortSessions(sessions, order);
  const byPid = new Map(
    ordered.filter((session) => session.pid !== undefined).map((session) => [session.pid, session]),
  );
  const canShow = (session: Session, seen = new Set<Session>()): boolean => {
    if (session.place.kind !== "elsewhere") return true;
    if (seen.has(session)) return false;
    seen.add(session);
    const parent = byPid.get(session.parentSessionPid);
    return parent !== undefined && canShow(parent, seen);
  };
  const eligible = ordered.filter((session) => canShow(session));
  const parents = new Map(
    eligible.map((session) => [
      session,
      eligible.find((parent) => parent.pid !== undefined && parent.pid === session.parentSessionPid),
    ]),
  );
  const children = (session: Session) => eligible.filter((child) => parents.get(child) === session);
  const needle = filter.trim().toLowerCase();
  const matches = (session: Session): boolean =>
    !needle ||
    `${sessionTitle(session)} ${session.agent} ${session.cwd} ${session.branch ?? ""} ${session.activity ?? ""} ${session.place.kind}`
      .toLowerCase()
      .includes(needle);
  const matching = new Set(eligible.filter(matches));
  for (const session of [...matching]) {
    const seen = new Set<Session>();
    for (let parent = parents.get(session); parent && !seen.has(parent); parent = parents.get(parent)) {
      seen.add(parent);
      matching.add(parent);
    }
  }
  const roots = eligible.filter((session) => !parents.get(session) && matching.has(session));
  const grouped = order === "project" || order === "directory";
  const groups = new Map<string, Session[]>();
  for (const root of roots) {
    const key = grouped
      ? root.place.kind === "cloud"
        ? `task:${root.agent}:${root.place.id}`
        : `dir:${root.cwd}`
      : "all";
    const group = groups.get(key) ?? [];
    group.push(root);
    groups.set(key, group);
  }
  const rows: ListRow[] = [];
  const seen = new Set<Session>();
  const append = (session: Session, depth: number) => {
    if (seen.has(session) || !matching.has(session)) return;
    seen.add(session);
    const descendants = children(session).filter((child) => matching.has(child));
    rows.push({ kind: "session", key: sessionKey(session), session, depth, children: descendants.length });
    if (expanded.has(sessionKey(session)) || needle) for (const child of descendants) append(child, depth + 1);
  };
  for (const [key, group] of groups) {
    const first = group[0];
    if (!first) continue;
    if (grouped)
      rows.push({
        kind: "header",
        key,
        name: first.place.kind === "cloud" ? first.place.title : basename(first.cwd) || first.cwd,
        directory: first.place.kind === "cloud" ? undefined : first.cwd,
      });
    for (const session of group) append(session, 0);
  }
  return rows;
}
