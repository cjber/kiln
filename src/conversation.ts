import { closeSync, openSync, readSync, statSync } from "node:fs";

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
  const lines = text.trim().split("\n");
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
export function readConversation(path: string, cursor?: string, limit = 200): Page {
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
      items.push(...recordItems(JSON.parse(line)));
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
