import { basename } from "node:path";
import { type SessionSort, sortSessions } from "./session-sort";
import { type Session, sessionParents } from "./sessions";

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
  const allParents = sessionParents(ordered);
  const shown = new Map<Session, boolean>();
  const canShow = (session: Session): boolean => {
    const path: Session[] = [];
    let parent: Session | undefined = session;
    while (parent && parent.place.kind === "elsewhere" && !shown.has(parent)) {
      path.push(parent);
      parent = allParents.get(parent);
    }
    const visible = parent !== undefined && (shown.get(parent) ?? true);
    for (const child of path) shown.set(child, visible);
    return visible;
  };
  const eligible = ordered.filter(canShow);
  const parents = sessionParents(eligible);
  const children = new Map<Session, Session[]>();
  for (const session of eligible) {
    const parent = parents.get(session);
    if (!parent) continue;
    const group = children.get(parent) ?? [];
    group.push(session);
    children.set(parent, group);
  }
  const needle = filter.trim().toLowerCase();
  const matches = (session: Session): boolean =>
    !needle ||
    `${sessionTitle(session)} ${session.agent} ${session.cwd} ${session.branch ?? ""} ${session.activity ?? ""} ${session.place.kind}`
      .toLowerCase()
      .includes(needle);
  const matching = new Set(eligible.filter(matches));
  if (needle)
    for (const session of [...matching]) {
      for (let parent = parents.get(session); parent && !matching.has(parent); parent = parents.get(parent)) {
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
  const append = (root: Session) => {
    const pending = [{ session: root, depth: 0 }];
    while (pending.length) {
      const item = pending.pop();
      if (!item) continue;
      const { session, depth } = item;
      if (seen.has(session) || !matching.has(session)) continue;
      seen.add(session);
      const descendants = (children.get(session) ?? []).filter((child) => matching.has(child));
      const key = sessionKey(session);
      rows.push({ kind: "session", key, session, depth, children: descendants.length });
      if (!expanded.has(key) && !needle) continue;
      for (let index = descendants.length - 1; index >= 0; index--) {
        const child = descendants[index];
        if (child) pending.push({ session: child, depth: depth + 1 });
      }
    }
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
    for (const session of group) append(session);
  }
  return rows;
}
