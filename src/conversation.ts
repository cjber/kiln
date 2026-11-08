import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeTranscript } from "./native-sessions";
import type { Session } from "./sessions";

/** One line of a session as the phone draws it. `result` items attach to the `tool` item named by `of`. */
export type Item =
  | { id: string; at?: number; kind: "you" | "agent" | "notice"; text: string }
  | { id: string; at?: number; kind: "tool"; tool: string; text: string }
  | { id: string; at?: number; kind: "result"; of: string; text: string; error: boolean };

export type Page = {
  items: Item[];
  /** Pass back to read only what was appended; it names the file and the offset of its last complete line. */
  cursor: string;
  /** The items replace what the phone holds: a first read, or a transcript that was replaced or truncated. */
  reset: boolean;
};

/** A first read looks at most this far back, so a long transcript costs the same as a short one. */
const tailBytes = 2 * 1024 * 1024;
/** One call reads at most this much new text; the next call continues from the cursor. */
const stepBytes = 4 * 1024 * 1024;
const textLimit = 4_000;
const resultLines = 6;

const clip = (text: string, limit = textLimit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** The one field that says what a tool call does: a command, a path, a pattern or a question. */
function summary(input: Record<string, unknown>): string {
  for (const key of ["description", "command", "file_path", "path", "pattern", "url", "query", "prompt", "skill"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return clip(value.trim(), 300);
  }
  return "";
}

function resultText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n")
        : "";
  // Terminal colour codes would show as raw text on the phone.
  const lines = Bun.stripANSI(text).trim().split("\n");
  return clip(lines.slice(0, resultLines).join("\n") + (lines.length > resultLines ? "\n…" : ""), 1_000);
}

/** A prompt Claude itself wrote into the turn (a task notification, a command's output) reads as a notice. */
function promptKind(record: Record<string, unknown>, text: string): "you" | "notice" | undefined {
  if (record.isMeta === true) return undefined;
  const origin = (record.origin as { kind?: unknown } | undefined)?.kind;
  if (origin === "human" || record.promptSource === "typed") return "you";
  if (origin !== undefined || record.promptSource === "system") return "notice";
  return text.trimStart().startsWith("<") ? "notice" : "you";
}

/** The items one transcript record holds; records that are not part of the conversation hold none. */
export function recordItems(record: Record<string, unknown>): Item[] {
  if (record.isSidechain === true) return [];
  const uuid = typeof record.uuid === "string" ? record.uuid : "";
  const parsed = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  const at = Number.isNaN(parsed) ? undefined : parsed;
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (record.type === "user") {
    if (typeof content === "string") {
      const kind = promptKind(record, content);
      return kind && content.trim() ? [{ id: uuid, at, kind, text: clip(content.trim()) }] : [];
    }
    if (!Array.isArray(content)) return [];
    return content.flatMap((part, index): Item[] => {
      if (part?.type === "tool_result" && typeof part.tool_use_id === "string")
        return [
          {
            id: `${uuid}:${index}`,
            at,
            kind: "result",
            of: part.tool_use_id,
            text: resultText(part.content),
            error: part.is_error === true,
          },
        ];
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        const kind = promptKind(record, part.text);
        return kind ? [{ id: `${uuid}:${index}`, at, kind, text: clip(part.text.trim()) }] : [];
      }
      return [];
    });
  }
  if (record.type === "assistant" && Array.isArray(content))
    return content.flatMap((part, index): Item[] => {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim())
        return [{ id: `${uuid}:${index}`, at, kind: "agent", text: clip(part.text.trim()) }];
      if (part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string")
        return [{ id: part.id, at, kind: "tool", tool: part.name, text: summary(part.input ?? {}) }];
      return [];
    });
  return [];
}

function parseCursor(cursor: string | undefined): { inode: number; offset: number } | undefined {
  const match = cursor?.match(/^(\d+):(\d+)$/);
  return match ? { inode: Number(match[1]), offset: Number(match[2]) } : undefined;
}

