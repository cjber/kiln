import { Database } from "bun:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkout, toolPath } from "./workdir";

/** What the records read so far say; the later records only ever replace a field. */
type Facts = {
  title?: string;
  generated?: string;
  workdir?: string;
  codeMode?: boolean;
  turnEnded?: boolean;
  limited?: Limited;
};

type Progress = Facts & {
  inode: number;
  offset: number;
  modified: number;
  pending: string;
  decoder: TextDecoder;
  /** The byte after the last complete line read, where another process can carry on from these facts. */
  lineEnd: number;
  /** The `lineEnd` the shared store holds for this transcript. */
  stored: number;
};

const cache = new Map<string, Progress>();

const storePath = () => join(Bun.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "kiln", "transcripts.sqlite");
const stores = new Map<string, Database>();
const forgetAfterMs = 30 * 24 * 60 * 60 * 1000;

/**
 * Where every kiln process keeps how far it has read each transcript and what that part said. A Claude transcript
 * grows to hundreds of megabytes, so a short-lived `kiln msg list` that read each one from the start spent seconds
 * of CPU; with this it reads only what was appended since any kiln process last looked.
 */
function store(): Database {
  const path = storePath();
  let db = stores.get(path);
  if (!db) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS transcripts (path TEXT PRIMARY KEY, inode INTEGER NOT NULL, offset INTEGER NOT NULL, modified REAL NOT NULL, facts TEXT NOT NULL, used REAL NOT NULL);",
    );
    db.query("DELETE FROM transcripts WHERE used < ?").run(Date.now() - forgetAfterMs);
    stores.set(path, db);
  }
  return db;
}

/** The progress another kiln process saved, which the caller checks against the file like its own. */
function restore(path: string): Progress | undefined {
  const row = store()
    .query<{ inode: number; offset: number; modified: number; facts: string }, [string]>(
      "SELECT inode, offset, modified, facts FROM transcripts WHERE path = ?",
    )
    .get(path);
  if (!row) return undefined;
  const facts = JSON.parse(row.facts) as Facts;
  return {
    ...facts,
    inode: row.inode,
    offset: row.offset,
    modified: row.modified,
    pending: "",
    decoder: new TextDecoder(),
    lineEnd: row.offset,
    stored: row.offset,
  };
}

/** Saves progress at a line boundary; a row another process carried further on the same file is kept. */
function persist(path: string, saved: Progress, size: number) {
  const { title, generated, workdir, codeMode, turnEnded, limited } = saved;
  store()
    .query(
      "INSERT INTO transcripts (path, inode, offset, modified, facts, used) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, offset = excluded.offset, modified = excluded.modified, facts = excluded.facts, used = excluded.used WHERE NOT (excluded.inode = transcripts.inode AND transcripts.offset > excluded.offset AND transcripts.offset <= ?)",
    )
    .run(
      path,
      saved.inode,
      saved.lineEnd,
      // Only progress that reached the end of the file can vouch for its modification time.
      saved.lineEnd === size ? saved.modified : 0,
      JSON.stringify({ title, generated, workdir, codeMode, turnEnded, limited }),
      Date.now(),
      size,
    );
  saved.stored = saved.lineEnd;
}

/** A usage-limit refusal in a Claude transcript: when the window that refused resets, and when it was written (ms). */
export type Limited = { resetsAt: number; at: number };

/**
 * The refusal a transcript record holds, if it is one. Claude Code writes the provider's refusal as an assistant
 * record with `error: "rate_limit"`, and `quotaLimits.resetsAt` (seconds) says when the window that refused it resets.
 * A refusal with no window behind it is the provider being busy, which another account would not cure.
 */
export function limitRecord(record: {
  error?: unknown;
  isApiErrorMessage?: unknown;
  timestamp?: unknown;
  quotaLimits?: { resetsAt?: unknown };
}): Limited | undefined {
  if (record.error !== "rate_limit" || record.isApiErrorMessage !== true) return undefined;
  const resetsAt = record.quotaLimits?.resetsAt;
  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  return typeof resetsAt === "number" && !Number.isNaN(at) ? { resetsAt: resetsAt * 1000, at } : undefined;
}

/**
 * `codeMode` is Claude's own record that the conversation started in Code Mode, which it can only resume with it on.
 * `turnEnded` is true once Claude has finished a reply (`end_turn`) and nothing has been said to it since.
 * `limited` is the usage-limit refusal the conversation stopped on, while nothing has been said to it since.
 */
