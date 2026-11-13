import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeForm,
  formAnswer,
  headlessIdleMs,
  isOpencodeService,
  matchHeadlessProcesses,
  newOpencodeSessionId,
  opencodeActivity,
  opencodeInvocation,
  opencodeService,
  opencodeSessions,
  opencodeShown,
} from "./opencode";

function serviceFile(dir: string, record: unknown): string {
  mkdirSync(join(dir, "opencode"), { recursive: true });
  const path = join(dir, "opencode", "service.json");
  writeFileSync(path, JSON.stringify(record));
  return path;
}

test("the service's password is only sent to a loopback address", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-opencode-"));
  try {
    const local = opencodeService(serviceFile(dir, { url: "http://127.0.0.1:4096", password: "pw" }));
    expect(local).toEqual({ url: "http://127.0.0.1:4096", authorization: `Basic ${btoa("opencode:pw")}` });
    for (const url of ["http://example.com:4096", "https://127.0.0.1:4096", "http://10.0.0.2:4096"])
      expect(() => opencodeService(serviceFile(dir, { url, password: "pw" }))).toThrow();
    expect(() => opencodeService(serviceFile(dir, { url: "http://127.0.0.1:4096" }))).toThrow();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("sessions are read from the service over HTTP, with a pending permission as waiting", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("Authorization") !== `Basic ${btoa("opencode:pw")}`)
        return new Response("unauthorized", { status: 401 });
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const routes: Record<string, unknown> = {
        "/api/session/active": { data: { ses_a: { type: "running" } } },
        "/api/session": {
          data: [
            { id: "ses_a", title: "A", time: { created: 1, updated: 2 }, location: { directory: "/repo" } },
            { id: "ses_b", time: { created: 1, updated: 2, archived: 3 }, location: { directory: "/repo" } },
          ],
        },
        "/api/session/ses_a/permission": { data: [{ id: "per_1", action: "edit" }] },
        "/api/session/ses_a/form": { data: [] },
      };
      return url.pathname in routes ? Response.json(routes[url.pathname]) : new Response("missing", { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "kiln-opencode-"));
  const state = Bun.env.XDG_STATE_HOME;
  serviceFile(dir, { url: `http://127.0.0.1:${server.port}`, password: "pw" });
  Bun.env.XDG_STATE_HOME = dir;
  try {
    const listing = await opencodeSessions();
    expect(listing.live).toBe(true);
    expect(
      listing.sessions.map(({ id, activity, running, question }) => ({ id, activity, running, question })),
    ).toEqual([{ id: "ses_a", activity: "waiting", running: true, question: undefined }]);
    expect(requests).toContain("GET /api/session?limit=100");
  } finally {
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
    server.stop(true);
    rmSync(dir, { recursive: true });
  }
});

test("a running session the capped list leaves out is read from the service by id", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("Authorization") !== `Basic ${btoa("opencode:pw")}`)
        return new Response("unauthorized", { status: 401 });
      requests.push(`${request.method} ${url.pathname}`);
      const listed = { id: "ses_listed", time: { created: 1, updated: 2 }, location: { directory: "/repo" } };
      const offPage = { id: "ses_busy", time: { created: 3, updated: 4 }, location: { directory: "/repo" } };
      const routes: Record<string, unknown> = {
        // The page is capped: the busy session is active but not on it.
        "/api/session/active": { data: { ses_listed: { type: "running" }, ses_busy: { type: "running" } } },
        "/api/session": { data: [listed], cursor: { previous: null, next: "next-page" } },
        "/api/session/ses_busy": { data: offPage },
        "/api/session/ses_listed/permission": { data: [] },
        "/api/session/ses_listed/form": { data: [] },
        "/api/session/ses_busy/permission": { data: [] },
        "/api/session/ses_busy/form": { data: [] },
      };
      return url.pathname in routes ? Response.json(routes[url.pathname]) : new Response("missing", { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "kiln-opencode-"));
  const state = Bun.env.XDG_STATE_HOME;
  serviceFile(dir, { url: `http://127.0.0.1:${server.port}`, password: "pw" });
  Bun.env.XDG_STATE_HOME = dir;
  try {
    const listing = await opencodeSessions();
    expect(listing.live).toBe(true);
    expect(listing.sessions.map(({ id, activity, running }) => ({ id, activity, running }))).toEqual([
      { id: "ses_listed", activity: "working", running: true },
      { id: "ses_busy", activity: "working", running: true },
    ]);
    expect(requests).toContain("GET /api/session/ses_busy");
    // A session the page already names is not asked for again.
    expect(requests).not.toContain("GET /api/session/ses_listed");
  } finally {
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
    server.stop(true);
    rmSync(dir, { recursive: true });
  }
});

