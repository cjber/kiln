import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { claudeCloudSnapshot } from "./claude-cloud";
import { cloudSnapshot } from "./cloud";

export type Agent = "claude" | "codex" | "opencode" | "pi";

export const agents: readonly Agent[] = ["claude", "codex", "opencode", "pi"];

/** The name shown to people; ids stay lowercase for matching, filtering and sorting. */
export function agentName(agent: Agent): string {
  return { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi" }[agent];
}

/** What a session is doing, as far as anyone can tell: `waiting` means it stopped to ask you something. */
export type Activity = "working" | "waiting" | "idle";

/** How a session ended: a background job that finished, or a terminal session a restart cut off. It reports no activity. */
export type Lifecycle = "completed" | "stopped";

export type Place =
  | { kind: "kiln"; name: string }
  | { kind: "kitty"; socket: string; windowId: number }
  /** A Claude background job, running or finished; `attach` gives it a terminal. */
  | { kind: "job"; id: string; attach: string[]; stop?: string[] }
  /** A conversation on the Codex daemon or OpenCode service with no terminal of its own. */
  | { kind: "thread"; id: string; attach: string[] }
  | { kind: "elsewhere"; source?: string }
  /** A terminal session a restart stopped; opening it resumes the conversation in a new kiln session. */
  | { kind: "saved" }
  | { kind: "cloud"; id: string; title: string; url?: string };

export type Session = {
  /** Provider identity and display name, when reported. */
  id?: string;
  title?: string;
  /** The agent's process; a daemon thread has none of its own. */
  pid?: number;
  /** The live session whose agent spawned this process. */
  parentSessionPid?: number;
  parentSessionId?: string;
  parentSessionAgent?: Agent;
  agent: Agent;
  /** Where the agent started; resuming a conversation needs it. */
  cwd: string;
  /** The checkout the agent last edited or `cd`'d into, which is often a worktree rather than `cwd`. */
  workdir?: string;
  startedAt: number;
  /** Last provider or transcript update, when available. */
  lastActiveAt?: number;
  /** Agent-reported status; terminal output never establishes activity. */
  activity?: Activity;
  /** Working only through a background shell or subagent: the agent's own turn has ended, so it takes a prompt. */
  turnEnded?: boolean;
  lifecycle?: Lifecycle;
  /** The OpenCode background service holds this conversation, so its web UI can open it. */
  opencodeService?: boolean;
  /** The branch checked out in the session's directory, or a short commit when HEAD is detached. */
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

/** Where the agent works, for display and grouping; opening and resuming use `cwd`. */
export function sessionDirectory(session: Session): string {
  return session.workdir ?? session.cwd;
}

/** Resolved repositories by directory, rechecked after `repositoryTtlMs` so a new repository or worktree is picked up. */
const repositories = new Map<string, { repository: string; at: number }>();
const repositoryNames = new Map<string, { name: string; at: number }>();
const repositoryTtlMs = 30_000;

/**
 * The main repository a session works in, for project groups: a linked worktree resolves to the checkout
 * that owns it. A directory outside git is its own project.
 */
export function sessionRepository(session: Session): string {
  const now = Date.now();
  const directory = sessionDirectory(session);
  const cached = repositories.get(directory);
  if (cached && now - cached.at < repositoryTtlMs) return cached.repository;
  const repository = mainCheckout(directory) ?? directory;
  repositories.set(directory, { repository, at: now });
  return repository;
}

/**
 * The name a repository's remote gives it, such as `kiln` from `git@github.com:cjber/kiln.git`, or the
 * directory's own name when it has no remote. Cached like `sessionRepository`.
 */
export function repositoryName(directory: string): string {
  const now = Date.now();
  const cached = repositoryNames.get(directory);
  if (cached && now - cached.at < repositoryTtlMs) return cached.name;
  const name = remoteRepositoryName(directory) ?? (basename(directory) || directory);
  repositoryNames.set(directory, { name, at: now });
  return name;
}

/** The checkout holding `cwd` and its git directory; a linked worktree's `.git` is a file pointing at it. */
function gitCheckout(cwd: string): { dir: string; gitDir: string } | undefined {
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (!existsSync(dotGit)) continue;
    if (!statSync(dotGit).isFile()) return { dir, gitDir: dotGit };
    return {
      dir,
      gitDir: resolve(
        dir,
        readFileSync(dotGit, "utf8")
          .replace(/^gitdir:\s*/, "")
          .trim(),
      ),
    };
  }
  return undefined;
}

function mainCheckout(cwd: string): string | undefined {
  try {
    const checkout = gitCheckout(cwd);
    if (!checkout) return undefined;
    const commondir = join(checkout.gitDir, "commondir");
    // Linked worktrees share the git directory that holds `worktrees`; git names a repository after it.
    const common = existsSync(commondir)
      ? resolve(checkout.gitDir, readFileSync(commondir, "utf8").trim())
      : existsSync(join(checkout.gitDir, "worktrees"))
        ? checkout.gitDir
        : undefined;
    // Without linked worktrees (a submodule, a plain checkout) the checkout is its own repository.
    if (!common) return checkout.dir;
    return basename(common) === ".git" ? dirname(common) : common;
  } catch {
    // An unreadable repository groups by its directory.
    return undefined;
  }
}

/** A repository's name from its `origin` remote, else its first remote, else undefined. */
function remoteRepositoryName(cwd: string): string | undefined {
  try {
    const checkout = gitCheckout(cwd);
    if (!checkout) return undefined;
    const common = join(checkout.gitDir, "commondir");
    const config = readFileSync(
      join(
        existsSync(common) ? resolve(checkout.gitDir, readFileSync(common, "utf8").trim()) : checkout.gitDir,
        "config",
      ),
      "utf8",
    );
    const remotes = [...config.matchAll(/\[remote "([^"]+)"\]([\s\S]*?)(?=\n\[|$)/g)];
    const remote = remotes.find(([, name]) => name === "origin") ?? remotes[0];
    const url = remote?.[2].match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1];
    if (!url) return undefined;
    const cleaned = url.replace(/\/+$/, "").replace(/\.git$/, "");
    return cleaned.split(/[/:]/).at(-1) || undefined;
  } catch {
    return undefined;
  }
}

export function gitBranch(cwd: string): string | undefined {
  try {
    const checkout = gitCheckout(cwd);
    if (!checkout) return undefined;
    const head = readFileSync(join(checkout.gitDir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
  } catch {
    // An unreadable repository just has no branch to show.
    return undefined;
  }
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

/** A terminal kiln cannot reach is not listed; a child under it is listed at the top level instead. */
export function openable(session: Session): boolean {
  return session.place.kind !== "elsewhere";
}

/**
 * Every source of sessions, merged into one list. Each source fails on its own: the others stay
 * live, and the failed one keeps its last rows. The TUI and the phone server each hold one.
 */
export function discovery() {
  const observed = keepLast(async (kitty: boolean) => {
    const { listNativeSessions } = await import("./native-sessions");
    return listNativeSessions({ kitty });
  }, "Native session discovery");
  return async ({ cloud = false, claudeCloud = false, kitty = true } = {}): Promise<Discovered> => {
    const seen = await observed(kitty);
    const clouds = [...(cloud ? [cloudSnapshot()] : []), ...(cloud && claudeCloud ? [claudeCloudSnapshot()] : [])];
    const merged = [...seen.sessions, ...clouds.flatMap((snapshot) => snapshot.sessions)]
      // Without the kitty lookup a kitty window reads as elsewhere, so only a full lookup can tell.
      .filter((session) => !kitty || openable(session))
      .sort((left, right) => left.cwd.localeCompare(right.cwd) || left.startedAt - right.startedAt);
    return {
      sessions: withSubagentActivity(
        nestSessions([...new Map(merged.map((session) => [sessionIdentity(session), session])).values()]),
      ),
      problem: [seen.problem, ...clouds.map((snapshot) => snapshot.problem)].filter(Boolean).join(" · "),
      stale: seen.stale,
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
        : ids
            .get(`${session.parentSessionAgent ?? session.agent}:${session.parentSessionId}`)
            ?.find((parent) => parent !== session);
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

/**
 * A subagent is its own session with its own provider status, and its parent can end a turn while it
 * runs. A parent that reports idle while a live descendant is working is still working. A descendant that
 * needs input says so itself, and a Codex thread that hit an error reads as waiting, so neither holds it.
 */
export function withSubagentActivity(sessions: readonly Session[]): Session[] {
  const parents = sessionParents(sessions);
  const busy = new Set<Session>();
  for (const session of sessions) {
    if (session.lifecycle || session.activity !== "working") continue;
    for (let parent = parents.get(session); parent && !busy.has(parent); parent = parents.get(parent)) busy.add(parent);
  }
  return sessions.map((session) =>
    busy.has(session) && session.activity === "idle" ? { ...session, activity: "working", turnEnded: true } : session,
  );
}

/** The status bar's right side: only the counts that are non-zero, working first. */
export function summarise(sessions: readonly Session[]): string {
  const count = (activity: Activity) => sessions.filter((session) => session.activity === activity).length;
  const parts = (["working", "waiting", "idle"] as const).flatMap((activity) =>
    count(activity) ? [`${count(activity)} ${activity}`] : [],
  );
  return parts.length ? parts.join(" · ") : `${sessions.length} sessions`;
}
