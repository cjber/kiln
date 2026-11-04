import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { codexRemoteHost } from "./codex";
import { flushInBackground } from "./messages";
import { nativeNotifications } from "./notifications";
import { opencodeLinks, opencodeToken, servedOpencodeOrigin } from "./opencode-web";
import type { Pairing } from "./pairing";
import { phoneHandoff } from "./phone-links";
import { type PushAlert, pushTarget, sendPush } from "./push";
import { sessionTitle } from "./session-list";
import {
  type Discovered,
  discovery,
  type Place,
  type Session,
  sessionDirectory,
  sessionIdentity,
  sessionParents,
} from "./sessions";
import { loadSettings, SettingsError } from "./settings";
import { spawn } from "./setup";

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

export function phoneSession(
  session: Session,
  parent?: Session,
  codexHost?: string,
  opencodeLink?: (id: string) => string,
) {
  return {
    id: sessionIdentity(session),
    parentId: parent ? sessionIdentity(parent) : undefined,
    agent: session.agent,
    title: sessionTitle(session),
    cwd: sessionDirectory(session),
    branch: session.branch,
    activity: session.activity,
    lifecycle: session.lifecycle,
    startedAt: session.startedAt,
    lastActiveAt: session.lastActiveAt,
    where: wireKind(session.place),
    handoff: phoneHandoff(session, codexHost, opencodeLink),
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
  idleInterval = 60_000,
  opencode = opencodeLinks((origin) => opencodeToken(origin, spawn)),
  tls,
  push = sendPush,
}: {
  port: number;
  pairing: Pairing;
  discover?: () => Promise<Discovered>;
  opencode?: ReturnType<typeof opencodeLinks>;
  interval?: number;
  /** Refresh period with no phone connected; it keeps the saved-session records current. */
  idleInterval?: number;
  /** Only the QA harness serves TLS itself; a real server sits behind Tailscale Serve or the user's tunnel. */
  tls?: Bun.TLSOptions;
  push?: (target: Parameters<typeof sendPush>[0], alert: PushAlert) => ReturnType<typeof sendPush>;
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
  let refreshedAt = 0;
  const refreshIfOld = () => {
    if (Date.now() - refreshedAt >= interval) void refresh();
  };
  let attempts = 0;
  let windowStart = Date.now();
  const sockets = new Set<Bun.ServerWebSocket<{ token: string }>>();
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const server = Bun.serve<{ token: string }>({
    hostname: "127.0.0.1",
    port,
    tls,
    maxRequestBodySize: 4096,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      // The phone opens this in its browser; the one-use code in the path is the authorization.
      const opencodeCode = path.match(/^\/opencode\/([A-Za-z0-9_-]{32})$/)?.[1];
      if (opencodeCode && request.method === "GET") return opencode.open(opencodeCode, await servedOpencodeOrigin());
      if (request.headers.has("Origin")) return response({ error: "Browser requests are not supported" }, 403);
      // Opened in a browser, the address explains itself instead of reading as a lost pairing.
      if (path === "/" && request.method === "GET")
        return new Response(
          "This is the kiln phone server. It has no web page: open the kiln app on your phone to see your sessions. To pair a phone, run kiln pair on this computer.\n",
          { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } },
        );
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
      if (request.method === "GET" && path === "/v1/sessions") {
        refreshIfOld();
        return response(snapshot);
      }
      if (path === "/v1/push" && request.method === "DELETE") {
        pairing.deletePush(device.id);
        return response({ ok: true });
      }
      if (path === "/v1/push" && request.method === "POST") {
        if (!request.headers.get("Content-Type")?.startsWith("application/json"))
          return response({ error: "Expected JSON" }, 415);
        let target: ReturnType<typeof pushTarget>;
        try {
          target = pushTarget(await request.json());
        } catch {
          target = undefined;
        }
        if (!target) return response({ error: "Invalid push registration" }, 400);
        pairing.setPush(device.id, target);
        return response({ ok: true });
      }
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
        refreshIfOld();
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
  // The desktop's transition check; each change becomes an encrypted push to every registered phone.
  const transitions = nativeNotifications((session) => {
    const alert: Omit<PushAlert, "machine"> = {
      v: 1,
      host: snapshot.host,
      session: sessionIdentity(session),
      title: sessionTitle(session),
      agent: session.agent,
      cwd: sessionDirectory(session),
      transition: session.activity === "waiting" ? "input" : "finished",
      at: snapshot.updatedAt,
    };
    for (const target of pairing.pushTargets())
      void push(target, { ...alert, machine: target.machine })
        .then((result) => {
          if (result === "gone") pairing.deletePush(target.device, target.endpoint);
        })
        .catch(() => {});
  });
  const pushing = () => {
    try {
      return pairing.pushTargets().length > 0;
    } catch {
      return false;
    }
  };
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    refreshedAt = Date.now();
    try {
      const { sessions, problem, stale } = await discover();
      if (!stale) flushInBackground(sessions);
      const codexHost = sessions.some((row) => row.agent === "codex" && row.place.kind !== "cloud")
        ? await codexRemoteHost()
        : {};
      const opencodeLink =
        sessions.some((row) => row.opencodeService) && (await servedOpencodeOrigin())
          ? (id: string) => opencode.path(id)
          : undefined;
      const parents = sessionParents(sessions);
      snapshot = {
        ...snapshot,
        sequence: snapshot.sequence + 1,
        // Phones time freshness from this, so it moves only on a full successful load.
        updatedAt: stale ? snapshot.updatedAt : Date.now(),
        sessions: sessions.map((session) => phoneSession(session, parents.get(session), codexHost.id, opencodeLink)),
        problem,
      };
      try {
        transitions(sessions, pushing());
      } catch {
        // Push is best effort and never fails a refresh.
      }
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
  // Discovery starts several provider CLIs, so it runs every interval only while a phone watches,
  // or while a session works and a phone waits for its push.
  const timer = setInterval(() => {
    publish();
    const working = snapshot.sessions.some((row) => row.where !== "cloud" && row.activity === "working");
    if (sockets.size || (working && pushing()) || Date.now() - refreshedAt >= idleInterval) void refresh();
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