test("a missing active session the service cannot read leaves its status unknown, not idle", async () => {
  let fail = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("Authorization") !== `Basic ${btoa("opencode:pw")}`)
        return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/api/session/active") return Response.json({ data: { ses_busy: { type: "running" } } });
      if (url.pathname === "/api/session") return Response.json({ data: [], cursor: { previous: null, next: null } });
      if (url.pathname === "/api/session/ses_busy")
        return fail
          ? new Response("service unavailable", { status: 500 })
          : Response.json({
              data: { id: "ses_busy", time: { created: 1, updated: 2 }, location: { directory: "/r" } },
            });
      if (url.pathname.endsWith("/permission") || url.pathname.endsWith("/form")) return Response.json({ data: [] });
      return new Response("missing", { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "kiln-opencode-"));
  const state = Bun.env.XDG_STATE_HOME;
  serviceFile(dir, { url: `http://127.0.0.1:${server.port}`, password: "pw" });
  Bun.env.XDG_STATE_HOME = dir;
  try {
    const listed = await opencodeSessions();
    expect(listed.sessions.map(({ id, activity }) => ({ id, activity }))).toEqual([
      { id: "ses_busy", activity: "working" },
    ]);
    fail = true;
    const failed = await opencodeSessions();
    expect(failed.live).toBe(false);
    expect(failed.sessions.map(({ id, activity, running }) => ({ id, activity, running }))).toEqual([
      { id: "ses_busy", activity: undefined, running: true },
    ]);
  } finally {
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
    server.stop(true);
    rmSync(dir, { recursive: true });
  }
});

test("a conversation an archive hides is still read while a live process holds its id", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("Authorization") !== `Basic ${btoa("opencode:pw")}`)
        return new Response("unauthorized", { status: 401 });
      const archived = { id: "ses_a", time: { created: 1, updated: 2, archived: 3 }, location: { directory: "/repo" } };
      if (url.pathname === "/api/session/active") return Response.json({ data: {} });
      if (url.pathname === "/api/session")
        return Response.json({ data: [archived], cursor: { previous: null, next: null } });
      return new Response("missing", { status: 404 });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "kiln-opencode-"));
  const state = Bun.env.XDG_STATE_HOME;
  serviceFile(dir, { url: `http://127.0.0.1:${server.port}`, password: "pw" });
  Bun.env.XDG_STATE_HOME = dir;
  try {
    const held = await opencodeSessions(["ses_a"]);
    expect(held.live).toBe(true);
    expect(held.sessions.map(({ id, activity, running }) => ({ id, activity, running }))).toEqual([
      { id: "ses_a", activity: "idle", running: false },
    ]);
    // A run archiving the conversation when it exits still hides it once no process holds it.
    expect((await opencodeSessions()).sessions).toEqual([]);
  } finally {
    if (state === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = state;
    server.stop(true);
    rmSync(dir, { recursive: true });
  }
});

test("a terminal session is told from a subcommand on argv, and only a valid id is read back", () => {
  const id = "ses_e67fb939cffebq6gr36R6Z5T16";
  expect(opencodeInvocation(["opencode"])).toEqual({ id: undefined, shared: true });
  expect(opencodeInvocation(["opencode", "/repo", "--session", id])).toEqual({ id, shared: true });
  expect(opencodeInvocation(["/usr/bin/opencode", `--session=${id}`])).toEqual({ id, shared: true });
  expect(opencodeInvocation(["opencode", "-s", id, "--standalone"])).toEqual({ id, shared: false });
  expect(opencodeInvocation(["opencode", "--server", "http://host:1"])?.shared).toBe(false);
  expect(opencodeInvocation(["opencode", "-s", "--flag"])?.id).toBeUndefined();
  expect(opencodeInvocation(["opencode", "mini"])).toBeDefined();
  // The value of a flag is not a subcommand, even when it reads like one.
  expect(opencodeInvocation(["opencode", "--prompt", "run"])).toBeDefined();
  // `run` is headless but still a conversation; its process is matched to the service row.
  expect(opencodeInvocation(["opencode", "run", "--session", id])).toEqual({ id, shared: true, headless: true });
  for (const command of ["serve", "api", "session", "acp"])
    expect(opencodeInvocation(["opencode", command])).toBeUndefined();
});

