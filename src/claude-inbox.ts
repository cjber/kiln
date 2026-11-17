import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { processStartTicks } from "./sessions";

export const claudeConfigDir = () => Bun.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

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

/**
 * Put a prompt in a Claude session's inbox, as one session messages another. Claude queues it while a turn runs and
 * starts a turn with it otherwise, including in print mode while it waits on background work or a wakeup.
 */
export function sendClaudeInbox(inbox: ClaudeInbox, text: string, timeoutMs = 5_000): Promise<void> {
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
