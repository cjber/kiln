import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pairing, serverOrigin, startLimit } from "./pairing";
import { offeredDirectories, phoneSession, promptLimit, startServer } from "./server";
import { keepLast, type Session, sessionParents } from "./sessions";
import { defaults, type Settings } from "./settings";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kiln-server-test-"));
  directories.push(directory);
  return { directory, pairing: new Pairing(join(directory, "devices.sqlite")) };
}

test("invitations expire, exchange once, store only hashes and revoke across processes", () => {
  const { directory, pairing } = fixture();
  try {
    const expired = pairing.invite(1000);
    expect(pairing.exchange(expired, "phone", 301000)).toBeUndefined();
    const code = pairing.invite();
    const paired = pairing.exchange(code, "Pixel");
    expect(paired).toBeDefined();
    if (!paired) throw new Error("pairing failed");
    expect(pairing.exchange(code, "another")).toBeUndefined();
    expect(pairing.authenticate(paired.token)?.name).toBe("Pixel");
    const source = readFileSync(join(directory, "devices.sqlite")).toString();
    expect(source).not.toContain(paired.token);
    expect(source).not.toContain(code);
    const other = new Pairing(join(directory, "devices.sqlite"));
    try {
      expect(other.revoke(paired.device.id)).toBe(true);
      expect(pairing.authenticate(paired.token)).toBeNull();
    } finally {
      other.close();
    }
  } finally {
    pairing.close();
  }
});

test("only explicit HTTPS origins can be paired", () => {
  expect(serverOrigin("https://host.example:8443/")).toBe("https://host.example:8443");
  for (const url of [
    "http://localhost",
    "https://user@host.example",
    "https://host.example/path",
    "https://host.example?token=x",
  ])
    expect(() => serverOrigin(url)).toThrow();
});