export type TranscriptDetails = {
  title?: string;
  workdir?: string;
  codeMode?: boolean;
  turnEnded?: boolean;
  limited?: Limited;
};

/**
 * Read only title and tool-call records, retaining the last complete line while a transcript is being appended.
 * A title the user set wins over the one Claude generates. `workdir` is the checkout the latest edit or `cd` was in.
 */
export function readTranscript(path: string): TranscriptDetails {
  try {
    const info = statSync(path);
    const key = path;
    let saved = cache.get(key) ?? shared(restore, key);
    if (
      !saved ||
      saved.inode !== info.ino ||
      info.size < saved.offset ||
      (info.size === saved.offset && info.mtimeMs !== saved.modified)
    ) {
      saved = {
        inode: info.ino,
        offset: 0,
        modified: 0,
        pending: "",
        decoder: new TextDecoder(),
        lineEnd: 0,
        stored: -1,
      };
    }
    cache.set(key, saved);
    if (saved.modified === info.mtimeMs && saved.offset === info.size) return details(saved);
    const fd = openSync(path, "r");
    try {
      const bytes = Buffer.alloc(64 * 1024);
      while (saved.offset < info.size) {
        const count = readSync(fd, bytes, 0, Math.min(bytes.length, info.size - saved.offset), saved.offset);
        if (!count) break;
        const newline = bytes.subarray(0, count).lastIndexOf(10);
        if (newline >= 0) saved.lineEnd = saved.offset + newline + 1;
        saved.offset += count;
        const lines = (saved.pending + saved.decoder.decode(bytes.subarray(0, count), { stream: true })).split("\n");
        saved.pending = lines.pop() ?? "";
        for (const line of lines) {
          if (
            !line.includes('-title"') &&
            !line.includes('"tool_use"') &&
            !line.includes('"repl-mode"') &&
            !line.includes('"end_turn"') &&
            !line.includes('"rate_limit"') &&
            !line.includes('"type":"user"')
          )
            continue;
          try {
            const record = JSON.parse(line);
            if (record.type === "custom-title" && typeof record.customTitle === "string")
              saved.title = record.customTitle.trim() || undefined;
            else if (record.type === "ai-title" && typeof record.aiTitle === "string")
              saved.generated = record.aiTitle.trim() || undefined;
            else if (record.type === "repl-mode" && typeof record.replMode === "boolean")
              saved.codeMode = record.replMode;
            // A prompt or a tool result starts or continues a turn; a subagent's records are not the session's turn, and
            // the summary Claude writes when it compacts the conversation, as it does while idle, is not a prompt.
            else if (record.type === "user" && !record.isSidechain && !record.isCompactSummary) {
              saved.turnEnded = false;
              saved.limited = undefined;
            } else if (record.type === "assistant" && Array.isArray(record.message?.content))
              for (const part of record.message.content) {
                const path = part?.type === "tool_use" ? toolPath(String(part.name), part.input ?? {}) : undefined;
                const found = path && checkout(path);
                if (found) saved.workdir = found;
              }
            if (record.type === "assistant" && !record.isSidechain && record.message?.stop_reason === "end_turn")
              saved.turnEnded = true;
            if (record.type === "assistant" && !record.isSidechain)
              saved.limited = limitRecord(record) ?? saved.limited;
          } catch {
            // Ignore incomplete or unrelated records; a title never establishes activity.
          }
        }
        if (saved.pending.length > 64 * 1024) saved.pending = "";
      }
      saved.modified = info.mtimeMs;
    } finally {
      closeSync(fd);
    }
    if (saved.lineEnd !== saved.stored) shared(persist, key, saved, info.size);
    if (cache.size > 128) cache.delete(cache.keys().next().value ?? "");
    return details(saved);
  } catch (error) {
    if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return {};
    throw error;
  }
}

/**
 * The shared store only saves work: a process that cannot open or write it (a read-only home, a sandbox) reads the
 * transcript itself, as it would the first time.
 */
function shared<Args extends unknown[], Result>(use: (...args: Args) => Result, ...args: Args): Result | undefined {
  try {
    return use(...args);
  } catch {
    return undefined;
  }
}

function details(saved: Facts): TranscriptDetails {
  return {
    title: saved.title ?? saved.generated,
    workdir: saved.workdir,
    codeMode: saved.codeMode,
    turnEnded: saved.turnEnded,
    limited: saved.limited,
  };
}
