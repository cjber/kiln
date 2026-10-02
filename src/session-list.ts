import { basename } from "node:path";
import { type SessionSort, sortSessions } from "./session-sort";
import { type Session, sessionIdentity, sessionParents } from "./sessions";

export function sessionTitle(session: Session): string {
  const title = session.place.kind === "cloud" ? session.place.title : session.title;
  return (
    title?.replace(/\s+/g, " ").trim() || session.id || `${session.agent}${session.pid ? ` · pid ${session.pid}` : ""}`
  );
}

export type Tone = "active" | "attention" | "done" | "muted";

/** What a session is doing, in the words and emphasis every view shows. The filter matches the label. */
export function sessionStatus(session: Session): { label: string; hint: string; tone: Tone } {
  switch (session.lifecycle) {
    case "completed":
      return { label: "completed", hint: "finished · Enter attaches", tone: "done" };
    case "stopped":
      return { label: "stopped", hint: "stopped · Enter resumes", tone: "muted" };
    case undefined:
      break;
  }
  switch (session.activity) {
    case "working":
      return { label: "working", hint: "working", tone: "active" };
    case "waiting":
      return { label: "needs input", hint: "needs your input", tone: "attention" };
    case "idle":
      return { label: "ready", hint: "ready for a prompt", tone: "done" };
    case undefined:
      return {
        label: "unknown",
        hint: session.place.kind === "acp" ? "ACP connection lost" : "status unavailable from provider",
        tone: "muted",
      };
  }
}

export type ListRow =
  | { kind: "header"; key: string; name: string; directory?: string }
  | { kind: "session"; key: string; session: Session; depth: number; children: number };

/** Group sessions and reveal matching or expanded children beneath their parent. */
export function sessionRows(
  sessions: readonly Session[],
  order: SessionSort,
  filter: string,
  expanded: ReadonlySet<string>,
): ListRow[] {
  const ordered = sortSessions(sessions, order);
  const parents = sessionParents(ordered);
  const children = new Map<Session, Session[]>();
  for (const session of ordered) {
    const parent = parents.get(session);
    if (!parent) continue;
    const group = children.get(parent) ?? [];
    group.push(session);
    children.set(parent, group);
  }
  const needle = filter.trim().toLowerCase();
  const matches = (session: Session): boolean =>
    !needle ||
    `${sessionTitle(session)} ${session.agent} ${session.cwd} ${session.branch ?? ""} ${session.lifecycle ?? session.activity ?? ""} ${sessionStatus(session).label} ${session.place.kind}`
      .toLowerCase()
      .includes(needle);
  const matching = new Set(ordered.filter(matches));
  if (needle)
    for (const session of [...matching]) {
      for (let parent = parents.get(session); parent && !matching.has(parent); parent = parents.get(parent)) {
        matching.add(parent);
      }
    }
  const roots = ordered.filter((session) => !parents.get(session) && matching.has(session));
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
      const key = sessionIdentity(session);
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

/** The rows a cursor can rest on; selection is an index into this. */
export function visibleSessions(rows: readonly ListRow[]): Session[] {
  return rows.flatMap((row) => (row.kind === "session" ? [row.session] : []));
}

/** The cursor follows a session by identity; `index` is where it rests when that session is gone. */
export type Selection = { key?: string; index: number };

export function selectionAt(visible: readonly Session[], index: number): Selection {
  const clamped = Math.max(0, Math.min(visible.length - 1, index));
  const session = visible[clamped];
  return { key: session && sessionIdentity(session), index: clamped };
}

export function resolveSelection(visible: readonly Session[], selection: Selection): Selection {
  const found = selection.key === undefined ? -1 : visible.findIndex((row) => sessionIdentity(row) === selection.key);
  return selectionAt(visible, found >= 0 ? found : selection.index);
}
