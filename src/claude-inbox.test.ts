import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeBackgroundAgentRunning,
  claudeInbox,
  claudeRecord,
  claudeShellRunning,
  InboxClosed,
  sendClaudeInbox,
} from "./claude-inbox";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function configDir(): string {
  const root = mkdtempSync(join(tmpdir(), "kiln-claude-"));
  roots.push(root);
  mkdirSync(join(root, "sessions"));
  return root;
}

const token = "0123456789abcdef0123456789abcdef";

/** A session record as a print-mode Claude leaves it: `busy` from launch, with its inbox socket and key beside it. */
function fakeSession(dir: string, pid: number, socket: string, procStart = "4242"): void {
  writeFileSync(
    join(dir, "sessions", `${pid}.json`),
    JSON.stringify({ pid, status: "busy", entrypoint: "sdk-cli", messagingSocketPath: socket, procStart }),
  );
  const hash = createHash("sha256").update(socket).digest("hex");
  writeFileSync(join(dir, "sessions", `${pid}.${hash}.key`), JSON.stringify({ peerToken: token, procStart }));
}

test("a session's record gives its status and inbox, and a key left under a reused pid is not its own", () => {
  const dir = configDir();
  fakeSession(dir, 7, "/run/user/1000/cc-socks/7.sock");
  writeFileSync(join(dir, "sessions", "8.json"), "{");
  writeFileSync(join(dir, "sessions", "9.json"), JSON.stringify({ pid: 9, status: "shell" }));
  expect(claudeRecord(7, dir)).toEqual({
    status: "busy",
    entrypoint: "sdk-cli",
    messagingSocketPath: "/run/user/1000/cc-socks/7.sock",
  });
  expect(claudeRecord(8, dir)).toEqual({});
  expect(claudeRecord(9, dir).status).toBe("shell");
  expect(claudeInbox(7, dir, () => 4242)).toEqual({ socket: "/run/user/1000/cc-socks/7.sock", token });
  expect(claudeInbox(7, dir, () => 5000)).toBeUndefined();
  // No socket, or no key for it: Claude's messaging is off for that session.
  expect(claudeInbox(9, dir, () => 4242)).toBeUndefined();
  fakeSession(dir, 10, "/run/user/1000/cc-socks/10.sock");
  writeFileSync(join(dir, "sessions", "10.json"), JSON.stringify({ messagingSocketPath: "/elsewhere.sock" }));
  expect(claudeInbox(10, dir, () => 4242)).toBeUndefined();
});

test("a Claude process runs a background shell while a child of it sources the session's shell snapshot", async () => {
  const dir = configDir();
  const other = Bun.spawn(["sh", "-c", "sleep 30; :"]);
  try {
    expect(claudeShellRunning(process.pid, dir)).toBe(false);
    const shell = Bun.spawn(["sh", "-c", `sleep 30; : ${join(dir, "shell-snapshots", "snapshot-sh-1.sh")}`]);
    expect(claudeShellRunning(process.pid, dir)).toBe(true);
    shell.kill();
    await shell.exited;
    expect(claudeShellRunning(process.pid, dir)).toBe(false);
  } finally {
    other.kill();
    await other.exited;
  }
  expect(claudeShellRunning(2 ** 22 + 1, dir)).toBe(false);
});

test("a message counts as delivered once Claude records queueing it, and a closed inbox takes nothing", async () => {
  const dir = configDir();
  const socket = join(dir, "inbox.sock");
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "hi" })}\n`);
  let record = true;
  const received: string[] = [];
  const server = createServer((connection) => {
    let data = "";
    connection.on("data", (chunk) => {
      data += chunk;
    });
    connection.on("end", () => {
      received.push(data);
      const content = JSON.parse(data.trimEnd().split("\n")[1] ?? "{}").message?.content;
      // Claude writes this record only for a message it accepts; a held, refused or dropped one leaves none.
      if (record)
        appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", content })}\n`);
      connection.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await sendClaudeInbox({ socket, token }, "[kiln message from terminal]\n\nhi", transcript);
    expect(
      received.map((data) =>
        data
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ),
    ).toEqual([
      [
        { type: "auth", token },
        { type: "user", message: { role: "user", content: "[kiln message from terminal]\n\nhi" } },
      ],
    ]);
    // An earlier record of the same text does not count for this send.
    record = false;
    const refused = sendClaudeInbox({ socket, token }, "hi", transcript, 300);
    await expect(refused).rejects.toThrow("held, refused or dropped");
    await expect(refused).rejects.not.toBeInstanceOf(InboxClosed);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await expect(sendClaudeInbox({ socket, token }, "hi", transcript)).rejects.toBeInstanceOf(InboxClosed);
});

test("a workflow counts as running until each agent it started has a result or failed", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-workflows-"));
  const transcript = join(root, "s1.jsonl");
  const run = join(root, "s1", "subagents", "workflows", "wf_1");
  mkdirSync(run, { recursive: true });
  const journal = (...entries: object[]) =>
    writeFileSync(join(run, "journal.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  journal({ type: "launched" });
  expect(claudeBackgroundAgentRunning(transcript, 0)).toBe(false);
  journal({ type: "launched" }, { type: "started", agentId: "a1" }, { type: "started", agentId: "a2" });
  expect(claudeBackgroundAgentRunning(transcript, 0)).toBe(true);
  // One launched before this process started belongs to an earlier run.
  expect(claudeBackgroundAgentRunning(transcript, Date.now() + 60_000)).toBe(false);
  journal({ type: "started", agentId: "a1" }, { type: "started", agentId: "a2" }, { type: "result", agentId: "a1" });
  expect(claudeBackgroundAgentRunning(transcript, 0)).toBe(true);
  journal(
    { type: "started", agentId: "a1" },
    { type: "started", agentId: "a2" },
    { type: "result", agentId: "a1" },
    { type: "failed", agentId: "a2" },
  );
  expect(claudeBackgroundAgentRunning(transcript, 0)).toBe(false);
  rmSync(root, { recursive: true });
});

test("a background agent counts as running until its meta file says it finished", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-agents-"));
  const transcript = join(root, "s1.jsonl");
  mkdirSync(join(root, "s1", "subagents"), { recursive: true });
  const meta = join(root, "s1", "subagents", "agent-a1.meta.json");
  expect(claudeBackgroundAgentRunning(transcript, 0)).toBe(false);
  writeFileSync(meta, JSON.stringify({ requestShape: "background" }));
  expect(claudeBackgroundAgentRunning(transcript, 0)).toBe(true);
  // One launched before this process started belongs to an earlier run.
  expect(claudeBackgroundAgentRunning(transcript, Date.now() + 60_000)).toBe(false);
  writeFileSync(meta, JSON.stringify({ requestShape: "background", finished: true }));
  expect(claudeBackgroundAgentRunning(transcript, 0)).toBe(false);
  writeFileSync(meta, JSON.stringify({ requestShape: "foreground" }));
  expect(claudeBackgroundAgentRunning(transcript, 0)).toBe(false);
  rmSync(root, { recursive: true });
});
