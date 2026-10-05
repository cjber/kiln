import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveCodexThread, codexActivity, codexRemoteHost, codexThreads } from "./codex";
import { closeSession } from "./launcher";
import { restartStopped } from "./saved-sessions";

let root: string;
let server: ReturnType<typeof Bun.serve>;
let originalHome: string | undefined;
let originalState: string | undefined;
let rejectArchive: boolean;
let holdInitialization: boolean;
let requests: { id?: number; method: string; params?: Record<string, unknown> }[];
let archived: Set<string>;
let archivePages: number;
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
  holdInitialization = false;
  requests = [];
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
            result = { data: ["active", "already-archived"] };
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
                status: { type: request.params.threadId === "local" ? "notLoaded" : "idle" },
              },
            };
            break;
          case "thread/archive":
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
        "terminal closed, but archiving failed: thread/archive: archive refused",
      );
      expect((await codexThreads()).map((row) => row.id)).toEqual(["active"]);
      rejectArchive = false;
      expect(await closeSession({ ...ownedSession, place: { kind: "thread", id: "active", attach: [] } })).toBe(true);
      expect(await codexThreads()).toEqual([]);
    } finally {
      spawn.mockRestore();
    }
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
