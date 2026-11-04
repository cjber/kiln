import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { hostname } from "node:os";
import { codexRemoteHost } from "./codex";
import { conversationReader } from "./conversation";
import { startFromPhone } from "./launcher";
import { post } from "./mailbox";
import { flush, flushInBackground, phoneSender, reachable, route } from "./messages";
import { nativeNotifications } from "./notifications";
import { opencodeLinks, opencodeToken, servedOpencodeOrigin } from "./opencode-web";
import type { Pairing } from "./pairing";
import { phoneHandoff } from "./phone-links";
import { moves, parsePrompt } from "./prompt";
import { type PushAlert, pushTarget, sendPush } from "./push";
import { sessionTitle } from "./session-list";
import {
  type Agent,
  agents,
  type Discovered,
  discovery,
  type Place,
  type Session,
  sessionDirectory,
  sessionIdentity,
  sessionParents,
} from "./sessions";
import { loadSettings, type Settings, SettingsError } from "./settings";
import { spawn } from "./setup";
import { attachedClients, lastSeen, pick, screen, sendKey, submitText } from "./tmux";
import { saveUpload, UploadsFull, uploadLimit } from "./uploads";
import { rankedDirectories } from "./zoxide";

/** The largest first prompt or message a phone can send, in UTF-8 bytes. */
export const promptLimit = 16 * 1024;
/** Every other request body stays this small. */
const bodyLimit = 4096;

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A JSON object body of at most `limit` bytes, or a refusal saying what was wrong with it. */
async function jsonBody(request: Request, limit: number, invalid: string): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new Refusal(415, "Expected JSON");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > limit) throw new Refusal(413, "Request is too large");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Refusal(400, invalid);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refusal(400, invalid);
  return body as Record<string, unknown>;
}

/** Text a phone typed: present, and within `promptLimit`. */
function typedText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Refusal(400, `Write a ${name} first`);
  if (Buffer.byteLength(value) > promptLimit) throw new Refusal(413, `The ${name} is longer than 16 KB`);
  return value.trim();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a phone may start a session, most recent first: the directories of listed sessions, then zoxide's ranking.
 * A phone only ever picks from this list; it never sends a path of its own.
 */
export function offeredDirectories(
  sessions: readonly Session[],
  ranked: readonly string[],
  exists: (path: string) => boolean = isDirectory,
): string[] {
  const recent = sessions
    .filter((session) => session.place.kind !== "cloud")
    .toSorted((a, b) => (b.lastActiveAt ?? b.startedAt) - (a.lastActiveAt ?? a.startedAt))
    .map(sessionDirectory);
  return [...new Set([...recent, ...ranked])].filter(exists).slice(0, 500);
}