test("only the background service counts as the service", () => {
  expect(isOpencodeService(["/usr/bin/opencode", "serve", "--service"])).toBe(true);
  expect(isOpencodeService(["opencode", "serve"])).toBe(false);
  expect(isOpencodeService(["opencode"])).toBe(false);
});

test("a generated id is one discovery can read back", () => {
  const id = newOpencodeSessionId();
  expect(opencodeInvocation(["opencode", "--session", id])?.id).toBe(id);
  expect(newOpencodeSessionId()).not.toBe(id);
});

test("a prompt outranks a running turn, and states kiln does not know stay unknown", () => {
  expect(opencodeActivity({ type: "running" }, true)).toBe("waiting");
  expect(opencodeActivity({ type: "running" }, false)).toBe("working");
  expect(opencodeActivity({ type: "paused" }, false)).toBeUndefined();
  expect(opencodeActivity(undefined, false)).toBe("idle");
  expect(opencodeActivity(undefined, false, "succeeded")).toBe("idle");
  expect(opencodeActivity(undefined, false, "interrupted")).toBe("idle");
  expect(opencodeActivity(undefined, false, "failed")).toBe("waiting");
  expect(opencodeActivity(undefined, false, "cancelled")).toBeUndefined();
});

test("a closed conversation is history, unless it is still running and spending", () => {
  expect(opencodeShown(undefined, false)).toBe(true);
  expect(opencodeShown(undefined, true)).toBe(true);
  expect(opencodeShown(1_793_696_431_870, true)).toBe(true);
  expect(opencodeShown(1_793_696_431_870, false)).toBe(false);
});

test("a finished headless run stays for six hours idle, then is hidden", () => {
  const now = 1_793_696_431_870;
  expect(opencodeShown(undefined, false, now - headlessIdleMs + 1, now)).toBe(true);
  expect(opencodeShown(undefined, false, now - headlessIdleMs, now)).toBe(false);
  expect(opencodeShown(undefined, false, now - headlessIdleMs - 1, now)).toBe(false);
  // A running one still shows, since it is spending where you can stop it.
  expect(opencodeShown(undefined, true, now - headlessIdleMs - 1, now)).toBe(true);
});

test("a headless run is matched to its process by its exact session id only", () => {
  const sessions = [
    { id: "ses_a", cwd: "/repo", createdAt: 1_000 },
    { id: "ses_b", cwd: "/repo", createdAt: 2_000 },
    { id: "ses_c", cwd: "/other", createdAt: 3_000 },
    { id: "ses_far", cwd: "/far", createdAt: 9_000_000 },
  ];
  const processes = [
    { pid: 10, id: "ses_b", cwd: "/elsewhere", startedAt: 8_000 },
    { pid: 11, cwd: "/repo", startedAt: 1_100 },
    { pid: 12, id: "ses_other", cwd: "/other", startedAt: 3_100 },
    { pid: 13, cwd: "/far", startedAt: 9_000_000 },
  ];
  // A process that names no id, or another one, is never paired by directory or start time.
  expect(Object.fromEntries(matchHeadlessProcesses(processes, sessions))).toEqual({ ses_b: 10 });
});

const question = {
  id: "frm_1",
  title: "Questions",
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Next step",
      description: "What should I continue with?",
      options: [{ value: "sync", label: "Sync to main", description: "Fast-forward first" }],
    },
  ],
};

test("a waiting session's form reads as one question", () => {
  expect(describeForm(question)).toEqual({
    id: "frm_1",
    text: "Next step: What should I continue with?\n- Sync to main: Fast-forward first",
  });
});

test("one reply fills a form with a single text field, or names one of a closed field's options", () => {
  expect(formAnswer(question, "do the sync")).toEqual({ q0: "do the sync" });
  const closed = { ...question, fields: [{ ...question.fields[0], key: "q0", type: "string", custom: false }] };
  expect(formAnswer(closed, "[kiln message from claude:p1]\n\nPlease sync to MAIN first")).toEqual({ q0: "sync" });
  expect(formAnswer(closed, "something else")).toBeUndefined();
  const short = { ...closed, fields: [{ ...closed.fields[0], options: [{ value: "a", label: "No" }] }] };
  expect(formAnswer(short, "Not now, maybe later")).toBeUndefined();
  expect(formAnswer(short, "no.")).toEqual({ q0: "a" });
  const two = { ...question, fields: [...question.fields, { key: "q1", type: "boolean" }] };
  expect(formAnswer(two, "yes")).toBeUndefined();
});