test("HTTP and streams require credentials, refresh and reject revoked phones", async () => {
  const { pairing } = fixture();
  let fail = false;
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    discover: keepLast(async () => {
      if (fail) throw new Error("private provider response");
      return [
        {
          agent: "pi",
          id: "00000000-0000-0000-0000-000000000001",
          cwd: "/project",
          startedAt: 1,
          pid: 42,
          place: { kind: "kiln", name: "pi-1" },
        },
      ];
    }, "Session host"),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${origin}/v1/sessions`)).status).toBe(401);
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("open the kiln app on your phone");
    expect(
      (await fetch(`${origin}/v1/pair`, { method: "POST", headers: { Origin: "https://evil.example" } })).status,
    ).toBe(403);
    const invitation = pairing.invite();
    const response = await fetch(`${origin}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: invitation, name: "test" }),
    });
    const paired = (await response.json()) as { token: string; device: { id: string } };
    expect(response.status).toBe(200);
    const headers = { Authorization: `Bearer ${paired.token}` };
    const first = (await (await fetch(`${origin}/v1/sessions`, { headers })).json()) as {
      sequence: number;
      sessions: { handoff: { reason: string } }[];
    };
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]?.handoff).toEqual({ reason: "Open this Pi session in kiln on your computer" });
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/v1/events`, { headers });
    const received = new Promise<{ sequence: number }>((resolve, reject) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)));
      socket.onerror = () => reject(new Error("stream failed"));
    });
    expect((await received).sequence).toBeGreaterThanOrEqual(first.sequence);
    fail = true;
    await Bun.sleep(40);
    const stale = (await (await fetch(`${origin}/v1/sessions`, { headers })).json()) as {
      problem: string;
      sessions: unknown[];
    };
    expect(stale.sessions).toHaveLength(1);
    expect(stale.problem).not.toContain("private provider response");
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    pairing.revoke(paired.device.id);
    expect(await closed).toBe(4001);
    expect((await fetch(`${origin}/v1/sessions`, { headers })).status).toBe(401);
  } finally {
    server.stop();
    pairing.close();
  }
});

test("a phone registered for pushes keeps discovery checking between idle refreshes", async () => {
  const { pairing } = fixture();
  let calls = 0;
  const paired = pairing.exchange(pairing.invite(), "test");
  if (!paired) throw new Error("pairing failed");
  pairing.setPush(paired.device.id, { endpoint: "https://push.example/x", p256dh: "k", auth: "a", machine: "m" });
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    idleInterval: 60_000,
    pushInterval: 60,
    discover: async () => {
      calls++;
      return { sessions: [], problem: "", stale: false };
    },
  });
  try {
    await Bun.sleep(300);
    // Nothing works and no phone watches, yet a short turn between idle refreshes would still be seen.
    expect(calls).toBeGreaterThan(2);
    expect(calls).toBeLessThan(10);
  } finally {
    server.stop();
    pairing.close();
  }
});

test("discovery runs every interval only while a phone is connected", async () => {
  const { pairing } = fixture();
  let calls = 0;
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    idleInterval: 60_000,
    discover: async () => {
      calls++;
      return { sessions: [], problem: "", stale: false };
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    await Bun.sleep(200);
    expect(calls).toBe(1);
    const { token } = pairing.exchange(pairing.invite(), "test")!;
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await new Promise((resolve) => (socket.onopen = resolve));
    await Bun.sleep(200);
    expect(calls).toBeGreaterThan(4);
    socket.close();
  } finally {
    server.stop();
    pairing.close();
  }
});

test("phone projection retains provider ancestry without terminal PIDs", () => {
  const parent: Session = {
    id: "parent",
    agent: "codex",
    cwd: "/project",
    startedAt: 1,
    place: { kind: "kiln", name: "parent" },
  };
  const child: Session = { ...parent, id: "child", parentSessionId: "parent" };
  expect(phoneSession(child, sessionParents([child, parent]).get(child)).parentId).toBe(phoneSession(parent).id);
});

test("phone parent IDs include the originating provider for cross-provider helpers", () => {
  const parent: Session = {
    agent: "codex",
    id: "parent",
    cwd: "/parent",
    startedAt: 1,
    place: { kind: "thread", id: "parent", attach: [] },
  };
  const child: Session = {
    agent: "claude",
    id: "child",
    parentSessionId: "parent",
    parentSessionAgent: "codex",
    cwd: "/child",
    startedAt: 2,
    place: { kind: "elsewhere" },
  };
  expect(phoneSession(child, sessionParents([parent, child]).get(child)).parentId).toBe("codex:parent");
});

test("phone writes pass the gate only when on, for an offered directory, an enabled agent and a short prompt", async () => {
  const { directory, pairing } = fixture();
  const previousState = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = directory;
  const project = mkdtempSync(join(directory, "project-"));
  let current: Settings = { ...defaults, zoxide: false };
  const started: [string, string, string][] = [];
  const delivered: string[] = [];
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    settings: () => current,
    discover: keepLast(
      async () => [
        { agent: "claude", id: "running", cwd: project, startedAt: 1, place: { kind: "kiln", name: "claude-1" } },
      ],
      "Session host",
    ),
    start: async (agent, cwd, prompt) => {
      started.push([agent, cwd, prompt]);
      return { kind: "attach", name: "claude-new" };
    },
    deliver: async (sessions) => {
      delivered.push(...sessions.map((session) => session.id ?? ""));
      return [];
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const paired = pairing.exchange(pairing.invite(), "Pixel");
  if (!paired) throw new Error("pairing failed");
  const call = (path: string, body?: unknown, token = paired.token) =>
    fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await Bun.sleep(40);
    const snapshot = (await (await call("/v1/sessions")).json()) as {
      write: boolean;
      sessions: { terminal: string }[];
    };
    expect(snapshot.write).toBe(false);
    expect(snapshot.sessions[0]?.terminal).toBe("claude-1");
    const request = { agent: "claude", directory: project, prompt: "fix the tests" };
    expect((await call("/v1/sessions", request)).status).toBe(403);
    expect((await call("/v1/directories")).status).toBe(403);
    expect((await call("/v1/sessions/claude%3Arunning/messages", { text: "hi" })).status).toBe(403);

    current = { ...current, phoneWrite: true };
    expect(await (await call("/v1/directories")).json()).toEqual({
      directories: [project],
      agents: ["claude", "codex", "opencode", "pi"],
    });
    expect((await call("/v1/sessions", { ...request, directory: "/etc" })).status).toBe(400);
    expect((await call("/v1/sessions", { ...request, directory: join(project, "..") })).status).toBe(400);
    expect((await call("/v1/sessions", { ...request, agent: "gemini" })).status).toBe(400);
    current = { ...current, agents: { ...current.agents, codex: [] } };
    expect((await call("/v1/sessions", { ...request, agent: "codex" })).status).toBe(400);
    expect((await call("/v1/sessions", { ...request, prompt: "x".repeat(promptLimit + 1) })).status).toBe(413);
    expect((await call("/v1/sessions", { ...request, prompt: " " })).status).toBe(400);
    expect(started).toEqual([]);

    const ok = await call("/v1/sessions", { ...request, prompt: "x".repeat(promptLimit) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ terminal: "claude-new" });
    expect(started.map(([agent, cwd]) => [agent, cwd])).toEqual([["claude", project]]);
    expect(pairing.starts(paired.device.id)).toMatchObject([{ agent: "claude", directory: project }]);

    expect((await call("/v1/sessions/claude%3Aother/messages", { text: "hi" })).status).toBe(404);
    expect((await call("/v1/sessions/claude%E0%A4%A/messages", { text: "hi" })).status).toBe(400);
    const sent = await call("/v1/sessions/claude%3Arunning/messages", { text: "carry on" });
    expect(await sent.json()).toEqual({ delivered: true });
    expect(delivered).toContain("running");

    pairing.revoke(paired.device.id);
    expect((await call("/v1/sessions", request)).status).toBe(401);
    expect((await call("/v1/sessions/claude%3Arunning/messages", { text: "hi" })).status).toBe(401);
    expect(pairing.starts(paired.device.id)).toEqual([]);
  } finally {
    server.stop();
    pairing.close();
    if (previousState === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = previousState;
  }
});

test("a phone starts at most twenty sessions in ten minutes", () => {
  const { pairing } = fixture();
  try {
    for (let index = 0; index < startLimit.count; index++) pairing.recordStart("phone", "claude", "/project", 1000);
    expect(() => pairing.recordStart("phone", "claude", "/project", 2000)).toThrow("wait before starting more");
    expect(() => pairing.recordStart("phone", "claude", "/project", 1000 + startLimit.perMs)).not.toThrow();
  } finally {
    pairing.close();
  }
});

test("offered directories put listed sessions first, newest first, and drop missing paths", () => {
  const session = (cwd: string, lastActiveAt: number): Session => ({
    agent: "claude",
    cwd,
    startedAt: 1,
    lastActiveAt,
    place: { kind: "kiln", name: cwd },
  });
  expect(
    offeredDirectories(
      [session("/old", 1), session("/new", 5)],
      ["/ranked", "/new", "/gone"],
      (path) => path !== "/gone",
    ),
  ).toEqual(["/new", "/old", "/ranked"]);
});
