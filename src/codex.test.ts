import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSessionAction } from "./actions";
import { archiveCodexThread, codexActivity, codexRemoteHost, codexThreads } from "./codex";

let root: string;
let server: ReturnType<typeof Bun.serve>;
let originalHome: string | undefined;
let rejectArchive: boolean;
let holdInitialization: boolean;
let requests: { id?: number; method: string; params?: Record<string, unknown> }[];
let archived: Set<string>;
let remoteState: { status: string; environmentId?: string | null };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kiln-codex-"));
  originalHome = Bun.env.CODEX_HOME;
  Bun.env.CODEX_HOME = root;
  const control = join(root, "app-server-control");
  mkdirSync(control);
  archived = new Set(["already-archived"]);
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
  rmSync(root, { recursive: true, force: true });
});

describe("Codex archive", () => {
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
    const result = await runSessionAction({
      agent: "codex",
      cwd: "/repo",
      startedAt: 1,
      place: { kind: "background", id: "active", attach: [] },
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