/**
 * Read a Claude transcript as phone items. With no cursor, or one for another file or past its end, it returns the
 * last `limit` items of the transcript's tail as a reset; with a cursor, only the complete lines appended since.
 */
export function readConversation(
  path: string,
  cursor?: string,
  limit = 200,
  toItems: (record: Record<string, unknown>) => Item[] = recordItems,
): Page {
  const info = statSync(path);
  const from = parseCursor(cursor);
  const resume = from && from.inode === info.ino && from.offset <= info.size;
  let start = resume ? from.offset : Math.max(0, info.size - tailBytes);
  const end = Math.min(info.size, start + stepBytes);
  const bytes = Buffer.alloc(end - start);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, start + read);
      if (!count) break;
      read += count;
    }
  } finally {
    closeSync(fd);
  }
  let body = bytes;
  // A tail read starts mid-file, so its first line is partial unless it begins the file.
  if (!resume && start > 0) {
    const newline = body.indexOf(10);
    body = newline === -1 ? body.subarray(body.length) : body.subarray(newline + 1);
    start = end - body.length;
  }
  // Only complete lines are consumed; a line still being written is read on the next call.
  const last = body.lastIndexOf(10);
  const complete = last === -1 ? body.subarray(0, 0) : body.subarray(0, last + 1);
  const items: Item[] = [];
  for (const line of complete.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      items.push(...toItems(JSON.parse(line)));
    } catch {
      // A malformed line holds nothing to show.
    }
  }
  return {
    items: resume ? items : items.slice(-limit),
    cursor: `${info.ino}:${start + complete.length}`,
    reset: !resume,
  };
}

const texts = (content: unknown, type: string): string[] =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((part) => (part?.type === type && typeof part.text === "string" ? [part.text] : []))
      : [];

const timestamp = (value: unknown) => {
  const parsed = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Text Codex puts in front of the conversation: AGENTS.md, the environment, skill and plugin listings. */
const codexContext = (text: string) => /^\s*(<|# AGENTS\.md)/.test(text);

/** The command a Codex code-mode `exec` call runs, or the first line of the script. */
function codexScript(input: string): string {
  const command = input.match(/\bcmd:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  if (command)
    try {
      return clip(JSON.parse(`"${command}"`), 300);
    } catch {
      // A command with an escape JSON does not share is shown as written.
    }
  const patched = [...input.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)/g)].map((match) => match[1]);
  if (patched.length) return clip(`Edit ${patched.join(", ")}`, 300);
  return clip(input.trim().split("\n")[0] ?? "", 300);
}

function codexOutput(output: unknown): { text: string; error: boolean } {
  let error = false;
  const parts = (typeof output === "string" ? [output] : texts(output, "input_text"))
    // Code mode wraps every result in a status header that says nothing about the command.
    .map((part) => part.replace(/^(Script completed\n)?(Wall time[^\n]*\n)?(Output:\n)?/, "").trim())
    .map((part) => {
      // A command run through code mode returns its chunk as JSON, with the output in `output`.
      try {
        const chunk = JSON.parse(part);
        if (typeof chunk?.output === "string") {
          error ||= typeof chunk.exit_code === "number" && chunk.exit_code !== 0;
          return chunk.output.trim();
        }
        if (chunk && typeof chunk === "object" && !Object.keys(chunk).length) return "";
      } catch {
        // Plain text, or a chunk Codex cut short.
      }
      return part;
    })
    .filter(Boolean);
  return { text: resultText(parts.join("\n")), error };
}

/** The items one Codex rollout record holds. */
export function codexItems(record: Record<string, unknown>): Item[] {
  if (record.type !== "response_item") return [];
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const at = timestamp(record.timestamp);
  const id = typeof payload.id === "string" ? payload.id : `${record.timestamp}`;
  const call = typeof payload.call_id === "string" ? payload.call_id : undefined;
  switch (payload.type) {
    case "message":
      if (payload.role === "user")
        return texts(payload.content, "input_text")
          .filter((text) => text.trim() && !codexContext(text))
          .map((text, index) => ({ id: `${id}:${index}`, at, kind: "you", text: clip(text.trim()) }));
      if (payload.role === "assistant")
        return texts(payload.content, "output_text")
          .filter((text) => text.trim())
          .map((text, index) => ({ id: `${id}:${index}`, at, kind: "agent", text: clip(text.trim()) }));
      return [];
    case "function_call": {
      if (!call || typeof payload.name !== "string") return [];
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(String(payload.arguments));
      } catch {
        // Arguments that are not JSON leave the tool name alone.
      }
      return [{ id: call, at, kind: "tool", tool: payload.name, text: summary(input) }];
    }
    case "custom_tool_call":
      if (!call || typeof payload.name !== "string") return [];
      return [{ id: call, at, kind: "tool", tool: payload.name, text: codexScript(String(payload.input ?? "")) }];
    case "function_call_output":
    case "custom_tool_call_output":
      return call ? [{ id: `${id}:result`, at, kind: "result", of: call, ...codexOutput(payload.output) }] : [];
    default:
      return [];
  }
}

