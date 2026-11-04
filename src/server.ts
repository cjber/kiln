import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { codexRemoteHost } from "./codex";
import { readConversation } from "./conversation";
import { post } from "./mailbox";
import { flush, flushInBackground, phone, reachable, route } from "./messages";
import { claudeTranscript } from "./native-sessions";
import { opencodeLinks, opencodeToken, servedOpencodeOrigin } from "./opencode-web";
import type { Pairing } from "./pairing";
import { phoneHandoff } from "./phone-links";
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
import { attachedClients, sendKey } from "./tmux";

/** What the phone can do in a session's view, and why not when it cannot. */
export function sessionAbilities(session: Session): { read: boolean; reply?: string; stop: boolean } {
  const read = session.agent === "claude" && claudeTranscript(session.cwd, session.id) !== undefined;
  const way = route(session);
  return {
    read,
    // A reply the agent cannot take now waits in kiln's mailbox; only a session kiln can never type into refuses it.
    reply: !reachable(session)
      ? "kiln can only write to a running session that reports its id"
      : "inbox" in way
        ? way.inbox
        : undefined,
    // Only a turn kiln knows is running is stopped: Escape on a prompt or an unknown state could clear someone's typing.
    stop: session.agent === "claude" && session.place.kind === "kiln" && session.activity === "working",
  };
}

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
  /** The sessions of the last successful discovery, which the per-session routes act on. */
  let live: Session[] = [];
  const spent = new Map<string, { count: number; since: number }>();
  /** Each device may send, stop or answer this often, so a stuck retry loop cannot flood an agent. */
  const spend = (device: string) => {
    const now = Date.now();
    const used = spent.get(device);
    if (!used || now - used.since >= 60_000) {
      spent.set(device, { count: 1, since: now });
      return true;
    }
    return ++used.count <= 30;
  };
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const server = Bun.serve<{ token: string }>({
    hostname: "127.0.0.1",
    port,
    tls,
    // A reply typed on the phone is the largest body; everything else is a few hundred bytes.
    maxRequestBodySize: 64 * 1024,
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
      if (request.method === "GET" && path === "/v1/events") {
        if (server.upgrade(request, { data: { token } })) return;
        return response({ error: "Expected WebSocket" }, 400);
      }
      const view = path.match(/^\/v1\/sessions\/([^/]{1,200})\/(view|input|interrupt)$/);
      if (view?.[1] && view[2]) {
        const id = decodeURIComponent(view[1]);
        const session = live.find((row) => sessionIdentity(row) === id);
        if (!session) return response({ error: "No such session" }, 404);
        const abilities = sessionAbilities(session);
        if (view[2] === "view" && request.method === "GET") {
          const transcript = abilities.read && claudeTranscript(session.cwd, session.id);
          const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
          try {
            if (transcript) return response({ abilities, ...readConversation(transcript, cursor) });
          } catch {
            // A transcript not written yet, or unreadable, shows as an empty conversation.
          }
          return response({ abilities, items: [], cursor: "", reset: true });
        }
        if (request.method !== "POST") return response({ error: "Route not found" }, 404);
        if (!spend(device.id)) return response({ error: "Too many requests; wait a minute" }, 429);
        if (view[2] === "interrupt") {
          if (!abilities.stop || session.place.kind !== "kiln")
            return response({ error: "This session cannot be stopped from the phone" }, 409);
          // Escape is how Claude's own terminal ends a turn; it does nothing while Claude is idle.
          if (attachedClients(session.place.name) === undefined || !sendKey(session.place.name, "Escape"))
            return response({ error: "Its terminal has closed" }, 409);
          return response({ stopped: true });
        }
        if (abilities.reply) return response({ error: abilities.reply }, 409);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return response({ error: "Invalid message" }, 400);
        }
        const text = (body as { text?: unknown })?.text;
        const key = (body as { id?: unknown })?.id;
        if (typeof text !== "string" || !text.trim() || text.length > 32_000)
          return response({ error: "Invalid message" }, 400);
        if (typeof key !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(key))
          return response({ error: "Invalid message id" }, 400);
        try {
          post(phone, id, text, undefined, undefined, key);
        } catch (error) {
          return response({ error: error instanceof Error ? error.message : "Could not queue the message" }, 429);
        }
        // The agent may be idle now; a busy one gets it from the refresh loop as soon as it stops.
        const outcome = (await flush(live)).find((item) => item.message.id === key);
        // No outcome means another kiln claimed it first and is sending it.
        return response(outcome?.delivered === false ? { queued: true, reason: outcome.reason } : { delivered: true });
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
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    refreshedAt = Date.now();
    try {
      const { sessions, problem, stale } = await discover();
      if (!stale) {
        live = sessions;
        flushInBackground(sessions);
      }
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
  // Discovery starts several provider CLIs, so it runs every interval only while a phone watches.
  const timer = setInterval(() => {
    publish();
    if (sockets.size || Date.now() - refreshedAt >= idleInterval) void refresh();
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
