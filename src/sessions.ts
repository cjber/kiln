import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { claudeCloudSnapshot } from "./claude-cloud";
import { cloudSnapshot } from "./cloud";

export type Agent = "claude" | "codex" | "pi";

export const agents: readonly Agent[] = ["claude", "codex", "pi"];

/** What a session is doing, as far as anyone can tell: `waiting` means it stopped to ask you something. */
export type Activity = "working" | "waiting" | "idle";

export type Place =
  | { kind: "acp"; id: string }
  | { kind: "kiln"; name: string }
  | { kind: "kitty"; socket: string; windowId: number }
  | { kind: "background"; id: string; attach: string[]; stop?: string[] }
  | { kind: "elsewhere"; source?: string }
  | { kind: "cloud"; id: string; title: string; url?: string };

export type Session = {
  /** Provider identity and display name, when reported. */
  id?: string;
  title?: string;
  /** The agent's process; a Codex daemon thread has none of its own. */
  pid?: number;
  /** The live kiln session whose agent spawned this process. */
  parentSessionPid?: number;
  parentSessionId?: string;
  agent: Agent;
  cwd: string;
  startedAt: number;
  /** Last provider or transcript update, when available. */
  lastActiveAt?: number;
  /** Agent-reported status; terminal output never establishes activity. */
  activity?: Activity;
  /** The branch checked out in `cwd`, or a short commit when HEAD is detached. */
  branch?: string;
  place: Place;
};

export function gitBranch(cwd: string): string | undefined {
  try {
    for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
      const dotGit = join(dir, ".git");
      if (!existsSync(dotGit)) continue;
      // A linked worktree's `.git` is a file pointing at its real git directory.
      const gitDir = statSync(dotGit).isFile()
        ? resolve(
            dir,
            readFileSync(dotGit, "utf8")
              .replace(/^gitdir:\s*/, "")
              .trim(),
          )
        : dotGit;
      const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
    }
  } catch {
    // An unreadable repository just has no branch to show.
  }
  return undefined;
}

export async function listSessions({
  cloud = false,
  claudeCloud = false,
  native = true,
  kitty = true,
} = {}): Promise<Session[]> {
  const { acpRequest } = await import("./acp-host");
  const { listNativeSessions } = await import("./native-sessions");
  const owned = await acpRequest<Session[]>("/sessions");
  const observed = native
    ? await listNativeSessions({ kitty, excludedPids: owned.flatMap((row) => (row.pid ? [row.pid] : [])) })
    : [];
  return nestSessions(
    [
      ...owned.map((session) => ({ ...session, branch: gitBranch(session.cwd) })),
      ...observed,
      ...(cloud ? cloudSnapshot().sessions : []),
      ...(cloud && claudeCloud ? claudeCloudSnapshot().sessions : []),
    ].sort((left, right) => left.cwd.localeCompare(right.cwd) || left.startedAt - right.startedAt),
  );
}

export function sessionParents(sessions: readonly Session[], queried?: Session): Map<Session, Session | undefined> {
  const candidates = queried && !sessions.includes(queried) ? [...sessions, queried] : sessions;
  const ids = new Map<string, Session[]>();
  const pids = new Map<number, Session[]>();
  for (const session of sessions) {
    if (session.id !== undefined) {
      const key = `${session.agent}:${session.id}`;
      const group = ids.get(key) ?? [];
      group.push(session);
      ids.set(key, group);
    }
    if (session.pid !== undefined) {
      const group = pids.get(session.pid) ?? [];
      group.push(session);
      pids.set(session.pid, group);
    }
  }
  const parents = new Map<Session, Session | undefined>();
  for (const session of candidates) {
    const provider =
      session.parentSessionId === undefined
        ? undefined
        : ids.get(`${session.agent}:${session.parentSessionId}`)?.find((parent) => parent !== session);
    const process =
      session.parentSessionPid === undefined
        ? undefined
        : pids.get(session.parentSessionPid)?.find((parent) => parent !== session);
    parents.set(session, provider ?? process);
  }
  const valid = new Map<Session, boolean>();
  for (const session of candidates) {
    const path = new Set<Session>();
    let ancestor: Session | undefined = session;
    while (ancestor && !valid.has(ancestor) && !path.has(ancestor)) {
      path.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    const accepted = ancestor === undefined || valid.get(ancestor) === true;
    for (const member of path) valid.set(member, accepted);
  }
  for (const session of candidates) if (!valid.get(session)) parents.set(session, undefined);
  return parents;
}

/** Provider relationships survive daemon execution, where children have no terminal PID. */
export function sessionParent(session: Session, sessions: readonly Session[]): Session | undefined {
  return sessionParents(sessions, session).get(session);
}

/** Keep children directly beneath their parent, preserving the order within each group. */
export function nestSessions(sessions: readonly Session[]): Session[] {
  const parents = sessionParents(sessions);
  const children = new Map<Session | undefined, Session[]>();
  for (const session of sessions) {
    const parent = parents.get(session);
    const group = children.get(parent) ?? [];
    group.push(session);
    children.set(parent, group);
  }
  const result: Session[] = [];
  const seen = new Set<Session>();
  const pending = [...(children.get(undefined) ?? [])].reverse();
  while (pending.length) {
    const session = pending.pop();
    if (!session || seen.has(session)) continue;
    seen.add(session);
    result.push(session);
    const descendants = children.get(session) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) {
      const child = descendants[index];
      if (child) pending.push(child);
    }
  }
  return result;
}

/** The status bar's right side: only the counts that are non-zero, working first. */
export function summarise(sessions: readonly Session[]): string {
  const count = (activity: Activity) => sessions.filter((session) => session.activity === activity).length;
  const parts = (["working", "waiting", "idle"] as const).flatMap((activity) =>
    count(activity) ? [`${count(activity)} ${activity}`] : [],
  );
  return parts.length ? parts.join(" · ") : `${sessions.length} sessions`;
}
