import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { codexRemoteHost } from "./codex";
import type { Pairing } from "./pairing";
import { phoneHandoff } from "./phone-links";
import { sessionTitle } from "./session-list";
import { type Discovered, discovery, type Place, type Session, sessionIdentity, sessionParents } from "./sessions";
import { loadSettings, SettingsError } from "./settings";

/** Phones know one `background` place; kiln's finer kinds stay off the wire so paired apps keep working. */
function wireKind(place: Place): "kiln" | "kitty" | "background" | "elsewhere" | "cloud" {
  switch (place.kind) {
    case "job":
    case "thread":
    case "saved":
      return "background";
    case "kiln":
    case "kitty":
    case "elsewhere":
    case "cloud":
      return place.kind;
  }
}

export function phoneSession(session: Session, parent?: Session, codexHost?: string) {
  return {
    id: sessionIdentity(session),
    parentId: parent ? sessionIdentity(parent) : undefined,
    agent: session.agent,
    title: sessionTitle(session),
    cwd: session.cwd,
    branch: session.branch,
    activity: session.activity,
    lifecycle: session.lifecycle,
    startedAt: session.startedAt,
    lastActiveAt: session.lastActiveAt,
    where: wireKind(session.place),
    handoff: phoneHandoff(session, codexHost),
  };
}

/** Settings are re-read each refresh, so an edit applies without restarting the server. */
function settingsDiscovery(): () => Promise<Discovered> {
  const discover = discovery();
  return () => discover(loadSettings());
}

export function startServer({
  port,
  pairing,
  discover = settingsDiscovery(),
  interval = 2_000,
}: {
  port: number;
  pairing: Pairing;
  discover?: () => Promise<Discovered>;
  interval?: number;
}) {
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
      const { sessions, problem, stale } = await discover();
      const codexHost = sessions.some((row) => row.agent === "codex" && row.place.kind !== "cloud")
        ? await codexRemoteHost()
        : {};
      const parents = sessionParents(sessions);
      snapshot = {
        ...snapshot,
        sequence: snapshot.sequence + 1,
        // Phones time freshness from this, so it moves only on a full successful load.
        updatedAt: stale ? snapshot.updatedAt : Date.now(),
        sessions: sessions.map((session) => phoneSession(session, parents.get(session), codexHost.id)),
        problem,
      };
    } catch (error) {
      snapshot = {
        ...snapshot,
        sequence: snapshot.sequence + 1,
        // A settings file edited while serving names its own fault; other failures stay generic.
        problem: `${error instanceof SettingsError ? error.message : "Session discovery unavailable"}; showing the last successful list`,
        sessions: snapshot.sessions.map((session) =>
          session.where !== "cloud" ? { ...session, activity: undefined } : session,
        ),
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
