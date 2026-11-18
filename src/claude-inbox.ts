import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { processStartTicks } from "./sessions";

export const claudeConfigDir = () => Bun.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Where Claude writes a session's transcript: under the directory it started in, named by its session id. */
export function claudeTranscript(cwd: string, sessionId: string | undefined): string | undefined {
  if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  return join(claudeConfigDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/**
 * The transcript of the Claude conversation `id`, or undefined when Claude has none to resume. Claude files it under the
 * directory the conversation began in; `cwd`, when known, is tried first, and otherwise it is found by the id alone.
 */
export function findClaudeTranscript(id: string, cwd?: string): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return undefined;
  const direct = cwd === undefined ? undefined : claudeTranscript(cwd, id);
  if (direct && existsSync(direct)) return direct;
  let path: string | undefined;
  try {
    for (const match of new Bun.Glob(`*/${id}.jsonl`).scanSync({ cwd: join(claudeConfigDir(), "projects") }))
      path = join(claudeConfigDir(), "projects", match);
  } catch {
    // No projects directory holds no conversations.
  }
  return path;
}

/** What kiln reads from the record Claude keeps for each running session, `sessions/<pid>.json`. */
export type ClaudeRecord = { status?: string; entrypoint?: string; messagingSocketPath?: string };

/** A session's record, or nothing of it once the process has gone. */
export function claudeRecord(pid: number, dir = claudeConfigDir()): ClaudeRecord {
  try {
    const { status, entrypoint, messagingSocketPath } = JSON.parse(
      readFileSync(join(dir, "sessions", `${pid}.json`), "utf8"),
    );
    return {
      status: typeof status === "string" ? status : undefined,
      entrypoint: typeof entrypoint === "string" ? entrypoint : undefined,
      messagingSocketPath: typeof messagingSocketPath === "string" ? messagingSocketPath : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Whether a Claude process still runs a shell of its Bash tool, as a turn that started background work leaves it. Each
 * of those shells is a child that sources the session's snapshot from `shell-snapshots` under Claude's config directory.
 */
export function claudeShellRunning(pid: number, dir = claudeConfigDir()): boolean {
  const snapshots = `${join(dir, "shell-snapshots")}/`;
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  let threads: string[];
  try {
    threads = readdirSync(`/proc/${pid}/task`);
  } catch {
    return false;
  }
  return threads
    .flatMap((thread) => read(`/proc/${pid}/task/${thread}/children`).split(" ").filter(Boolean))
    .some((child) => read(`/proc/${child}/cmdline`).includes(snapshots));
}

/** The socket a Claude session reads other sessions' messages from, and the token that lets a sender in. */
export type ClaudeInbox = { socket: string; token: string };

/**
 * A session's inbox, from its record. Claude publishes the token for each socket beside the record as
 * `<pid>.<sha256 of the socket path>.key`, stamped with its process start, so a key a dead process left behind under a
 * reused pid is not this session's.
 */
export function claudeInbox(pid: number, dir = claudeConfigDir(), start = processStartTicks): ClaudeInbox | undefined {
  const socket = claudeRecord(pid, dir).messagingSocketPath;
  if (!socket) return undefined;
  const hash = createHash("sha256").update(socket).digest("hex");
  try {
    const { peerToken, procStart } = JSON.parse(readFileSync(join(dir, "sessions", `${pid}.${hash}.key`), "utf8"));
    if (typeof peerToken !== "string" || !/^[0-9a-f]{32}$/.test(peerToken)) return undefined;
    if (procStart !== undefined && Number(procStart) !== start(pid)) return undefined;
    return { socket, token: peerToken };
  } catch {
    return undefined;
  }
}

/** Nothing reached the inbox, so the message can simply be sent again later. */
export class InboxClosed extends Error {}

/** The inbox took the message and Claude did not queue it: it held, refused or dropped it. */
export class ClaudeNotQueued extends Error {}

/**
 * Put a prompt in a Claude session's inbox, as one session messages another. Claude queues it while a turn runs and
 * starts a turn with it otherwise, including in print mode while it waits on background work or a wakeup.
 *
 * Claude can also hold, refuse or drop a peer message, and sends that receipt only to the sender's own inbox, which
 * kiln does not have. What it does write for every message it accepts is a `queue-operation` enqueue record in the
 * session's transcript, so the message counts as delivered only once that record appears.
 */
export async function sendClaudeInbox(
  inbox: ClaudeInbox,
  text: string,
  transcript: string,
  timeoutMs = 5_000,
): Promise<void> {
  const offset = fileSize(transcript);
  await writeInbox(inbox, text, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (!queued(transcript, offset, text)) {
    if (Date.now() >= deadline) throw new ClaudeNotQueued("Claude did not queue it, so it held, refused or dropped it");
    await Bun.sleep(100);
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Whether the transcript, after `offset`, records Claude queueing `text`. */
function queued(transcript: string, offset: number, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(transcript, "r");
  } catch {
    return false;
  }
  try {
    const bytes = Buffer.alloc(Math.max(0, fstatSync(fd).size - offset));
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    return bytes
      .subarray(0, count)
      .toString()
      .split("\n")
      .some((line) => {
        if (!line.includes('"queue-operation"')) return false;
        try {
          const record = JSON.parse(line);
          return record.type === "queue-operation" && record.operation === "enqueue" && record.content === text;
        } catch {
          return false;
        }
      });
  } finally {
    closeSync(fd);
  }
}

function writeInbox(inbox: ClaudeInbox, text: string, timeoutMs: number): Promise<void> {
  const lines = [
    { type: "auth", token: inbox.token },
    { type: "user", message: { role: "user", content: text } },
  ].map((line) => `${JSON.stringify(line)}\n`);
  return new Promise((resolve, reject) => {
    let connected = false;
    const connection = createConnection(inbox.socket);
    connection.setTimeout(timeoutMs, () =>
      connection.destroy(new Error("Claude's inbox did not close the connection")),
    );
    connection.once("connect", () => {
      connected = true;
      connection.end(lines.join(""));
    });
    connection.once("error", (error) =>
      reject(connected ? error : new InboxClosed(`Claude's inbox is closed: ${error.message}`)),
    );
    // Claude closes its end once it has read every line.
    connection.once("close", (failed) => {
      if (!failed) resolve();
    });
  });
}
