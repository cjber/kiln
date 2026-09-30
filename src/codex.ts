import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Activity } from "./sessions";

/** A thread loaded on Codex's shared app-server daemon: every live `codex` TUI has one, and `codex agents` starts more. */
export type CodexThread = { id: string; cwd: string; createdAt: number; updatedAt?: number; activity: Activity };

type ThreadStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | { type: "active"; activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[] };

type Thread = {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  parentThreadId: string | null;
  status: ThreadStatus;
};

type Reply = { id?: number; result?: unknown; error?: { message: string } };

const timeoutMs = 1_500;

function controlSocket(): string {
  return join(Bun.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
}

function activity(status: ThreadStatus): Activity | undefined {
  switch (status.type) {
    case "active":
      return status.activeFlags.length ? "waiting" : "working";
    case "idle":
      return "idle";
    // A thread that hit an error has stopped and needs you, the same as one asking a question.
    case "systemError":
      return "waiting";
    case "notLoaded":
      return undefined;
  }
}

/** One JSON-RPC exchange with the daemon: initialize, list the loaded threads, read each one. */
async function rpc(socket: string): Promise<Thread[]> {
  const ws = new WebSocket(`ws+unix://${socket}`);
  const pending = new Map<number, (reply: Reply) => void>();
  let next = 0;
  const call = <T>(method: string, params: object) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, (reply) =>
        reply.error ? reject(new Error(`${method}: ${reply.error.message}`)) : resolve(reply.result as T),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.onmessage = (event) => {
    const reply = JSON.parse(String(event.data)) as Reply;
    if (reply.id !== undefined) pending.get(reply.id)?.(reply);
  };
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`cannot connect to ${socket}`));
    });
    await call("initialize", { clientInfo: { name: "kiln", version: "0" } });
    ws.send(JSON.stringify({ method: "initialized" }));
    const loaded = await call<{ data: string[] }>("thread/loaded/list", {});
    return await Promise.all(
      loaded.data.map(async (threadId) => (await call<{ thread: Thread }>("thread/read", { threadId })).thread),
    );
  } finally {
    ws.close();
  }
}

/** The daemon's loaded top-level threads; without a running daemon there are none. */
export async function codexThreads(): Promise<CodexThread[]> {
  const socket = controlSocket();
  if (!existsSync(socket)) return [];
  let threads: Thread[];
  try {
    threads = await Promise.race([
      rpc(socket),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the Codex daemon did not answer")), timeoutMs),
      ),
    ]);
  } catch {
    // A socket left behind by a stopped daemon refuses the connection; that is no daemon, not a fault.
    return [];
  }
  return threads.flatMap((thread) => {
    const state = activity(thread.status);
    // Sub-agent threads belong to their parent's session.
    if (thread.parentThreadId || !state) return [];
    return [
      {
        id: thread.id,
        cwd: thread.cwd,
        createdAt: thread.createdAt * 1000,
        updatedAt: thread.updatedAt * 1000,
        activity: state,
      },
    ];
  });
}