/** The items one Pi session record holds. */
export function piItems(record: Record<string, unknown>): Item[] {
  if (record.type !== "message") return [];
  const message = (record.message ?? {}) as Record<string, unknown>;
  const at = timestamp(record.timestamp ?? message.timestamp);
  const id = typeof record.id === "string" ? record.id : `${at}`;
  if (message.role === "user")
    return texts(message.content, "text")
      .filter((text) => text.trim())
      .map((text, index) => ({ id: `${id}:${index}`, at, kind: "you", text: clip(text.trim()) }));
  if (message.role === "assistant" && Array.isArray(message.content))
    return message.content.flatMap((part, index): Item[] => {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim())
        return [{ id: `${id}:${index}`, at, kind: "agent", text: clip(part.text.trim()) }];
      if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string")
        return [{ id: part.id, at, kind: "tool", tool: part.name, text: summary(part.arguments ?? {}) }];
      return [];
    });
  if (message.role === "toolResult" && typeof message.toolCallId === "string")
    return [
      {
        id: `${id}:result`,
        at,
        kind: "result",
        of: message.toolCallId,
        text: resultText(message.content),
        error: message.isError === true,
      },
    ];
  return [];
}

/** The items one OpenCode message holds, or undefined while it is still being written. */
export function opencodeItems(id: string, type: string, data: Record<string, unknown>): Item[] | undefined {
  const time = (data.time ?? {}) as { created?: number; completed?: number };
  const at = timestamp(time.created);
  if (type === "user")
    return typeof data.text === "string" && data.text.trim()
      ? [{ id, at, kind: "you", text: clip(data.text.trim()) }]
      : [];
  if (type !== "assistant") return [];
  if (time.completed === undefined) return undefined;
  const content = Array.isArray(data.content) ? data.content : [];
  return content.flatMap((part, index): Item[] => {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim())
      return [{ id: `${id}:${index}`, at, kind: "agent", text: clip(part.text.trim()) }];
    if (part?.type !== "tool" || typeof part.id !== "string" || typeof part.name !== "string") return [];
    const state = (part.state ?? {}) as {
      status?: string;
      input?: Record<string, unknown>;
      content?: unknown;
      error?: unknown;
    };
    const tool: Item = { id: part.id, at, kind: "tool", tool: part.name, text: summary(state.input ?? {}) };
    if (state.status === "error") {
      const error = state.error as { message?: unknown } | string | undefined;
      const text = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "Failed";
      return [tool, { id: `${part.id}:result`, at, kind: "result", of: part.id, text: resultText(text), error: true }];
    }
    if (state.status === "completed")
      return [
        tool,
        { id: `${part.id}:result`, at, kind: "result", of: part.id, text: resultText(state.content), error: false },
      ];
    return [tool];
  });
}

