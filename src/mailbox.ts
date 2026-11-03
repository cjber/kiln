import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A note from one session to another. `from` and `to` are `sessionIdentity` names; a person at a shell is `terminal`. */
export type Message = {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: number;
  /** Typed into the recipient as a prompt. */
  deliveredAt?: number;
  /** Read with `kiln msg inbox`. */
  readAt?: number;
  /** A delivery failed in a way that may still have reached the agent, so it is left for the inbox, never sent twice. */
  failedAt?: number;
};

/** A message nobody delivered or read in this long is dropped: its sender has long moved on. */
const keepMs = 7 * 24 * 60 * 60 * 1000;
/** Two agents replying to each other forever stop here. */
export const sendLimit = { count: 20, perMs: 10 * 60 * 1000 };

export const mailboxPath = () =>
  join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "mailbox.sqlite");

const databases = new Map<string, Database>();

/** The list, the phone server and every `kiln msg` share this file, so each change is one statement. */
function open(path: string): Database {
  let db = databases.get(path);
  if (!db) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    db.exec(
      'PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, "from" TEXT NOT NULL, "to" TEXT NOT NULL, body TEXT NOT NULL, createdAt REAL NOT NULL, deliveredAt REAL, readAt REAL, failedAt REAL);',
    );
    databases.set(path, db);
  }
  return db;
}

type Row = { [Field in keyof Required<Message>]: Message[Field] | null };
const message = (row: Row): Message => ({
  ...(row as Message),
  deliveredAt: row.deliveredAt ?? undefined,
  readAt: row.readAt ?? undefined,
  failedAt: row.failedAt ?? undefined,
});

export function post(from: string, to: string, body: string, path = mailboxPath(), now = Date.now()): Message {
  const db = open(path);
  // Immediate, so two senders cannot both count 19 and both insert.
  return db
    .transaction(() => {
      const { sent } = db
        .query<{ sent: number }, [string, string, number]>(
          'SELECT count(*) AS sent FROM messages WHERE "from" = ? AND "to" = ? AND createdAt > ?',
        )
        .get(from, to, now - sendLimit.perMs) ?? { sent: 0 };
      if (sent >= sendLimit.count)
        throw new Error(`${sendLimit.count} messages to ${to} in ten minutes; wait before sending more`);
      const created = { id: crypto.randomUUID(), from, to, body, createdAt: now };
      db.query('INSERT INTO messages (id, "from", "to", body, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        created.id,
        from,
        to,
        body,
        now,
      );
      return created;
    })
    .immediate();
}

/** Messages nobody has delivered or read yet, oldest first, after dropping expired ones. */
export function pending(path = mailboxPath(), now = Date.now()): Message[] {
  // The list and the phone server call this every refresh; with no mailbox there is nothing to create.
  if (!existsSync(path)) return [];
  const db = open(path);
  db.query("DELETE FROM messages WHERE createdAt < ?").run(now - keepMs);
  return db
    .query<Row, []>(
      "SELECT * FROM messages WHERE deliveredAt IS NULL AND readAt IS NULL AND failedAt IS NULL ORDER BY createdAt",
    )
    .all()
    .map(message);
}

/** Only one of the list, the phone server or a `kiln msg` delivers a message, whichever claims it first. */
export function claim(id: string, path = mailboxPath(), now = Date.now()): boolean {
  return (
    open(path)
      .query("UPDATE messages SET deliveredAt = ? WHERE id = ? AND deliveredAt IS NULL AND readAt IS NULL")
      .run(now, id).changes === 1
  );
}

/**
 * A delivery that did not happen. One kiln refused before sending goes back to waiting; one that failed on the way
 * may have arrived, so it stays for the recipient's inbox rather than risk a second copy.
 */
export function release(id: string, sent: boolean, path = mailboxPath(), now = Date.now()): void {
  open(path)
    .query("UPDATE messages SET deliveredAt = NULL, failedAt = ? WHERE id = ?")
    .run(sent ? now : null, id);
}

/** The recipient's undelivered messages, marked read as they are handed over. */
export function takeUnread(to: string, path = mailboxPath(), now = Date.now()): Message[] {
  if (!existsSync(path)) return [];
  const db = open(path);
  return db.transaction(() => {
    const rows = db
      .query<Row, [string]>(
        'SELECT * FROM messages WHERE "to" = ? AND deliveredAt IS NULL AND readAt IS NULL ORDER BY createdAt',
      )
      .all(to);
    db.query('UPDATE messages SET readAt = ? WHERE "to" = ? AND deliveredAt IS NULL AND readAt IS NULL').run(now, to);
    return rows.map((row) => ({ ...message(row), readAt: now }));
  })();
}