/** What the phone can do in a session's view, and why not when it cannot. */
export function sessionAbilities(session: Session): { read: boolean; reply?: string; stop: boolean } {
  const way = route(session);
  return {
    read: conversationReader(session) !== undefined,
    // A reply the agent cannot take now waits in kiln's mailbox; only a session kiln can never type into refuses it.
    reply: !reachable(session)
      ? "kiln can only write to a running session that reports its id"
      : "inbox" in way
        ? way.inbox
        : undefined,
    // Only a turn kiln knows is running is stopped: Escape on a prompt or an unknown state could clear someone's typing.
    // OpenCode's TUI wants Escape twice, so a single key could not stop it reliably.
    stop: session.agent !== "opencode" && session.place.kind === "kiln" && session.activity === "working",
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
  seenAt?: number,
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
    /** Kiln's tmux name, which a phone matches against the session it just started. */
    terminal: session.place.kind === "kiln" ? session.place.name : undefined,
    /** When the person last attached to or typed in its terminal here, so a phone clears what they have read. */
    seenAt,
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
  pushInterval = 10_000,
  opencode = opencodeLinks((origin) => opencodeToken(origin, spawn)),
  tls,
  push = sendPush,
  settings = loadSettings,
  start = startFromPhone,
  deliver = flush,
  seen = lastSeen,
  offer = (sessions, current) => offeredDirectories(sessions, current.zoxide ? rankedDirectories() : []),
}: {
  port: number;
  pairing: Pairing;
  discover?: () => Promise<Discovered>;
  opencode?: ReturnType<typeof opencodeLinks>;
  interval?: number;
  /** Refresh period with no phone connected; it keeps the saved-session records current. */
  idleInterval?: number;
  /** Refresh period with no phone connected but a phone registered for pushes. */
  pushInterval?: number;
  /** Only the QA harness serves TLS itself; a real server sits behind Tailscale Serve or the user's tunnel. */
  tls?: Bun.TLSOptions;
  push?: (target: Parameters<typeof sendPush>[0], alert: PushAlert) => ReturnType<typeof sendPush>;
  /** Read on each write request and refresh, so turning phone writes on or off needs no restart. */
  settings?: () => Settings;
  start?: typeof startFromPhone;
  deliver?: (sessions: readonly Session[]) => ReturnType<typeof flush>;
  /** When the person last looked at each kiln terminal, by tmux name. */
  seen?: () => Promise<Map<string, number>>;
  /** The directories a phone may start in, given the listed sessions. */
  offer?: (sessions: readonly Session[], settings: Settings) => string[];
}) {
  const writable = () => {
    try {
      return settings().phoneWrite;
    } catch {
      return false;
    }
  };
  const instance = randomUUID();
  let snapshot = {
    version: 1,
    instance,
    sequence: 0,
    host: hostname(),
    updatedAt: 0,
    problem: "Loading sessions",
    /** Whether this computer takes new sessions and prompts from its phones. */
    write: writable(),
    sessions: [] as ReturnType<typeof phoneSession>[],
  };
  let listed: Session[] = [];
  const offered = () => offer(listed, settings());
  /** Each write route first checks that writes are on; a phone with an old snapshot learns it here. */
  const writeSettings = () => {
    const current = settings();
    if (!current.phoneWrite)
      throw new Refusal(403, "This computer does not take sessions from the phone; set write = true under [phone]");
    return current;
  };
  const startSession = async (device: { id: string }, request: Request) => {
    const current = writeSettings();
    const body = await jsonBody(request, 4 * promptLimit, "Invalid session request");
    const agent = body.agent as Agent;
    if (!agents.includes(agent) || !current.agents[agent].length)
      throw new Refusal(400, "That agent is not enabled on this computer");
    if (typeof body.directory !== "string" || !offered().includes(body.directory))
      throw new Refusal(400, "Pick a directory from the list");
    const prompt = typedText(body.prompt, "prompt");
    try {
      pairing.recordStart(device.id, agent, body.directory);
    } catch (error) {
      throw new Refusal(429, error instanceof Error ? error.message : "Too many sessions started");
    }
    const outcome = await start(agent, body.directory, prompt, current);
    if (outcome.kind !== "attach") throw new Refusal(500, outcome.kind === "notice" ? outcome.text : "Not started");
    void refresh();
    return { terminal: outcome.name };
  };
  const sendMessage = async (device: { id: string; name: string }, id: string, request: Request) => {
    writeSettings();
    const body = await jsonBody(request, 4 * promptLimit, "Invalid message");
    const text = typedText(body.text, "message");
    // A phone that retries after a dropped response sends the same id, and the message is posted once.
    if (body.id !== undefined && (typeof body.id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(body.id)))
      throw new Refusal(400, "Invalid message id");
    if (!listed.some((session) => reachable(session) && sessionIdentity(session) === id))
      throw new Refusal(404, "That session is not running");
    let message: ReturnType<typeof post>;
    try {
      const key = body.id === undefined ? undefined : `phone-${device.id}-${body.id}`;
      message = post(phoneSender(device.name), id, text, undefined, undefined, key);
    } catch (error) {
      throw new Refusal(429, error instanceof Error ? error.message : "Too many messages");
    }
    const outcome = (await deliver(listed)).find((item) => item.message.id === message.id);
    // Another pass claimed it first, which is a delivery too, as `kiln msg send` reports it.
    return outcome && !outcome.delivered ? { delivered: false, reason: outcome.reason } : { delivered: true };
  };
  const listedSession = (id: string) => {
    writeSettings();
    const session = listed.find((row) => sessionIdentity(row) === id);
    if (!session) throw new Refusal(404, "That session is not listed");
    return session;
  };
  /** The menu a session in kiln's tmux is waiting on, read off its screen. */
  const waitingOn = (session: Session) => {
    if (session.place.kind !== "kiln") return undefined;
    const shown = screen(session.place.name);
    return shown && parsePrompt(shown.text, shown.width);
  };
  const viewSession = (id: string, cursor: string | null) => {
    const session = listedSession(id);
    const abilities = sessionAbilities(session);
    const prompt = waitingOn(session) ?? null;
    const read = conversationReader(session);
    try {
      if (read) return { abilities, prompt, ...read(cursor ?? undefined) };
    } catch {
      // A transcript not written yet, or unreadable, shows as an empty conversation.
    }
    return { abilities, prompt, items: [], cursor: "", reset: true };
  };
  const answerPrompt = async (id: string, request: Request) => {
    const session = listedSession(id);
    const body = await jsonBody(request, promptLimit + bodyLimit, "Invalid answer");
    const prompt = waitingOn(session);
    // The menu is read again here, so an answer only lands on the question the phone showed.
    if (!prompt || session.place.kind !== "kiln" || body.key !== prompt.key)
      throw new Refusal(409, "That question is no longer waiting");
    const option = prompt.options.find((item) => item.number === body.option);
    if (!option) throw new Refusal(400, "Pick one of the options");
    const text = option.typed ? typedText(body.text, "answer") : undefined;
    try {
      if (option.typed === "after") {
        await pick(session.place.name, moves(prompt, option.number));
        await Bun.sleep(800);
        await submitText(session.place.name, text ?? "");
      } else await pick(session.place.name, moves(prompt, option.number), text);
    } catch {
      throw new Refusal(409, "Its terminal has closed");
    }
    return { answered: true };
  };
  const uploadFile = async (id: string, request: Request) => {
    listedSession(id);
    const name = new URL(request.url).searchParams.get("name");
    if (!name) throw new Refusal(400, "Name the file");
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) throw new Refusal(400, "The file is empty");
    if (bytes.byteLength > uploadLimit) throw new Refusal(413, "Files up to 20 MB can be attached");
    try {
      return { path: await saveUpload(name, bytes) };
    } catch (error) {
      if (error instanceof UploadsFull) throw new Refusal(507, error.message);
      throw error;
    }
  };
  const stopTurn = (id: string) => {
    const session = listedSession(id);
    if (!sessionAbilities(session).stop || session.place.kind !== "kiln")
      throw new Refusal(409, "This session cannot be stopped from the phone");
    // Escape is how Claude's own terminal ends a turn; it does nothing while Claude is idle.
    if (attachedClients(session.place.name) === undefined || !sendKey(session.place.name, "Escape"))
      throw new Refusal(409, "Its terminal has closed");
    return { stopped: true };
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
    maxRequestBodySize: uploadLimit,
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
        let body: Record<string, unknown>;
        try {
          body = await jsonBody(request, bodyLimit, "Invalid pairing request");
        } catch (error) {
          if (error instanceof Refusal) return response({ error: error.message }, error.status);
          throw error;
        }
        if (typeof body.code !== "string" || typeof body.name !== "string")
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
        let target: ReturnType<typeof pushTarget>;
        try {
          target = pushTarget(await jsonBody(request, bodyLimit, "Invalid push registration"));
        } catch (error) {
          if (error instanceof Refusal) return response({ error: error.message }, error.status);
          throw error;
        }
        if (!target) return response({ error: "Invalid push registration" }, 400);
        pairing.setPush(device.id, target);
        return response({ ok: true });
      }
      if (request.method === "GET" && path === "/v1/events") {
        if (server.upgrade(request, { data: { token } })) return;
        return response({ error: "Expected WebSocket" }, 400);
      }
      try {
        if (request.method === "GET" && path === "/v1/directories") {
          const current = writeSettings();
          return response({
            directories: offered(),
            agents: agents.filter((agent) => current.agents[agent].length),
          });
        }
        if (request.method === "POST" && path === "/v1/sessions") return response(await startSession(device, request));
        const messages = path.match(/^\/v1\/sessions\/([^/]+)\/messages$/)?.[1];
        if (request.method === "POST" && messages)
          return response(await sendMessage(device, decodeURIComponent(messages), request));
        const action = path.match(/^\/v1\/sessions\/([^/]+)\/(view|interrupt|prompt|files)$/);
        if (action?.[1] && action[2] === "view" && request.method === "GET")
          return response(viewSession(decodeURIComponent(action[1]), new URL(request.url).searchParams.get("cursor")));
        if (action?.[1] && action[2] === "interrupt" && request.method === "POST")
          return response(stopTurn(decodeURIComponent(action[1])));
        if (action?.[1] && action[2] === "prompt" && request.method === "POST")
          return response(await answerPrompt(decodeURIComponent(action[1]), request));
        if (action?.[1] && action[2] === "files" && request.method === "POST")
          return response(await uploadFile(decodeURIComponent(action[1]), request));
      } catch (error) {
        if (error instanceof Refusal) return response({ error: error.message }, error.status);
        if (error instanceof URIError) return response({ error: "Invalid session name" }, 400);
        if (error instanceof SettingsError) return response({ error: error.message }, 500);
        throw error;
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
  const pushAll = (alert: Omit<PushAlert, "machine">) => {
    for (const target of pairing.pushTargets())
      void push(target, { ...alert, machine: target.machine })
        .then((result) => {
          if (result === "gone") pairing.deletePush(target.device, target.endpoint);
        })
        .catch(() => {});
  };
  /** Alerts pushed and not yet read here, by session; reading one clears it on the phones. */
  const unread = new Map<string, Omit<PushAlert, "machine">>();
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
    unread.set(alert.session, alert);
    pushAll(alert);
  });
  /** A session that is working again, was looked at after its alert, or has closed, has been read. */
  const clearRead = () => {
    for (const [id, alert] of unread) {
      const row = snapshot.sessions.find((session) => session.id === id);
      if (row && row.activity !== "working" && (row.seenAt ?? 0) <= alert.at) continue;
      unread.delete(id);
      pushAll({ ...alert, transition: "read" });
    }
  };
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
      listed = sessions;
      if (!stale) flushInBackground(sessions);
      const codexHost = sessions.some((row) => row.agent === "codex" && row.place.kind !== "cloud")
        ? await codexRemoteHost()
        : {};
      const opencodeLink =
        sessions.some((row) => row.opencodeService) && (await servedOpencodeOrigin())
          ? (id: string) => opencode.path(id)
          : undefined;
      const parents = sessionParents(sessions);
      const looked = sessions.some((row) => row.place.kind === "kiln") ? await seen() : new Map<string, number>();
      snapshot = {
        ...snapshot,
        sequence: snapshot.sequence + 1,
        // Phones time freshness from this, so it moves only on a full successful load.
        updatedAt: stale ? snapshot.updatedAt : Date.now(),
        sessions: sessions.map((session) =>
          phoneSession(
            session,
            parents.get(session),
            codexHost.id,
            opencodeLink,
            session.place.kind === "kiln" ? looked.get(session.place.name) : undefined,
          ),
        ),
        problem,
        write: writable(),
      };
      try {
        transitions(sessions, pushing());
        if (!stale) clearRead();
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
  // or while a session works and a phone waits for its push. With pushes on and nothing working it
  // still looks every `pushInterval`, so a turn that starts and ends between idle checks is caught.
  const timer = setInterval(() => {
    publish();
    const working = snapshot.sessions.some((row) => row.where !== "cloud" && row.activity === "working");
    const since = Date.now() - refreshedAt;
    if (sockets.size || (pushing() && (working || since >= pushInterval)) || since >= idleInterval) void refresh();
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
