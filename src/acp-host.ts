import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AcpSessions, type SavedSession } from "./acp";
import { notifySessionEvent } from "./notifications";
import { agents } from "./sessions";
import { loadSettings } from "./settings";

function socketPath(): string {
  return (
    Bun.env.KILN_ACP_SOCKET ||
    join(Bun.env.XDG_RUNTIME_DIR || join(homedir(), ".local", "state", "kiln"), "kiln-acp.sock")
  );
}

export function startAcpHost({ locked = false } = {}) {
  const socket = socketPath();
  mkdirSync(join(socket, ".."), { recursive: true, mode: 0o700 });
  if (locked && existsSync(socket)) {
    const stat = lstatSync(socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("ACP socket path is not an owned socket");
    unlinkSync(socket);
  }
  const statePath = Bun.env.KILN_ACP_SOCKET
    ? `${socket}.json`
    : join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "acp.json");
  mkdirSync(join(statePath, ".."), { recursive: true, mode: 0o700 });
  let saving: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    writeFileSync(`${statePath}.tmp`, JSON.stringify(sessions.saved()), { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  };
  const sessions = new AcpSessions((session, event) => {
    if (session && event) {
      let enabled = false;
      try {
        enabled = loadSettings().notifications;
      } catch {
        /* The TUI reports invalid settings edits; agent turns must continue. */
      }
      if (enabled) notifySessionEvent(session);
    }
    if (!saving)
      saving = setTimeout(() => {
        saving = undefined;
        persist();
      }, 50);
  });
  const saved = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as SavedSession[]) : [];
  for (const record of saved) sessions.disconnected(record, "Restoring ACP session…");
  const server = Bun.serve({
    unix: socket,
    maxRequestBodySize: 8192,
    async fetch(request, server) {
      server.timeout(request, 120);
      const path = new URL(request.url).pathname;
      try {
        if (request.method === "GET" && path === "/health") return Response.json({ pid: process.pid, version: 1 });
        if (request.method === "GET" && path === "/sessions") return Response.json(sessions.list());
        const match = path.match(/^\/sessions\/([a-zA-Z0-9-]+)(?:\/(prompt|approve|cancel|close))?$/);
        if (request.method === "GET" && match?.[1]) return Response.json(sessions.get(match[1]));
        if (request.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 });
        const body = (await request.json()) as Record<string, unknown>;
        if (path === "/sessions") {
          if (!agents.includes(body?.agent as (typeof agents)[number]) || typeof body.cwd !== "string")
            throw new Error("Invalid session request");
          const settings = loadSettings();
          return Response.json(
            await sessions.create(
              body.agent as (typeof agents)[number],
              body.cwd,
              settings.agents[body.agent as keyof typeof settings.agents],
            ),
          );
        }
        if (!match?.[1]) return Response.json({ error: "Not found" }, { status: 404 });
        const id = match[1];
        switch (match[2]) {
          case "prompt":
            if (typeof body?.text !== "string") throw new Error("Invalid prompt");
            sessions.prompt(id, body.text);
            break;
          case "approve":
            if (typeof body?.approvalId !== "string" || typeof body?.optionId !== "string")
              throw new Error("Invalid approval");
            sessions.approve(id, body.approvalId, body.optionId);
            break;
          case "cancel":
            await sessions.cancel(id);
            break;
          case "close":
            sessions.close(id);
            break;
          default:
            return Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "ACP request failed" }, { status: 400 });
      }
    },
  });
  chmodSync(socket, 0o600);
  const restoring = Promise.all(
    saved.map(async (record) => {
      try {
        await sessions.create(
          record.conversation.session.agent,
          record.conversation.session.cwd,
          record.command,
          record,
        );
      } catch (error) {
        if (!sessions.list().some((session) => session.id === record.conversation.session.id)) return;
        sessions.disconnected(
          record,
          `Cannot restore ACP session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  void restoring.catch(() => {});

  return {
    stop() {
      if (saving) clearTimeout(saving);
      persist();
      sessions.stop();
      server.stop(true);
    },
  };
}

export async function acpRequest<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`http://localhost${path}`, {
    unix: socketPath(),
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : undefined,
  });
  const value = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(value.error || "ACP host request failed");
  return value as T;
}

export async function ensureAcpHost(): Promise<void> {
  try {
    await acpRequest("/sessions");
    return;
  } catch {
    /* No host yet. Bind remains exclusive if another client starts it. */
  }
  const command = process.execPath.endsWith("bun")
    ? [process.execPath, join(import.meta.dir, "index.tsx"), "acp-host"]
    : [process.execPath, "acp-host"];
  const socket = socketPath();
  mkdirSync(join(socket, ".."), { recursive: true, mode: 0o700 });
  if (!Bun.which("flock")) throw new Error("Starting the ACP host requires flock (util-linux)");
  const child = Bun.spawn(["flock", "--nonblock", "--close", `${socket}.lock`, ...command, "--locked"], {
    env: Bun.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    await Bun.sleep(100);
    try {
      await acpRequest("/sessions");
      return;
    } catch {}
  }
  throw new Error("Could not start kiln's ACP session host");
}
