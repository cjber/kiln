import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { claudeCloudSnapshot } from "./claude-cloud";
import { cloudSnapshot } from "./cloud";

export type Agent = "claude" | "codex" | "pi";

export const agents: readonly Agent[] = ["claude", "codex", "pi"];

/** What a session is doing, as far as anyone can tell: `waiting` means it stopped to ask you something. */
export type Activity = "working" | "waiting" | "idle";

/** How a background job ended. A finished job reports no activity. */
export type Lifecycle = "completed" | "stopped";

export type Place =
  | { kind: "acp"; id: string }
  | { kind: "kiln"; name: string }
  | { kind: "kitty"; socket: string; windowId: number }
  /** A Claude background job, running or finished; `attach` gives it a terminal. */
  | { kind: "job"; id: string; attach: string[]; stop?: string[] }
  /** A Codex daemon thread with no terminal of its own. */
  | { kind: "thread"; id: string; attach: string[] }
  /** A conversation kiln's ACP host held; `acpId` while it still does, otherwise a recovery record. */
  | { kind: "saved"; id: string; attach: string[]; acpId?: string }
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
  lifecycle?: Lifecycle;
  /** The branch checked out in `cwd`, or a short commit when HEAD is detached. */
  branch?: string;
  place: Place;
};

/**
 * One name for a session everywhere: the list cursor, phone rows and notifications. Provider identity
 * outlives the process; a session without one is known by its process and start time.
 */
export function sessionIdentity(session: Session): string {
  return `${session.agent}:${session.place.kind === "cloud" ? session.place.id : (session.id ?? `${session.pid}:${session.startedAt}`)}`;
}

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

export type Discovered = {
  sessions: Session[];
  /** Why the list may be out of date, in words safe to show; empty when it is not. */
  problem: string;
  /** Some rows are the last successful ones rather than a fresh observation. */
  stale: boolean;
};

/** While a source is failing, keep its last rows with their activity unknown rather than dropping or guessing. */
export function keepLast<A extends unknown[]>(
  load: (...args: A) => Promise<Session[]>,
  name: string,
): (...args: A) => Promise<Discovered> {
  let last: Session[] = [];
  return async (...args) => {
    try {
      last = await load(...args);
      return { sessions: last, problem: "", stale: false };
    } catch {
      last = last.map((session) => (session.place.kind === "cloud" ? session : { ...session, activity: undefined }));
      return { sessions: last, problem: `${name} unavailable; showing the last successful list`, stale: true };
    }
  };
}

/**
 * Every source of sessions, merged into one list. Each source fails on its own: the others stay
 * live, and the failed one keeps its last rows. The TUI and the phone server each hold one.
 */
export function discovery() {
  const saved = keepLast(async (native: boolean) => {
    const { acpRequest } = await import("./acp-host");
    const owned = await acpRequest<Session[]>("/sessions");
    if (!native) return owned;
    const { nativeSavedSessions } = await import("./native-resume");
    return nativeSavedSessions(owned);
  }, "ACP host");
  const observed = keepLast(async (kitty: boolean) => {
    const { listNativeSessions } = await import("./native-sessions");
    return listNativeSessions({ kitty });
  }, "Native session discovery");
  return async ({ cloud = false, claudeCloud = false, native = true, kitty = true } = {}): Promise<Discovered> => {
    const [held, seen] = await Promise.all([
      saved(native),
      native ? observed(kitty) : { sessions: [], problem: "", stale: false },
    ]);
    const clouds = [...(cloud ? [cloudSnapshot()] : []), ...(cloud && claudeCloud ? [claudeCloudSnapshot()] : [])];
    const merged = [
      ...held.sessions
        .filter((session) => !seen.sessions.some((row) => row.agent === session.agent && row.id === session.id))
        .map((session) => ({ ...session, branch: gitBranch(session.cwd) })),
      ...seen.sessions,
      ...clouds.flatMap((snapshot) => snapshot.sessions),
    ].sort((left, right) => left.cwd.localeCompare(right.cwd) || left.startedAt - right.startedAt);
    return {
      sessions: nestSessions([...new Map(merged.map((session) => [sessionIdentity(session), session])).values()]),
      problem: [held.problem, seen.problem, ...clouds.map((snapshot) => snapshot.problem)].filter(Boolean).join(" · "),
      stale: held.stale || seen.stale,
    };
  };
}

/** One observation, for callers that would rather fail than show a stale list. */
export async function listSessions(options: Parameters<ReturnType<typeof discovery>>[0] = {}): Promise<Session[]> {
  const found = await discovery()(options);
  if (found.stale) throw new Error(found.problem);
  return found.sessions;
}

/** Provider relationships survive daemon execution, where children have no terminal PID. */
export function sessionParents(sessions: readonly Session[]): Map<Session, Session | undefined> {
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
  for (const session of sessions) {
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
  for (const session of sessions) {
    const path = new Set<Session>();
    let ancestor: Session | undefined = session;
    while (ancestor && !valid.has(ancestor) && !path.has(ancestor)) {
      path.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    const accepted = ancestor === undefined || valid.get(ancestor) === true;
    for (const member of path) valid.set(member, accepted);
  }
  for (const session of sessions) if (!valid.get(session)) parents.set(session, undefined);
  return parents;
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
