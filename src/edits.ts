import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { codexItems, type Item, opencodeDatabase, piItems, recordItems, transcriptFile } from "./conversation";
import type { Session } from "./sessions";

/** One hunk of a unified diff: `lines` start with ` ` (context), `-` (removed) or `+` (added). */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

/**
 * One file one tool call changed. `update` carries the agent's own hunks; `create` and `write` carry the whole new
 * file as one added hunk (`write` replaced a file whose earlier content the transcript does not hold).
 */
export type FileEdit = {
  id: string;
  at?: number;
  file: string;
  change: "update" | "create" | "write" | "delete";
  hunks: Hunk[];
  /** The prompt this edit answers, as an index into `turns`; -1 is before the first prompt. */
  turn: number;
};

/** A prompt the person (or another agent) gave the session. */
export type Turn = { prompt: string; at?: number };

export type Ledger = { turns: Turn[]; edits: FileEdit[] };

/** One call reads at most this much of a transcript; the rest is read on the following calls. */
const stepBytes = 8 * 1024 * 1024;

const timestamp = (value: unknown) => {
  const parsed = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** A file's lines without the empty string a final newline leaves. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The whole of `content` as one hunk that adds every line. */
const wholeFile = (content: string): Hunk[] => {
  const lines = splitLines(content);
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`) }];
};

/**
 * The hunks of a unified diff. Each hunk takes exactly the line counts its header names, so a context line that is
 * an empty string (an editor stripped its leading space) still counts, and `---`/`+++` headers are never read as lines.
 */
export function parseUnified(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = diff.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) continue;
    const hunk: Hunk = {
      oldStart: Number(header[1]),
      oldLines: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newLines: header[4] === undefined ? 1 : Number(header[4]),
      lines: [],
    };
    let old = 0;
    let added = 0;
    while ((old < hunk.oldLines || added < hunk.newLines) && index + 1 < lines.length) {
      const line = lines[++index] ?? "";
      if (line.startsWith("\\")) continue;
      const kind = line[0] === "-" || line[0] === "+" ? line[0] : " ";
      const text = line[0] === "-" || line[0] === "+" || line[0] === " " ? line.slice(1) : line;
      if (kind !== "+") old++;
      if (kind !== "-") added++;
      hunk.lines.push(`${kind}${text}`);
    }
    hunks.push(hunk);
  }
  return hunks;
}

/** Claude's `structuredPatch`, keeping only well-formed hunks and dropping "no newline" markers. */
function claudeHunks(patch: unknown): Hunk[] {
  if (!Array.isArray(patch)) return [];
  return patch.flatMap((hunk): Hunk[] =>
    hunk &&
    typeof hunk.oldStart === "number" &&
    typeof hunk.newStart === "number" &&
    typeof hunk.oldLines === "number" &&
    typeof hunk.newLines === "number" &&
    Array.isArray(hunk.lines)
      ? [
          {
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines: hunk.lines.filter(
              (line: unknown): line is string => typeof line === "string" && !line.startsWith("\\"),
            ),
          },
        ]
      : [],
  );
}

/** What reading a transcript so far has found, and where to carry on. */
type Scan = {
  inode: number;
  offset: number;
  ledger: Ledger;
  /** Pi `write` calls by id, waiting for a result that says they succeeded. */
  writes: Map<string, { path: string; content: string }>;
  /** The directory a Pi session runs in, from its first record; Pi records the paths it is given, often relative. */
  cwd?: string;
};

/** A path a tool was given, made absolute against the session's directory, or undefined when that is unknown. */
const resolved = (scan: Scan, path: string) => (isAbsolute(path) ? path : scan.cwd ? join(scan.cwd, path) : undefined);

type Collect = { scan: Scan; record: Record<string, unknown> };

function prompt(scan: Scan, items: readonly Item[]) {
  for (const item of items) if (item.kind === "you") scan.ledger.turns.push({ prompt: item.text, at: item.at });
}

const turnOf = (scan: Scan) => scan.ledger.turns.length - 1;

/** A Claude record: a typed prompt starts a turn; an edit's result carries its file and hunks. */
function claudeRecord({ scan, record }: Collect) {
  if (record.type !== "user") return;
  const result = record.toolUseResult as Record<string, unknown> | undefined;
  if (result && typeof result.filePath === "string" && isAbsolute(result.filePath)) {
    const at = timestamp(record.timestamp);
    const id = typeof record.uuid === "string" ? record.uuid : `${at}`;
    if (result.type === "create" && typeof result.content === "string")
      scan.ledger.edits.push({
        id,
        at,
        file: result.filePath,
        change: "create",
        hunks: wholeFile(result.content),
        turn: turnOf(scan),
      });
    else if (Array.isArray(result.structuredPatch)) {
      const hunks = claudeHunks(result.structuredPatch);
      if (hunks.length)
        scan.ledger.edits.push({ id, at, file: result.filePath, change: "update", hunks, turn: turnOf(scan) });
    }
    return;
  }
  prompt(scan, recordItems(record));
}

/** A Codex record: a user message starts a turn; a completed `FileChange` carries each file's diff. */
function codexRecord({ scan, record }: Collect) {
  const payload = record.payload as Record<string, unknown> | undefined;
  const item = payload?.item as { type?: unknown; id?: unknown; changes?: unknown } | undefined;
  if (record.type === "event_msg" && payload?.type === "item_completed" && item?.type === "FileChange") {
    const at = timestamp(record.timestamp);
    const changes = (item.changes ?? {}) as Record<
      string,
      { type?: unknown; unified_diff?: unknown; content?: unknown }
    >;
    for (const [file, change] of Object.entries(changes)) {
      if (!isAbsolute(file)) continue;
      const id = `${String(item.id)}:${file}`;
      if (change.type === "add" && typeof change.content === "string")
        scan.ledger.edits.push({
          id,
          at,
          file,
          change: "create",
          hunks: wholeFile(change.content),
          turn: turnOf(scan),
        });
      else if (change.type === "delete")
        scan.ledger.edits.push({ id, at, file, change: "delete", hunks: [], turn: turnOf(scan) });
      else if (change.type === "update" && typeof change.unified_diff === "string") {
        const hunks = parseUnified(change.unified_diff);
        if (hunks.length) scan.ledger.edits.push({ id, at, file, change: "update", hunks, turn: turnOf(scan) });
      }
    }
    return;
  }
  prompt(scan, codexItems(record));
}

/** A Pi record: an `edit` result carries a diff, and a `write` call's content counts once its result succeeds. */
function piRecord({ scan, record }: Collect) {
  if (record.type === "session" && typeof record.cwd === "string") scan.cwd = record.cwd;
  if (record.type !== "message") return;
  const message = (record.message ?? {}) as Record<string, unknown>;
  const at = timestamp(record.timestamp ?? message.timestamp);
  if (message.role === "assistant" && Array.isArray(message.content))
    for (const part of message.content) {
      const args = part?.arguments as { path?: unknown; content?: unknown } | undefined;
      if (part?.type === "toolCall" && part.name === "write" && typeof part.id === "string") {
        const path = typeof args?.path === "string" ? resolved(scan, args.path) : undefined;
        if (path && typeof args?.content === "string") scan.writes.set(part.id, { path, content: args.content });
      }
    }
  if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    const id = message.toolCallId;
    const write = scan.writes.get(id);
    scan.writes.delete(id);
    if (message.isError === true) return;
    if (message.toolName === "write" && write)
      scan.ledger.edits.push({
        id,
        at,
        file: write.path,
        change: "write",
        hunks: wholeFile(write.content),
        turn: turnOf(scan),
      });
    const details = message.details as { patch?: unknown } | undefined;
    if (message.toolName === "edit" && typeof details?.patch === "string") {
      const given = details.patch.match(/^\+\+\+ (.+)$/m)?.[1];
      const file = given && resolved(scan, given);
      const hunks = parseUnified(details.patch);
      if (file && hunks.length) scan.ledger.edits.push({ id, at, file, change: "update", hunks, turn: turnOf(scan) });
    }
    return;
  }
  prompt(scan, piItems(record));
}

const readers = { claude: claudeRecord, codex: codexRecord, pi: piRecord };

/** Lines that can hold a prompt or an edit for each agent; every other line is skipped without parsing. */
const relevant = {
  claude: (line: string) =>
    line.includes('"structuredPatch"') || (line.includes('"type":"user"') && !line.includes('"tool_use_id"')),
  codex: (line: string) => line.includes('"FileChange"') || line.includes('"role":"user"'),
  pi: (line: string) =>
    line.includes('"type":"session"') ||
    line.includes('"toolResult"') ||
    line.includes('"toolCall"') ||
    line.includes('"role":"user"'),
};

/**
 * Read a transcript's edits from the scan's offset to its end, `stepBytes` at a time so memory stays bounded. The first
 * read of a long transcript parses it all (a 150 MB one takes about half a second); later reads parse what was appended.
 */
export function scanEdits(path: string, agent: keyof typeof readers, scan?: Scan): Scan {
  const info = statSync(path);
  // A replaced or truncated transcript is read again from the start.
  const state: Scan =
    scan && scan.inode === info.ino && scan.offset <= info.size
      ? scan
      : { inode: info.ino, offset: 0, ledger: { turns: [], edits: [] }, writes: new Map() };
  const fd = openSync(path, "r");
  try {
    while (state.offset < info.size) {
      const end = Math.min(info.size, state.offset + stepBytes);
      const bytes = Buffer.alloc(end - state.offset);
      let read = 0;
      while (read < bytes.length) {
        const count = readSync(fd, bytes, read, bytes.length - read, state.offset + read);
        if (!count) break;
        read += count;
      }
      const last = bytes.lastIndexOf(10);
      if (last === -1) {
        // A line longer than a whole step is read whole on a later call, once it is complete.
        if (end < info.size) {
          const after = scanLongLine(fd, state, info.size, agent);
          // The last line is still being written; it is read once it ends.
          if (after === state.offset) break;
          state.offset = after;
          continue;
        }
        break;
      }
      for (const line of bytes
        .subarray(0, last + 1)
        .toString("utf8")
        .split("\n"))
        collect(state, agent, line);
      state.offset += last + 1;
    }
  } finally {
    closeSync(fd);
  }
  return state;
}

function collect(state: Scan, agent: keyof typeof readers, line: string) {
  if (!line || !relevant[agent](line)) return;
  try {
    readers[agent]({ scan: state, record: JSON.parse(line) });
  } catch {
    // A malformed line holds no edit.
  }
}

/** Read one line that is longer than a step (a large file written in one call), returning the offset after it. */
function scanLongLine(fd: number, state: Scan, size: number, agent: keyof typeof readers): number {
  const parts: Buffer[] = [];
  let offset = state.offset;
  while (offset < size) {
    const bytes = Buffer.alloc(Math.min(stepBytes, size - offset));
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    if (!count) break;
    const newline = bytes.subarray(0, count).indexOf(10);
    if (newline !== -1) {
      parts.push(bytes.subarray(0, newline));
      collect(state, agent, Buffer.concat(parts).toString("utf8"));
      return offset + newline + 1;
    }
    parts.push(bytes.subarray(0, count));
    offset += count;
  }
  // The line is still being written; read it again once it ends.
  return state.offset;
}

/** An OpenCode session's prompts and edits, read from its database rows after `cursor`. */
export function opencodeLedger(
  path: string,
  session: string,
  directory: string,
  from?: { seq: number; ledger: Ledger },
) {
  const ledger: Ledger = from ? from.ledger : { turns: [], edits: [] };
  let seq = from?.seq ?? 0;
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query<{ seq: number; id: string; type: string; data: string }, [string, number]>(
        "SELECT seq, id, type, data FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq",
      )
      .all(session, seq);
    for (const row of rows) {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(row.data);
      } catch {
        // A malformed message holds no edit.
      }
      const time = (data.time ?? {}) as { created?: number; completed?: number };
      if (row.type === "assistant" && time.completed === undefined) break;
      seq = row.seq;
      if (row.type === "user") {
        if (typeof data.text === "string" && data.text.trim())
          ledger.turns.push({ prompt: data.text.trim(), at: timestamp(time.created) });
        continue;
      }
      if (row.type !== "assistant" || !Array.isArray(data.content)) continue;
      for (const part of data.content) {
        if (part?.type !== "tool" || typeof part.id !== "string") continue;
        const state = (part.state ?? {}) as {
          status?: string;
          input?: { path?: unknown; filePath?: unknown; content?: unknown };
          metadata?: { files?: unknown };
        };
        if (state.status !== "completed") continue;
        const at = timestamp(time.created);
        const files = Array.isArray(state.metadata?.files) ? state.metadata.files : [];
        for (const changed of files) {
          if (typeof changed?.file !== "string" || typeof changed.patch !== "string") continue;
          const file = isAbsolute(changed.file) ? changed.file : join(directory, changed.file);
          const hunks = parseUnified(changed.patch);
          if (changed.status === "deleted")
            ledger.edits.push({
              id: `${part.id}:${file}`,
              at,
              file,
              change: "delete",
              hunks: [],
              turn: ledger.turns.length - 1,
            });
          else if (hunks.length)
            ledger.edits.push({
              id: `${part.id}:${file}`,
              at,
              file,
              change: "update",
              hunks,
              turn: ledger.turns.length - 1,
            });
        }
        const input = state.input ?? {};
        const written = input.filePath ?? input.path;
        if (
          part.name === "write" &&
          !files.length &&
          typeof written === "string" &&
          typeof input.content === "string"
        ) {
          const file = isAbsolute(written) ? written : join(directory, written);
          ledger.edits.push({
            id: part.id,
            at,
            file,
            change: "write",
            hunks: wholeFile(input.content),
            turn: ledger.turns.length - 1,
          });
        }
      }
    }
  } finally {
    db.close();
  }
  return { seq, ledger };
}

const empty: Ledger = { turns: [], edits: [] };

/** Every local session's ledger, kept between calls so each refresh reads only what was appended. */
export function ledgers() {
  const scans = new Map<string, Scan>();
  const opencode = new Map<string, { seq: number; ledger: Ledger }>();
  return {
    of(session: Session): Ledger {
      if (!session.id || session.place.kind === "cloud") return empty;
      if (session.agent === "opencode") {
        const path = opencodeDatabase();
        if (!/^[A-Za-z0-9_-]+$/.test(session.id) || !existsSync(path)) return empty;
        try {
          const next = opencodeLedger(path, session.id, session.cwd, opencode.get(session.id));
          opencode.set(session.id, next);
          return next.ledger;
        } catch {
          return opencode.get(session.id)?.ledger ?? empty;
        }
      }
      const file = transcriptFile(session);
      if (!file) return empty;
      try {
        const scan = scanEdits(file.path, file.agent, scans.get(file.path));
        scans.set(file.path, scan);
        return scan.ledger;
      } catch {
        // A transcript that is gone or unreadable keeps what was read of it.
        return scans.get(file.path)?.ledger ?? empty;
      }
    },
    /** Forget every session but `listed`, so a closed one's ledger does not stay in memory. */
    sweep(listed: readonly Session[]) {
      const keep = new Set(
        listed.flatMap((session) =>
          session.agent === "opencode" ? [`opencode:${session.id}`] : [transcriptFile(session)?.path ?? ""],
        ),
      );
      for (const path of scans.keys()) if (!keep.has(path)) scans.delete(path);
      for (const id of opencode.keys()) if (!keep.has(`opencode:${id}`)) opencode.delete(id);
    },
  };
}

/** What one turn changed in one file. A whole-file write records no removed lines, so `removed` means nothing then. */
export type FileSummary = {
  file: string;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
  rewritten: boolean;
  edits: number;
};

export type TurnSummary = {
  turn: number;
  prompt: string;
  at?: number;
  files: FileSummary[];
  added: number;
  removed: number;
  /** Some file was rewritten whole, so `removed` undercounts. */
  rewritten: boolean;
};

/** Lines added and removed, with the removed count left out where a whole-file write makes it unknown. */
export const lineCounts = (summary: { added: number; removed: number; rewritten: boolean }) =>
  summary.rewritten ? `+${summary.added}` : `+${summary.added} -${summary.removed}`;

/** What happened to a file besides its line counts: made, deleted or rewritten whole. */
export const fileChange = (file: FileSummary) =>
  file.created ? "new " : file.deleted ? "deleted " : file.rewritten ? "rewritten " : "";

/** Each turn that edited something, newest first, with the files it touched in the order it first touched them. */
export function turnSummaries(ledger: Ledger): TurnSummary[] {
  const byTurn = new Map<number, Map<string, FileSummary>>();
  for (const edit of ledger.edits) {
    const files = byTurn.get(edit.turn) ?? new Map<string, FileSummary>();
    byTurn.set(edit.turn, files);
    const summary = files.get(edit.file) ?? {
      file: edit.file,
      added: 0,
      removed: 0,
      created: false,
      deleted: false,
      rewritten: false,
      edits: 0,
    };
    files.set(edit.file, summary);
    summary.edits++;
    if (edit.change === "create") summary.created = true;
    if (edit.change === "delete") summary.deleted = true;
    if (edit.change === "write") summary.rewritten = true;
    for (const hunk of edit.hunks)
      for (const line of hunk.lines) {
        if (line[0] === "+") summary.added++;
        else if (line[0] === "-") summary.removed++;
      }
  }
  return [...byTurn]
    .sort(([a], [b]) => b - a)
    .map(([turn, files]) => {
      const list = [...files.values()];
      const first = ledger.turns[turn];
      return {
        turn,
        prompt: first?.prompt ?? "",
        at: first?.at ?? ledger.edits.find((edit) => edit.turn === turn)?.at,
        files: list,
        added: list.reduce((sum, file) => sum + file.added, 0),
        removed: list.reduce((sum, file) => sum + file.removed, 0),
        rewritten: list.some((file) => file.rewritten),
      };
    });
}

/** Who made an edit: the session, and the prompt it was answering. */
export type Writer = { session: Session; turn?: Turn };

/**
 * Every edit the given sessions made to `file`, oldest first. Each session's own edits keep transcript order; edits
 * from different sessions interleave by time, and an edit with no time sorts with its session's previous one.
 */
export function fileHistory(sessions: readonly Session[], read: (session: Session) => Ledger, file: string) {
  const all: { edit: FileEdit; owner: Writer; at: number; order: number }[] = [];
  let order = 0;
  for (const session of sessions) {
    const ledger = read(session);
    let at = 0;
    for (const edit of ledger.edits) {
      at = edit.at ?? at;
      if (edit.file === file) all.push({ edit, owner: { session, turn: ledger.turns[edit.turn] }, at, order: order++ });
    }
  }
  return all.sort((a, b) => a.at - b.at || a.order - b.order).map(({ edit, owner }) => ({ edit, owner }));
}
