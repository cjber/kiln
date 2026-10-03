import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Agent, gitBranch, type Session } from "./sessions";

/** A terminal session as it was last seen running, kept so a restart does not lose it. */
export type Saved = {
  agent: Agent;
  id: string;
  cwd: string;
  title?: string;
  startedAt: number;
  lastActiveAt?: number;
  /** The boot and process it was last seen in. */
  boot: string;
  pid: number;
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
      "PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS sessions (agent TEXT NOT NULL, id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT, startedAt REAL NOT NULL, lastActiveAt REAL, boot TEXT NOT NULL, pid INTEGER NOT NULL, goneAt REAL, PRIMARY KEY (agent, id));",
    );
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
      lastActiveAt: row.lastActiveAt ?? undefined,
      goneAt: row.goneAt ?? undefined,
    }));
}

/**
 * A top-level agent in a terminal with a conversation its provider can resume. Jobs and daemon threads
 * outlive a restart on their own. The id becomes a command argument, so one that could read as a flag is not saved.
 */
function resumable(session: Session): session is Session & { id: string; pid: number } {
  const kind = session.place.kind;
  return (
    session.id !== undefined &&
    /^[A-Za-z0-9][\w.-]*$/.test(session.id) &&
    session.pid !== undefined &&
    session.parentSessionPid === undefined &&
    session.parentSessionId === undefined &&
    (kind === "kiln" || kind === "kitty" || kind === "elsewhere")
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
  for (const session of sessions.filter(resumable)) {
    next.set(key(session), {
      agent: session.agent,
      id: session.id,
      cwd: session.cwd,
      title: session.title,
      startedAt: session.startedAt,
      lastActiveAt: session.lastActiveAt,
      boot,
      pid: session.pid,
      goneAt: undefined,
    });
  }
  const running = new Set([...next.values()].map((item) => item.pid));
  for (const item of saved) {
    if (next.has(key(item))) continue;
    if (item.boot !== boot) next.set(key(item), item);
    // A running process under a new id started another conversation; the old one is not what a restart would lose.
    else if (running.has(item.pid)) continue;
    // A listing that failed says nothing about a process that is still there.
    else if (alive(item.pid)) next.set(key(item), { ...item, goneAt: undefined });
    else if (now - (item.goneAt ?? now) < closedAfterMs) next.set(key(item), { ...item, goneAt: item.goneAt ?? now });
  }
  const listed = new Set(sessions.filter((session) => session.id !== undefined).map(key));
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
          const insert = db.query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
          for (const item of result.saved)
            insert.run(
              item.agent,
              item.id,
              item.cwd,
              item.title ?? null,
              item.startedAt,
              item.lastActiveAt ?? null,
              item.boot,
              item.pid,
              item.goneAt ?? null,
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

export function forget(session: Session, path = statePath()): void {
  if (session.id !== undefined)
    open(path).query("DELETE FROM sessions WHERE agent = ? AND id = ?").run(session.agent, session.id);
}
