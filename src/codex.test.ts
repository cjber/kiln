import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveCodexThread,
  CodexNotReady,
  codexActivity,
  codexRemoteHost,
  codexThreads,
  messageCodexSession,
} from "./codex";
import { archiveClosed, closeSession } from "./launcher";
import { restartStopped } from "./saved-sessions";

let root: string;
let server: ReturnType<typeof Bun.serve>;
let originalHome: string | undefined;
let originalState: string | undefined;
let rejectArchive: boolean;
let writerBusy: number;
let messagingStatus: { type: string; activeFlags?: string[] } | undefined;
let newestTurn: { id: string; status: string };
let rejectSteer: boolean;
let holdSteer: boolean;
let holdInitialization: boolean;
let requests: { id?: number; method: string; params?: Record<string, unknown> }[];
let archived: Set<string>;
let archivePages: number;
let emptyThread: { name: string | null; preview: string; status: { type: string; activeFlags?: string[] } } | undefined;
let remoteState: { status: string; environmentId?: string | null };
const ownedSession = {
  agent: "codex" as const,
  id: "active",
  cwd: "/repo",
  startedAt: 1,
  place: { kind: "kiln" as const, name: "codex-owned" },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kiln-codex-"));
  originalHome = Bun.env.CODEX_HOME;
  originalState = Bun.env.XDG_STATE_HOME;
  Bun.env.CODEX_HOME = root;
  Bun.env.XDG_STATE_HOME = root;
  const control = join(root, "app-server-control");
  mkdirSync(control);
  archived = new Set(["already-archived"]);
  archivePages = 0;
  rejectArchive = false;
  writerBusy = 0;
  messagingStatus = undefined;
  newestTurn = { id: "turn-current", status: "inProgress" };
  rejectSteer = false;
  holdSteer = false;
  holdInitialization = false;
  requests = [];
  emptyThread = undefined;
  remoteState = { status: "connected", environmentId: "env_example" };
  server = Bun.serve({
    unix: join(control, "app-server-control.sock"),
    fetch(request, server) {
      if (server.upgrade(request, { data: {} })) return;
      return new Response("websocket required", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const request = JSON.parse(String(message));
        requests.push(request);
        if (request.id === undefined || (holdInitialization && request.method === "initialize")) return;
        let result: unknown = {};
        switch (request.method) {
          case "remoteControl/status/read":
            result = remoteState;
            break;
          case "thread/loaded/list":
            result = { data: ["active", "already-archived", ...(emptyThread ? ["empty"] : [])] };
            break;
          case "thread/list":
            expect(request.params.archived).toBe(true);
            if (archivePages) {
              const page = Number(request.params.cursor ?? 0);
              result = {
                data: page === archivePages - 1 ? [...archived].map((id) => ({ id })) : [],
                nextCursor: page === archivePages - 1 ? null : String(page + 1),
              };
            } else
              result = request.params.cursor
                ? { data: [...archived].map((id) => ({ id })), nextCursor: null }
                : { data: [], nextCursor: "second-page" };
            break;
          case "turn/steer":
            if (holdSteer) return;
            if (rejectSteer) {
              ws.send(JSON.stringify({ id: request.id, error: { message: "active turn changed" } }));
              return;
            }
            break;
          case "thread/turns/list":
            result = { data: [newestTurn] };
            break;
          case "thread/read":
            if (request.params.threadId === "missing-local") {
              ws.send(JSON.stringify({ id: request.id, error: { message: "thread not found" } }));
              return;
            }
            result = {
              thread: {
                id: request.params.threadId,
                name: request.params.threadId === "local" ? "Compare parallax flash loop" : null,
                preview: "First prompt",
                cwd: "/repo",
                createdAt: 1,
                parentThreadId: request.params.threadId === "active" ? "parent" : null,
                status: messagingStatus ?? { type: request.params.threadId === "local" ? "notLoaded" : "idle" },
                ...(request.params.threadId === "empty" ? emptyThread : {}),
              },
            };
            break;
          case "thread/archive":
            if (writerBusy > 0) {
              writerBusy--;
              ws.send(JSON.stringify({ id: request.id, error: { message: "thread x already has an active writer" } }));
              return;
            }
            if (rejectArchive) {
              ws.send(JSON.stringify({ id: request.id, error: { message: "archive refused" } }));
              return;
            }
            archived.add(request.params.threadId);
            break;
        }
        ws.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
});

afterEach(() => {
  server.stop(true);
  if (originalHome === undefined) delete Bun.env.CODEX_HOME;
  else Bun.env.CODEX_HOME = originalHome;
  if (originalState === undefined) delete Bun.env.XDG_STATE_HOME;
  else Bun.env.XDG_STATE_HOME = originalState;
  rmSync(root, { recursive: true, force: true });
});

describe("Codex archive", () => {
  test("closing a kiln Codex terminal also archives its daemon thread", async () => {
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((() => ({
      exitCode: 0,
    })) as unknown as typeof Bun.spawnSync);
    try {
      restartStopped([{ ...ownedSession, pid: process.pid }]);
      const db = new Database(join(root, "kiln", "sessions.sqlite"), { readonly: true });
      try {
        expect(db.query("SELECT id FROM sessions").all()).toHaveLength(1);
        expect(await closeSession(ownedSession)).toBe(true);
        expect(db.query("SELECT id FROM sessions").all()).toEqual([]);
      } finally {
        db.close();
      }
      expect((await codexThreads()).map((thread) => thread.id)).toEqual([]);
      expect(
        requests.filter((request) => request.method === "thread/archive").map((request) => request.params),
      ).toEqual([{ threadId: "active" }]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("a failed terminal kill never archives a still-running thread", async () => {
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((() => ({
      exitCode: 1,
    })) as unknown as typeof Bun.spawnSync);
    try {
      expect(await closeSession(ownedSession)).toContain("tmux could not close");
      expect(requests).toEqual([]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("an archive refusal reports the partial close and keeps the daemon row retryable", async () => {
    rejectArchive = true;
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((() => ({
      exitCode: 0,
    })) as unknown as typeof Bun.spawnSync);
    try {
      expect(await closeSession(ownedSession)).toContain(
        "the session stopped; only archiving failed: thread/archive: archive refused",
      );
      expect((await codexThreads()).map((row) => row.id)).toEqual(["active"]);
      rejectArchive = false;
      expect(await closeSession({ ...ownedSession, place: { kind: "thread", id: "active", attach: [] } })).toBe(true);
      expect(await codexThreads()).toEqual([]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("a close archives only once the session's process has exited and let go of its writer lock", async () => {
    let alive = 3;
    // The daemon refuses while the process runs, as Codex does while its writer holds the thread.
    writerBusy = Number.POSITIVE_INFINITY;
    const running = () => {
      if (alive-- > 0) return true;
      writerBusy = 0;
      return false;
    };
    await archiveClosed({ ...ownedSession, pid: 4242 }, "active", 5_000, running);
    expect(requests.filter((request) => request.method === "thread/archive")).toHaveLength(1);
    expect(await codexThreads()).toEqual([]);
  });

  test("older local Codex terminals still close without a daemon", async () => {
    Bun.env.CODEX_HOME = join(root, "offline");
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((() => ({
      exitCode: 0,
    })) as unknown as typeof Bun.spawnSync);
    try {
      expect(await closeSession(ownedSession)).toBe(true);
      expect(requests).toEqual([]);
    } finally {
      spawn.mockRestore();
    }
  });

  test("a stale daemon endpoint does not prevent closing a local terminal", async () => {
    server.stop(true);
    writeFileSync(join(root, "app-server-control", "app-server-control.sock"), "stale");
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((() => ({
      exitCode: 0,
    })) as unknown as typeof Bun.spawnSync);
    try {
      expect(await closeSession(ownedSession)).toBe(true);
      await expect(archiveCodexThread("active")).rejects.toThrow("cannot connect");
    } finally {
      spawn.mockRestore();
    }
  });

  test("initialization timeout never sends an archive request", async () => {
    holdInitialization = true;
    await expect(archiveCodexThread("active")).rejects.toThrow("the Codex daemon did not answer");
    expect(requests.some((request) => request.method === "thread/archive")).toBe(false);
    expect(archived.has("active")).toBe(false);
  });

  test("externally archived loaded threads stay hidden across paginated discovery", async () => {
    const threads = await codexThreads();
    expect(threads.map((thread) => thread.id)).toEqual(["active"]);
    expect(threads[0]?.parentThreadId).toBe("parent");
    expect(
      requests.filter((request) => request.method === "thread/read").map((request) => request.params?.threadId),
    ).toEqual(["active"]);
  });

  test("a long archive is scanned across refreshes instead of timing out", async () => {
    archivePages = 25;
    const listed = () => requests.filter((request) => request.method === "thread/list").length;
    expect((await codexThreads()).map((thread) => thread.id)).toEqual(["active", "already-archived"]);
    expect(listed()).toBe(10);
    await codexThreads();
    expect((await codexThreads()).map((thread) => thread.id)).toEqual(["active"]);
    expect(listed()).toBe(25);
  });

  test("archiving retains history and hides a thread on the next discovery", async () => {
    await archiveCodexThread("active");
    expect(await codexThreads()).toEqual([]);
    expect(requests.filter((request) => request.method === "thread/archive").map((request) => request.params)).toEqual([
      { threadId: "active" },
    ]);
    expect(requests.some((request) => request.method === "thread/delete")).toBe(false);
  });

  test("failed archive returns the daemon error and leaves the thread visible", async () => {
    rejectArchive = true;
    const result = await closeSession({
      agent: "codex",
      cwd: "/repo",
      startedAt: 1,
      place: { kind: "thread", id: "active", attach: [] },
    });
    expect(result).toContain("archive refused");
    const threads = await codexThreads();
    expect(threads.map((thread) => thread.id)).toEqual(["active"]);
    expect(threads[0]?.parentThreadId).toBe("parent");
  });
});

test("local terminal titles are read without treating unloaded threads as active or losing loaded rows", async () => {
  const rows = await codexThreads(["local", "local", "missing-local"]);
  expect(rows.map((row) => row.id)).toEqual(["active", "local"]);
  expect(rows.find((row) => row.id === "local")).toMatchObject({
    title: "Compare parallax flash loop",
    activity: undefined,
  });
  expect(rows.find((row) => row.id === "active")?.title).toBe("First prompt");
  expect(
    requests.filter((request) => request.method === "thread/read" && request.params?.threadId === "local"),
  ).toHaveLength(1);
});

test("phone host identities require connected relay metadata and request experimental access", async () => {
  expect(await codexRemoteHost()).toEqual({ id: "slingshot:env_example:8765" });
  expect(requests[0]?.params?.capabilities).toEqual({ experimentalApi: true });
  remoteState = { status: "disabled", environmentId: "env_old" };
  expect(await codexRemoteHost()).toEqual({});
  remoteState = { status: "connected", environmentId: "env_bad&token=private" };
  expect(await codexRemoteHost()).toEqual({ problem: "Codex Remote Control has no recognised host identity" });
  remoteState = { status: "future-state" };
  expect((await codexRemoteHost()).problem).toContain("unknown state");
});

test("unknown native activity stays unknown", () => {
  expect(codexActivity({ type: "active", activeFlags: ["waitingOnApproval"] })).toBe("waiting");
  expect(codexActivity({ type: "active", activeFlags: ["future-state" as "waitingOnApproval"] })).toBeUndefined();
});

test("empty idle daemon threads stay hidden unless a local terminal owns them", async () => {
  emptyThread = { name: null, preview: "", status: { type: "idle" } };
  expect((await codexThreads()).map((row) => row.id)).toEqual(["active"]);
  expect((await codexThreads(["empty"])).map((row) => row.id)).toEqual(["active", "empty"]);
  emptyThread = { name: "  ", preview: "\n", status: { type: "idle" } };
  expect((await codexThreads()).map((row) => row.id)).toEqual(["active"]);
  emptyThread = { name: null, preview: "", status: { type: "active", activeFlags: [] } };
  expect((await codexThreads()).map((row) => row.id)).toEqual(["active", "empty"]);
  emptyThread = { name: null, preview: "", status: { type: "systemError" } };
  expect((await codexThreads()).map((row) => row.id)).toEqual(["active", "empty"]);
});

describe("Codex messages", () => {
  test("an unavailable daemon remains retryable because no input was sent", async () => {
    server.stop(true);
    await expect(messageCodexSession("active", "message")).rejects.toBeInstanceOf(CodexNotReady);
    expect(requests).toEqual([]);
  });

  test("idle starts a turn; working steers the newest active turn without loading its history", async () => {
    await messageCodexSession("active", "idle message");
    expect(requests.find((r) => r.method === "turn/start")?.params).toEqual({
      threadId: "active",
      input: [{ type: "text", text: "idle message" }],
    });
    requests.length = 0;
    messagingStatus = { type: "active", activeFlags: [] };
    await messageCodexSession("active", "working message");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/turns/list",
      "turn/steer",
    ]);
    expect(requests.find((r) => r.method === "thread/read")?.params).toEqual({ threadId: "active" });
    expect(requests.find((r) => r.method === "thread/turns/list")?.params).toEqual({
      threadId: "active",
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    expect(requests.find((r) => r.method === "turn/steer")?.params).toEqual({
      threadId: "active",
      expectedTurnId: "turn-current",
      input: [{ type: "text", text: "working message" }],
    });
  });

  test("waiting and unknown statuses receive no input, including after an idle discovery snapshot", async () => {
    for (const status of [
      { type: "active", activeFlags: ["waitingOnApproval"] },
      { type: "systemError" },
      { type: "notLoaded" },
    ]) {
      messagingStatus = status;
      await expect(messageCodexSession("active", "message")).rejects.toBeInstanceOf(CodexNotReady);
    }
    expect(requests.some((r) => r.method.startsWith("turn/"))).toBe(false);
  });

  test("turn completion or replacement waits safely; an uncertain steer timeout is never retryable", async () => {
    messagingStatus = { type: "active", activeFlags: [] };
    newestTurn.status = "completed";
    await expect(messageCodexSession("active", "message")).rejects.toBeInstanceOf(CodexNotReady);
    expect(requests.some((r) => r.method === "turn/steer")).toBe(false);
    newestTurn.status = "inProgress";
    rejectSteer = true;
    await expect(messageCodexSession("active", "message")).rejects.toBeInstanceOf(CodexNotReady);
    rejectSteer = false;
    holdSteer = true;
    try {
      await messageCodexSession("active", "message");
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).not.toBeInstanceOf(CodexNotReady);
      expect((error as Error).message).toBe("the Codex daemon did not answer");
    }
  });
});
