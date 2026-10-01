import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { claudeCloudSnapshot } from "./claude-cloud";
import { cloudSnapshot } from "./cloud";
import { codexRemoteHost } from "./codex";
import { Pairing } from "./pairing";
import { phoneHandoff } from "./phone-links";
import { bridgeFor, type PiState, piRequest } from "./pi";
import { sessionTitle } from "./session-list";
import { listSessions, type Session, sessionParents } from "./sessions";
import { loadSettings } from "./settings";

function phoneId(session: Session): string {
  return `${session.agent}:${session.place.kind === "cloud" ? session.place.id : (session.id ?? `${session.pid}:${session.startedAt}`)}`;
}

export function phoneSession(session: Session, parent?: Session, codexHost?: string) {
  return {
    id: phoneId(session),
    parentId: parent ? phoneId(parent) : undefined,
    agent: session.agent,
    title: sessionTitle(session),
    cwd: session.cwd,
    branch: session.branch,
    activity: session.activity,
    startedAt: session.startedAt,
    lastActiveAt: session.lastActiveAt,
    where: session.place.kind,
    piRemote: session.piRemote === true,
    handoff: phoneHandoff(session, codexHost),
  };
}

export function startServer({
  port = 7437,
  pairing = new Pairing(),
  load = () => listSessions(loadSettings()),
  interval = 2_000,
  readCodexHost = codexRemoteHost,
  controlPi = (session: Session, command: object, requestId?: string) =>
    piRequest<PiState>(bridgeFor(session.pid), command, 500, requestId),
} = {}) {
  const instance = randomUUID();
  let snapshot = {
    version: 1,
    instance,
    sequence: 0,
    host: hostname(),
    updatedAt: 0,
    problem: "Loading sessions",
    sessions: [] as ReturnType<typeof phoneSession>[],
  };
  let liveSessions: Session[] = [];
  let refreshing = false;
  let attempts = 0;
  let windowStart = Date.now();
  const sockets = new Set<Bun.ServerWebSocket<{ token: string }>>();
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const server = Bun.serve<{ token: string }>({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 4096,
    async fetch(request, server) {
      if (request.headers.has("Origin")) return response({ error: "Browser requests are not supported" }, 403);
      const path = new URL(request.url).pathname;
      if (path === "/v1/pair" && request.method === "POST") {
        if (Date.now() - windowStart >= 60_000) {
          attempts = 0;
          windowStart = Date.now();
        }
        if (++attempts > 10) return response({ error: "Too many pairing attempts; wait a minute" }, 429);
        if (!request.headers.get("Content-Type")?.startsWith("application/json"))
          return response({ error: "Expected JSON" }, 415);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return response({ error: "Invalid pairing request" }, 400);
        }
        if (
          !body ||
          typeof body !== "object" ||
          !("code" in body) ||
          !("name" in body) ||
          typeof body.code !== "string" ||
          typeof body.name !== "string"
        )
          return response({ error: "Invalid pairing request" }, 400);
        const paired = pairing.exchange(body.code, body.name);
        return paired
          ? response({ ...paired, host: hostname() })
          : response({ error: "Pairing code is invalid, expired or already used" }, 401);
      }
      const token = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      const device = token ? pairing.authenticate(token) : null;
      if (!token || !device) return response({ error: "Device is not paired" }, 401);
      const piRoute = path.match(/^\/v1\/pi\/([A-Za-z0-9_-]{1,128})$/);
      if (piRoute) {
        const session = liveSessions.find((row) => row.agent === "pi" && row.id === piRoute[1] && row.piRemote);
        if (!session) return response({ error: "Pi remote session is unavailable" }, 404);
        try {
          if (request.method === "GET") {
            const state = await controlPi(session, {
              type: "get_state",
              sessionId: session.id,
              transcript: true,
              writer: device.id,
            });
            return response({ ...state, ownWriter: state.writer === device.id });
          }
          if (request.method !== "POST") return response({ error: "Method not supported" }, 405);
          if (!request.headers.get("Content-Type")?.startsWith("application/json"))
            return response({ error: "Expected JSON" }, 415);
          const body = (await request.json()) as { type?: string; message?: string; id?: string };
          if (
            !body ||
            !["prompt", "abort"].includes(body.type ?? "") ||
            typeof body.id !== "string" ||
            !/^[0-9a-f-]{36}$/.test(body.id) ||
            (body.type === "prompt" &&
              (typeof body.message !== "string" || !body.message.trim() || Buffer.byteLength(body.message) > 3500))
          )
            return response({ error: "Expected a prompt or abort command with a request ID" }, 400);
          await controlPi(
            session,
            { type: body.type, message: body.message, sessionId: session.id, writer: device.id },
            body.id,
          );
          return response({ success: true });
        } catch (error) {
          if (error instanceof SyntaxError) return response({ error: "Invalid Pi command JSON" }, 400);
          return response({ error: error instanceof Error ? error.message : "Pi command failed" }, 409);
        }
      }
      if (request.method === "GET" && path === "/v1/sessions") return response(snapshot);
      if (request.method === "GET" && path === "/v1/events") {
        if (server.upgrade(request, { data: { token } })) return;
        return response({ error: "Expected WebSocket" }, 400);
      }
      return response({ error: "Route not found" }, 404);
    },
    websocket: {
      maxPayloadLength: 1024,
      idleTimeout: 30,
      sendPings: true,
      open(socket) {
        sockets.add(socket);
        socket.send(JSON.stringify(snapshot));
      },
      message(socket) {
        socket.close(1008, "This stream is read-only");
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });
  const publish = () => {
    const source = JSON.stringify(snapshot);
    for (const socket of sockets) {
      if (!pairing.authenticate(socket.data.token)) socket.close(4001, "Device pairing revoked");
      else if (socket.send(source) === -1) socket.close(1013, "Client is too slow");
    }
  };
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const [sessions, codexHost] = await Promise.all([load(), readCodexHost()]);
      liveSessions = sessions;
      const parents = sessionParents(sessions);
      snapshot = {
        ...snapshot,
        sequence: snapshot.sequence + 1,
        updatedAt: Date.now(),
        sessions: [
          ...new Map(
            sessions.map((session) => {
              const row = phoneSession(session, parents.get(session), codexHost.id);
              return [row.id, row] as const;
            }),
          ).values(),
        ],
        problem: [cloudSnapshot(false).problem, claudeCloudSnapshot(false).problem, codexHost.problem]
          .filter(Boolean)
          .join("; "),
      };
    } catch {
      snapshot = {
        ...snapshot,
        sequence: snapshot.sequence + 1,
        problem: "Session discovery failed; showing the last successful list",
      };
    } finally {
      refreshing = false;
      publish();
    }
  };
  const timer = setInterval(() => {
    publish();
    void refresh();
  }, interval);
  void refresh();
  return {
    port: server.port,
    stop() {
      clearInterval(timer);
      for (const socket of sockets) socket.close(1001, "Server stopped");
      server.stop(true);
    },
  };
}
