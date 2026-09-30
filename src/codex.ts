import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Activity } from "./sessions";

/** A thread loaded on Codex's shared app-server daemon: every live `codex` TUI has one, and `codex agents` starts more. */
export type CodexThread = {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt?: number;
  activity?: Activity;
  title?: string;
};

type ThreadStatus =
  | { type: "notLoaded" | "idle" | "systemError" }
  | { type: "active"; activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[] };

type Thread = {
  name?: string | null;
  preview?: string;
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

type Call = <T>(method: string, params: object) => Promise<T>;

/** Bound the connection lifetime, including initialization, and close timed-out sockets. */
async function rpc<T>(socket: string, action: (call: Call) => Promise<T>): Promise<T> {
  const ws = new WebSocket(`ws+unix://${socket}`);
  const pending = new Map<number, (reply: Reply) => void>();
  let next = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ws.close();
      reject(new Error("the Codex daemon did not answer"));
    }, timeoutMs);
  });
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
    if (reply.id !== undefined) {
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    }
  };
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error(`cannot connect to ${socket}`));
      }),
      timeout,
    ]);
    await Promise.race([call("initialize", { clientInfo: { name: "kiln", version: "0" } }), timeout]);
    ws.send(JSON.stringify({ method: "initialized" }));
    return await Promise.race([action(call), timeout]);
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

/** The daemon's loaded top-level threads; without a running daemon there are none. */
export async function codexThreads(localIds: readonly string[] = []): Promise<CodexThread[]> {
  const socket = controlSocket();
  if (!existsSync(socket)) return [];
  let threads: Thread[];
  try {
    threads = await rpc(socket, async (call) => {
      const loaded = await call<{ data: string[] }>("thread/loaded/list", {});
      if (!loaded.data.length && !localIds.length) return [];
      const archived = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: { data: { id: string }[]; nextCursor: string | null } = await call("thread/list", {
          archived: true,
          useStateDbOnly: true,
          sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
          limit: 100,
          cursor,
        });
        for (const thread of page.data) archived.add(thread.id);
        cursor = page.nextCursor;
      } while (cursor);
      const read = await Promise.all(
        [...new Set([...loaded.data, ...localIds])]
          .filter((id) => !archived.has(id))
          .map(async (threadId) => {
            try {
              return (await call<{ thread: Thread }>("thread/read", { threadId })).thread;
            } catch (error) {
              if (loaded.data.includes(threadId)) throw error;
              return undefined;
            }
          }),
      );
      return read.filter((thread): thread is Thread => thread !== undefined);
    });
  } catch {
    // A socket left behind by a stopped daemon refuses the connection; that is no daemon, not a fault.
    return [];
  }
  return threads.flatMap((thread) => {
    const state = activity(thread.status);
    // Sub-agent threads belong to their parent's session.
    if (thread.parentThreadId || (!state && !localIds.includes(thread.id))) return [];
    return [
      {
        id: thread.id,
        cwd: thread.cwd,
        createdAt: thread.createdAt * 1000,
        updatedAt: thread.updatedAt * 1000,
        activity: state,
        title: (thread.name || thread.preview)?.replace(/\s+/g, " ").trim().slice(0, 160),
      },
    ];
  });
}

/** Archive through the daemon, retaining history and letting Codex manage its descendants. */
export async function archiveCodexThread(threadId: string): Promise<void> {
  await rpc(controlSocket(), (call) => call("thread/archive", { threadId }));
}
