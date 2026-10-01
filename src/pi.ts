import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PiBridge = { pid: number; socket: string; startedAt: number };
export type PiState = {
  instance: string;
  sequence: number;
  sessionId: string;
  cwd: string;
  title?: string;
  activity: "working" | "idle";
  updatedAt?: number;
  messages?: { role: string; text: string }[];
  writer?: string;
  localAction: string;
};

function owned(path: string, kind: "directory" | "socket" | "file", mode: number) {
  const info = lstatSync(path);
  return (
    info.uid === process.getuid?.() &&
    (info.mode & 0o777) === mode &&
    (kind === "directory" ? info.isDirectory() : kind === "socket" ? info.isSocket() : info.isFile())
  );
}

/** Only private descriptors belonging to the same live process may identify a bridge. */
export function piBridges(root = Bun.env.XDG_RUNTIME_DIR || tmpdir()): PiBridge[] {
  return verifiedBridges(root, readdirSync(root));
}

function verifiedBridges(root: string, names: readonly string[]): PiBridge[] {
  return names
    .filter((name) => name.startsWith("kiln-pi-"))
    .slice(0, 64)
    .flatMap((name) => {
      const directory = join(root, name);
      const descriptor = join(directory, "session.json");
      try {
        if (!owned(directory, "directory", 0o700) || !owned(descriptor, "file", 0o600)) return [];
        if (lstatSync(descriptor).size > 4096) return [];
        const data = JSON.parse(readFileSync(descriptor, "utf8")) as PiBridge;
        if (!Number.isSafeInteger(data.pid) || data.pid < 1 || data.socket !== join(directory, "control.sock"))
          return [];
        const processInfo = lstatSync(`/proc/${data.pid}`);
        if (
          processInfo.uid !== process.getuid?.() ||
          Math.trunc(processInfo.mtimeMs) !== data.startedAt ||
          !owned(data.socket, "socket", 0o600)
        )
          return [];
        return [data];
      } catch (error) {
        if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || error instanceof SyntaxError)
          return [];
        throw error;
      }
    });
}

export function piRequest<T>(
  bridge: PiBridge,
  command: object,
  timeout = 500,
  requestId: string = randomUUID(),
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(bridge.socket);
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("Pi bridge did not respond")), timeout);
    function finish(error?: Error, data?: T) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(data as T);
    }
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...command, id: requestId })}\n`));
    socket.once("error", () => finish(new Error("Cannot connect to the Pi bridge")));
    socket.once("end", () => finish(new Error("Pi bridge closed the connection")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1_048_576) return finish(new Error("Pi response is too large"));
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const reply = JSON.parse(line);
          if (reply.type !== "response" || reply.id !== requestId) continue;
          finish(
            reply.success
              ? undefined
              : new Error(typeof reply.error === "string" ? reply.error.slice(0, 240) : "Pi rejected the command"),
            reply.data,
          );
          return;
        } catch {
          return finish(new Error("Invalid Pi response"));
        }
      }
    });
  });
}

export async function piStates(pids: readonly number[]): Promise<Map<number, PiState>> {
  if (!pids.length) return new Map();
  const root = Bun.env.XDG_RUNTIME_DIR || tmpdir();
  const bridges = verifiedBridges(root, await readdir(root)).filter((bridge) => pids.includes(bridge.pid));
  const states = await Promise.all(
    bridges.map(async (bridge) => {
      try {
        const state = await piRequest<PiState>(bridge, { type: "get_state" }, 300);
        if (
          typeof state.sessionId !== "string" ||
          typeof state.cwd !== "string" ||
          !["working", "idle"].includes(state.activity)
        )
          return [];
        return [[bridge.pid, state] as const];
      } catch {
        return [];
      }
    }),
  );
  return new Map(states.flat());
}

export function bridgeFor(pid: number | undefined): PiBridge {
  const bridge = piBridges().find((bridge) => bridge.pid === pid);
  if (!bridge || !existsSync(`/proc/${bridge.pid}`))
    throw new Error("Restart this Pi session with kiln's remote extension");
  return bridge;
}
