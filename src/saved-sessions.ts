import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Agent, gitBranch, processIdentity, type Session, sessionIdentity } from "./sessions";

/** A terminal session as it was last seen running, kept so a restart does not lose it. */
export type Saved = {
  agent: Agent;
  id: string;
  cwd: string;
  title?: string;
  /** The kiln id of the session that started this one with `kiln msg spawn`. */
  parent?: string;
  startedAt: number;
  lastActiveAt?: number;
  /** The boot and process it was last seen in; a Codex daemon thread has no process of its own. */
  boot: string;
  pid?: number;
  /** When its process was first found gone during that boot. */
  goneAt?: number;
};

/**
 * A shutdown ends the agents moments before it ends kiln, so a process that vanishes is only taken as
 * closed once kiln has outlived it by this long.
 */
const closedAfterMs = 120_000;

const statePath = () => join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "sessions.sqlite");

const key = (item: { agent: Agent; id?: string }) => `${item.agent}:${item.id}`;

let boot: string | undefined;

/** The kernel's id for this boot; without one nothing is saved, since a restart could not be told from a close. */
function bootId(): string | undefined {
  try {
    boot ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    // Not Linux.
  }
  return boot || undefined;
}

const databases = new Map<string, Database>();

/** The list, the phone server and `kiln status` all write here, so every change is one transaction. */
function open(path: string): Database {
  let db = databases.get(path);
  if (!db) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS sessions (agent TEXT NOT NULL, id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT, startedAt REAL NOT NULL, lastActiveAt REAL, boot TEXT NOT NULL, pid INTEGER, goneAt REAL, parent TEXT, PRIMARY KEY (agent, id));",
    );
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all();
    if (!columns.some((column) => column.name === "parent")) db.exec("ALTER TABLE sessions ADD COLUMN parent TEXT");
    databases.set(path, db);
  }
  return db;
}

type Row = { [Field in keyof Required<Saved>]: Saved[Field] | null };

function read(db: Database): Saved[] {
  return db
    .query<Row, []>("SELECT * FROM sessions ORDER BY agent, id")
    .all()
    .map((row) => ({
      ...(row as Saved),
      title: row.title ?? undefined,
      parent: row.parent ?? undefined,
      lastActiveAt: row.lastActiveAt ?? undefined,
      pid: row.pid ?? undefined,
      goneAt: row.goneAt ?? undefined,
    }));
}

/**
 * A top-level conversation its provider can resume: an agent in a terminal, or a thread loaded in the Codex
 * daemon, which is how a Codex terminal using the daemon is listed. Claude keeps its own background jobs.
 * The id becomes a command argument, so one that could read as a flag is not saved.
 */
function resumable(session: Session): session is Session & { id: string } {
  const kind = session.place.kind;
  return (
    session.id !== undefined &&
    /^[A-Za-z0-9][\w.-]*$/.test(session.id) &&
    session.parentSessionPid === undefined &&
    session.parentSessionId === undefined &&
    // An OpenCode `thread` is a conversation in its service with no terminal, which is how a finished `opencode run`
    // is listed; only a Codex thread stands for a terminal.
    ((kind === "thread" && session.agent === "codex") ||
      (session.pid !== undefined && (kind === "kiln" || kind === "kitty" || kind === "elsewhere")))
  );
}

/**
 * Bring the saved list up to date with one observation. A running session is saved under this boot. One
 * whose process is gone in the same boot was closed and is dropped; one from an earlier boot was cut off
 * by the restart, and stays as a stopped row until it is seen running again or forgotten.
 */
export function reconcile(
  saved: readonly Saved[],
  sessions: readonly Session[],
  boot: string,
  now: number,
  alive: (pid: number) => boolean,
): { saved: Saved[]; stopped: Session[] } {
  const next = new Map<string, Saved>();
  const previous = new Map(saved.map((item) => [key(item), item]));
  for (const session of sessions.filter(resumable)) {
    // A spawned Codex run is recorded by its process until its thread id is known; its row moves to that id here.
    const recorded = previous.get(key(session)) ?? previous.get(processIdentity(session));
    next.set(key(session), {
      agent: session.agent,
      id: session.id,
      cwd: session.cwd,
      title: session.title ?? recorded?.title,
      parent: session.spawnParent ?? recorded?.parent,
      startedAt: session.startedAt,
      lastActiveAt: session.lastActiveAt,
      boot,
      pid: session.pid,
      goneAt: undefined,
    });
  }
  const running = new Set([...next.values()].map((item) => item.pid));
  const listed = new Set(sessions.filter((session) => session.id !== undefined).map(key));
  for (const item of saved) {
    if (next.has(key(item))) continue;
    // A child outlives its process when its provider still lists it, as an `opencode run` does, and keeps its parent.
    if (item.parent && listed.has(key(item))) {
      next.set(key(item), { ...item, boot, goneAt: undefined });
      continue;
    }
    // A restart cut off a top-level session, which comes back stopped. A child belongs to the agent that started it,
    // which decides whether to run it again; a finished `opencode run` revived as an interactive session would carry on
    // editing a worktree its parent has since moved on from, so a child from an earlier boot is dropped.
    if (item.boot !== boot) {
      if (!item.parent) next.set(key(item), item);
    }
    // A running process under a new id started another conversation; the old one is not what a restart would lose.
    else if (item.pid !== undefined && running.has(item.pid)) continue;
    // A listing that failed says nothing about a process that is still there.
    else if (item.pid !== undefined && alive(item.pid)) next.set(key(item), { ...item, goneAt: undefined });
    else if (now - (item.goneAt ?? now) < closedAfterMs) next.set(key(item), { ...item, goneAt: item.goneAt ?? now });
  }
  const kept = [...next.values()].sort((left, right) => (key(left) < key(right) ? -1 : 1));
  return {
    saved: kept,
    stopped: kept
      .filter((item) => item.boot !== boot && !listed.has(key(item)))
      .map((item) => ({
        agent: item.agent,
        id: item.id,
        title: item.title,
        cwd: item.cwd,
        startedAt: item.startedAt,
        lastActiveAt: item.lastActiveAt,
        lifecycle: "stopped" as const,
        branch: gitBranch(item.cwd),
        place: { kind: "saved" as const },
      })),
  };
}

