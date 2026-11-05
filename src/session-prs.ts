import { closeSync, openSync, readSync, statSync } from "node:fs";
import { transcriptFile } from "./conversation";
import type { Session } from "./sessions";

/** One call reads at most this much of a transcript; a long one is caught up over the next refreshes. */
const stepBytes = 8 * 1024 * 1024;
const pullUrl = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
/**
 * `gh pr create` run as a command: at the start of the command or after `;`, `&&`, `||`, `|`, `(` or `$(`, optionally
 * behind variable assignments. A search such as `grep 'gh pr create'` names it inside quotes and does not count.
 */
const creates = /(?:^|[\n;&|(]|\$\()\s*(?:[A-Za-z_]\w*=\S*\s+)*gh\s+pr\s+create\b/;

type Scan = { inode: number; offset: number; calls: Set<string>; urls: string[] };

const text = (value: unknown): string =>
  typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join(" ") : "";

/** The shell commands a Codex call runs: `cmd` or `command` in its arguments, or every `cmd:` in a code-mode script. */
function codexCommands(payload: Record<string, unknown>): string[] {
  if (payload.type === "function_call")
    try {
      const input = JSON.parse(String(payload.arguments)) as Record<string, unknown>;
      return [text(input.cmd ?? input.command)];
    } catch {
      return [];
    }
  return [...String(payload.input ?? "").matchAll(/\bcmd:\s*"((?:[^"\\]|\\.)*)"/g)].flatMap((match) => {
    try {
      return [JSON.parse(`"${match[1]}"`) as string];
    } catch {
      return [];
    }
  });
}

/** The tool call ids in one record that run `gh pr create`, for Claude, Codex and Pi records. */
function createCalls(record: Record<string, unknown>): string[] {
  const payload = record.payload as Record<string, unknown> | undefined;
  if (record.type === "response_item" && payload && typeof payload.call_id === "string")
    return (payload.type === "function_call" || payload.type === "custom_tool_call") &&
      codexCommands(payload).some((command) => creates.test(command))
      ? [payload.call_id]
      : [];
  // Claude `tool_use` and Pi `toolCall` parts carry the command in `input` or `arguments`.
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    (part?.type === "tool_use" || part?.type === "toolCall") &&
    typeof part.id === "string" &&
    creates.test(text((part.input ?? part.arguments)?.command))
      ? [part.id]
      : [],
  );
}

/** The tool call ids one record answers. */
function resultCalls(record: Record<string, unknown>): string[] {
  const payload = record.payload as Record<string, unknown> | undefined;
  if (record.type === "response_item" && payload && typeof payload.call_id === "string")
    return String(payload.type).endsWith("_output") ? [payload.call_id] : [];
  const message = record.message as { role?: unknown; toolCallId?: unknown; content?: unknown } | undefined;
  if (message?.role === "toolResult" && typeof message.toolCallId === "string") return [message.toolCallId];
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((part) =>
    part?.type === "tool_result" && typeof part.tool_use_id === "string" ? [part.tool_use_id] : [],
  );
}

/** Reads the transcript from the scan's offset and records the pull request URLs its `gh pr create` calls printed. */
export function scanTranscript(path: string, scan?: Scan): Scan {
  const info = statSync(path);
  // A replaced or truncated transcript is read again from the start.
  const state =
    scan && scan.inode === info.ino && scan.offset <= info.size
      ? scan
      : { inode: info.ino, offset: 0, calls: new Set<string>(), urls: [] };
  const end = Math.min(info.size, state.offset + stepBytes);
  if (end <= state.offset) return state;
  const bytes = Buffer.alloc(end - state.offset);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, state.offset + read);
      if (!count) break;
      read += count;
    }
  } finally {
    closeSync(fd);
  }
  // Only complete lines are consumed; a line still being written is read on the next call.
  const last = bytes.lastIndexOf(10);
  if (last === -1) {
    // One line longer than a whole step holds a pasted file, not a command; skip past it rather than stall.
    if (bytes.length === stepBytes) state.offset += bytes.length;
    return state;
  }
  for (const line of bytes
    .subarray(0, last + 1)
    .toString("utf8")
    .split("\n")) {
    // Most lines name neither, and are never parsed.
    const call = line.includes("gh pr create");
    if (!call && !line.includes("/pull/")) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex records each finished command with its output in one event, whichever call started it.
    const done = (record.payload as { item?: { type?: unknown; command?: unknown; aggregated_output?: unknown } })
      ?.item;
    if (done?.type === "CommandExecution") {
      // The command is the shell and its flags, then the command line itself.
      const command = Array.isArray(done.command) ? done.command.at(-1) : done.command;
      if (creates.test(text(command)))
        for (const url of String(done.aggregated_output ?? "").match(pullUrl) ?? [])
          if (!state.urls.includes(url)) state.urls.push(url);
      continue;
    }
    if (call) for (const id of createCalls(record)) state.calls.add(id);
    if (resultCalls(record).some((id) => state.calls.has(id)))
      for (const url of line.match(pullUrl) ?? []) if (!state.urls.includes(url)) state.urls.push(url);
  }
  state.offset += last + 1;
  return state;
}

/** The pull requests each local session opened, read from its transcript and kept between refreshes. */
export function openedPullRequests() {
  const scans = new Map<string, Scan>();
  const used = new Set<string>();
  return {
    of(session: Session): string[] {
      const file = transcriptFile(session);
      if (!file) return [];
      used.add(file.path);
      try {
        const scan = scanTranscript(file.path, scans.get(file.path));
        scans.set(file.path, scan);
        return scan.urls;
      } catch {
        // A transcript that is gone or unreadable has opened nothing kiln can show.
        return scans.get(file.path)?.urls ?? [];
      }
    },
    /** Forgets transcripts no session asked about since the last sweep. */
    sweep() {
      for (const path of scans.keys()) if (!used.has(path)) scans.delete(path);
      used.clear();
    },
  };
}