/**
 * Read an OpenCode session from its database, from the message after `cursor` (its sequence number). A message still
 * being written ends the read, so it is read whole on a later call.
 */
export function readOpencodeConversation(path: string, session: string, cursor?: string, limit = 200): Page {
  const db = new Database(path, { readonly: true });
  try {
    const resume = cursor !== undefined && /^\d+$/.test(cursor);
    type Row = { seq: number; id: string; type: string; data: string };
    const rows = resume
      ? db
          .query<Row, [string, number]>(
            "SELECT seq, id, type, data FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 500",
          )
          .all(session, Number(cursor))
      : db
          .query<Row, [string, number]>(
            "SELECT seq, id, type, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
          )
          .all(session, limit * 2)
          .reverse();
    const items: Item[] = [];
    let last = resume ? Number(cursor) : (rows[0]?.seq ?? 1) - 1;
    for (const row of rows) {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(row.data);
      } catch {
        // A malformed message holds nothing to show.
      }
      const next = opencodeItems(row.id, row.type, data);
      if (!next) break;
      items.push(...next);
      last = row.seq;
    }
    return { items: resume ? items : items.slice(-limit), cursor: String(last), reset: !resume };
  } finally {
    db.close();
  }
}

const found = new Map<string, { path?: string; at: number }>();

/** A session file found by a glob, remembered while it exists; a miss is looked for again after half a minute. */
function sessionFile(root: string, pattern: string, now = Date.now()): string | undefined {
  const key = join(root, pattern);
  const known = found.get(key);
  if (known?.path && existsSync(known.path)) return known.path;
  if (known && !known.path && now - known.at < 30_000) return undefined;
  let path: string | undefined;
  try {
    for (const match of new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true })) path = match;
  } catch {
    // A missing directory has no sessions.
  }
  found.set(key, { path, at: now });
  return path;
}

const dataHome = () => Bun.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

/** The database OpenCode keeps every session's messages in. */
export const opencodeDatabase = () => join(dataHome(), "opencode", "opencode.db");

/** The JSONL transcript a local Claude, Codex or Pi session writes, or undefined when it has none kiln can find. */
export function transcriptFile(session: Session): { path: string; agent: "claude" | "codex" | "pi" } | undefined {
  const id = session.id;
  if (!id || session.place.kind === "cloud") return undefined;
  // An id becomes part of a glob, so only the characters provider ids use are accepted.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  let path: string | undefined;
  switch (session.agent) {
    case "claude":
      path = claudeTranscript(session.cwd, id);
      break;
    case "codex":
      path = sessionFile(
        join(Bun.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
        `*/*/*/rollout-*-${id}.jsonl`,
      );
      break;
    case "pi":
      path = sessionFile(
        join(Bun.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions"),
        `*/*_${id}.jsonl`,
      );
      break;
    default:
      return undefined;
  }
  return path ? { path, agent: session.agent } : undefined;
}

/** How to read a session's conversation from what its agent writes to disk, or undefined when kiln cannot. */
export function conversationReader(session: Session): ((cursor?: string) => Page) | undefined {
  if (session.agent === "opencode") {
    if (!session.id || session.place.kind === "cloud" || !/^[A-Za-z0-9_-]+$/.test(session.id)) return undefined;
    const path = opencodeDatabase();
    const id = session.id;
    return existsSync(path) ? (cursor) => readOpencodeConversation(path, id, cursor) : undefined;
  }
  const file = transcriptFile(session);
  if (!file) return undefined;
  const toItems = { claude: recordItems, codex: codexItems, pi: piItems }[file.agent];
  return (cursor) => readConversation(file.path, cursor, undefined, toItems);
}