/** Save what is running and return the sessions a restart stopped. */
export function restartStopped(sessions: readonly Session[], path = statePath()): Session[] {
  const boot = bootId();
  if (!boot) return [];
  try {
    const db = open(path);
    return db
      .transaction(() => {
        const before = read(db);
        const result = reconcile(before, sessions, boot, Date.now(), (pid) => existsSync(`/proc/${pid}`));
        if (JSON.stringify(result.saved) !== JSON.stringify(before)) {
          db.exec("DELETE FROM sessions");
          const insert = db.query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
          for (const item of result.saved)
            insert.run(
              item.agent,
              item.id,
              item.cwd,
              item.title ?? null,
              item.startedAt,
              item.lastActiveAt ?? null,
              item.boot,
              item.pid ?? null,
              item.goneAt ?? null,
              item.parent ?? null,
            );
        }
        return result.stopped;
      })
      .immediate();
  } catch {
    // An unwritable or busy state file costs the next restart its rows, not this list.
    return [];
  }
}

/** Record a child started by `kiln msg spawn`, so its parent survives process ancestry and daemon lookup. */
export function recordSpawn(
  item: { agent: Agent; id: string; cwd: string; title?: string; parent?: string; startedAt: number; pid?: number },
  path = statePath(),
): void {
  try {
    open(path)
      .query(
        "INSERT INTO sessions (agent, id, cwd, title, startedAt, lastActiveAt, boot, pid, goneAt, parent) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?) ON CONFLICT(agent, id) DO UPDATE SET cwd = excluded.cwd, title = excluded.title, startedAt = excluded.startedAt, boot = excluded.boot, pid = excluded.pid, goneAt = NULL, parent = excluded.parent",
      )
      .run(
        item.agent,
        item.id,
        item.cwd,
        item.title ?? null,
        item.startedAt,
        bootId() ?? "",
        item.pid ?? null,
        item.parent ?? null,
      );
  } catch {
    // The child still runs; only its recorded parent is lost.
  }
}

/**
 * Record the parent found for a child that has none recorded: by process ancestry, or by the session variable a
 * detached run inherited. Both need the child's process, and a headless run's session stays listed after it exits.
 */
export function rememberParents(sessions: readonly Session[], path = statePath()): void {
  const recorded = recordedSpawns(path);
  const byPid = new Map(sessions.flatMap((session) => (session.pid === undefined ? [] : [[session.pid, session]])));
  for (const session of sessions) {
    if (session.id === undefined || session.parentSessionId !== undefined) continue;
    if (recorded.has(sessionIdentity(session))) continue;
    const ancestor = session.parentSessionPid === undefined ? undefined : byPid.get(session.parentSessionPid);
    const parent =
      session.spawnParent ?? (ancestor?.id && ancestor !== session ? sessionIdentity(ancestor) : undefined);
    if (!parent) continue;
    recordSpawn(
      {
        agent: session.agent,
        id: session.id,
        cwd: session.cwd,
        title: session.title,
        parent,
        startedAt: session.startedAt,
        pid: session.pid,
      },
      path,
    );
  }
}

/** Each spawned child's recorded parent and title, by the child's kiln id. */
function recordedSpawns(path: string): Map<string, { parent?: string; title?: string }> {
  const recorded = new Map<string, { parent?: string; title?: string }>();
  try {
    if (existsSync(path))
      for (const row of open(path)
        .query<{ agent: Agent; id: string; parent: string | null; title: string | null }, []>(
          "SELECT agent, id, parent, title FROM sessions WHERE parent IS NOT NULL",
        )
        .all())
        recorded.set(`${row.agent}:${row.id}`, { parent: row.parent ?? undefined, title: row.title ?? undefined });
  } catch {
    // An unreadable state file only costs the recorded nesting.
  }
  return recorded;
}

/**
 * Mark the sessions whose parent `kiln msg spawn` recorded; that parent outranks process ancestry. A child the
 * provider does not title takes the title the spawn recorded.
 */
export function attachParents(sessions: readonly Session[], path = statePath()): Session[] {
  const recorded = recordedSpawns(path);
  return sessions.map((session) => {
    // A spawned Codex run is recorded by its process, before it has the thread id it is listed under.
    const spawn = recorded.get(sessionIdentity(session)) ?? recorded.get(processIdentity(session));
    if (!spawn) return session;
    return {
      ...session,
      spawnParent: spawn.parent ?? session.spawnParent,
      title: session.title ?? spawn.title,
    };
  });
}

export function forget(session: Session, path = statePath()): void {
  if (session.id !== undefined)
    open(path).query("DELETE FROM sessions WHERE agent = ? AND id = ?").run(session.agent, session.id);
}
