import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullRequests } from "./dashboard";
import { pending } from "./mailbox";
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
    seen: async () => new Map(),
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
    seen: async () => new Map(),
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
    seen: async () => new Map(),
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

test("phone sessions carry their pull request stage, looked up only while a phone watches", async () => {
  const { directory, pairing } = fixture();
  mkdirSync(join(directory, ".git"));
  writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/cb/x\n");
  const lookups: string[][] = [];
  const pr = {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state: "OPEN",
    isDraft: false,
    additions: 1,
    deletions: 0,
    labels: [{ name: "mergepatrol" }],
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
  };
  const session: Session = {
    id: "s",
    agent: "claude",
    cwd: directory,
    startedAt: 1,
    place: { kind: "kiln", name: "claude-s" },
  };
  const server = startServer({
    port: 0,
    pairing,
    seen: async () => new Map(),
    interval: 20,
    idleInterval: 40,
    discover: async () => ({ sessions: [session], problem: "", stale: false }),
    prs: pullRequests({
      gh: true,
      exec: async (argv) => {
        lookups.push(argv);
        return JSON.stringify([pr]);
      },
    }),
  });
  try {
    await Bun.sleep(150);
    expect(lookups).toHaveLength(0);
    const paired = pairing.exchange(pairing.invite(), "test");
    if (!paired) throw new Error("pairing failed");
    const { token } = paired;
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let row: ReturnType<typeof phoneSession> | undefined;
    socket.onmessage = (event) => {
      row = JSON.parse(String(event.data)).sessions[0];
    };
    await Bun.sleep(200);
    socket.close();
    // One lookup for the branch, then one by URL for the details the branch lookup lacks.
    expect(lookups.filter((argv) => argv[1] === "pr")).toHaveLength(1);
    expect(lookups.filter((argv) => argv[2] === "graphql")).toHaveLength(1);
    expect(lookups[0]).toContain("cb/x");
    expect(row?.prs).toHaveLength(1);
    expect(row?.stage).toBe("failing");
    expect(row?.pr).toMatchObject({
      number: 7,
      url: pr.url,
      queued: true,
      checks: { passed: 0, failed: 1, running: 0 },
    });
  } finally {
    server.stop();
    pairing.close();
  }
});

test("with pr_messages on, pull requests are looked up and told to their agent with no phone connected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-autopilot-"));
  mkdirSync(join(directory, ".git"));
  writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/cb/x\n");
  const pairing = new Pairing(join(directory, "devices.sqlite"));
  const told: number[] = [];
  const session: Session = {
    id: "s",
    agent: "claude",
    cwd: directory,
    startedAt: 1,
    place: { kind: "kiln", name: "k" },
  };
  const server = startServer({
    port: 0,
    pairing,
    seen: async () => new Map(),
    interval: 20,
    idleInterval: 20,
    settings: () => ({ ...defaults, prMessages: true }),
    discover: async () => ({ sessions: [session], problem: "", stale: false }),
    prs: pullRequests({ gh: true, exec: async () => "[]" }),
    tell: (found) => {
      told.push(found.size);
      return 0;
    },
  });
  try {
    await Bun.sleep(150);
    expect(told.length).toBeGreaterThan(0);
  } finally {
    server.stop();
    pairing.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cloud tasks and default branches have no pull request stage", () => {
  const cloud: Session = {
    id: "c",
    agent: "claude",
    cwd: "/x",
    startedAt: 1,
    place: { kind: "cloud", url: "https://claude.ai/code/c" },
  } as Session;
  expect(phoneSession(cloud).stage).toBeUndefined();
  const local: Session = { id: "l", agent: "codex", cwd: "/x", startedAt: 1, place: { kind: "elsewhere" } };
  expect(phoneSession(local).stage).toBe("working");
  expect(phoneSession(local).pr).toBeUndefined();
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
    seen: async () => new Map(),
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

test("a session view reads its transcript, posts a retried reply once and refuses what it cannot do", async () => {
  const { directory, pairing } = fixture();
  const before = {
    config: Bun.env.CLAUDE_CONFIG_DIR,
    state: Bun.env.XDG_STATE_HOME,
    cache: Bun.env.XDG_CACHE_HOME,
  };
  Bun.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
  Bun.env.XDG_STATE_HOME = join(directory, "state");
  Bun.env.XDG_CACHE_HOME = join(directory, "cache");
  const id = "00000000-0000-0000-0000-0000000000c1";
  const projects = join(directory, "claude", "projects", "-project");
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(projects, `${id}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1", origin: { kind: "human" }, message: { content: "hello" } })}\n`,
  );
  const sessions: Session[] = [
    {
      agent: "claude",
      id,
      cwd: "/project",
      startedAt: 1,
      pid: 42,
      activity: "working",
      place: { kind: "kiln", name: "claude-1" },
    },
    { agent: "claude", id: "elsewhere-1", cwd: "/project", startedAt: 1, pid: 43, place: { kind: "elsewhere" } },
    {
      agent: "claude",
      cwd: "/project",
      startedAt: 1,
      pid: 44,
      activity: "idle",
      place: { kind: "kiln", name: "claude-2" },
    },
  ];
  let write = false;
  const server = startServer({
    port: 0,
    pairing,
    seen: async () => new Map(),
    interval: 20,
    settings: () => ({ ...defaults, zoxide: false, phoneWrite: write }),
    discover: async () => ({ sessions, problem: "", stale: false }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const invitation = pairing.invite();
    const paired = pairing.exchange(invitation, "test");
    if (!paired) throw new Error("pairing failed");
    const headers = { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" };
    const base = `${origin}/v1/sessions/${encodeURIComponent(`claude:${id}`)}`;
    await Bun.sleep(40);
    expect((await fetch(`${base}/view`)).status).toBe(401);
    // Reading a conversation and stopping a turn sit behind the same switch as sending to it.
    expect((await fetch(`${base}/view`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/interrupt`, { method: "POST", headers })).status).toBe(403);
    write = true;
    const view = (await (await fetch(`${base}/view`, { headers })).json()) as {
      abilities: { read: boolean; reply?: string; stop: boolean };
      items: { text: string }[];
      cursor: string;
    };
    expect(view.abilities).toEqual({ read: true, reply: undefined, stop: true });
    expect(view.items.map((item) => item.text)).toEqual(["hello"]);
    const again = (await (await fetch(`${base}/view?cursor=${view.cursor}`, { headers })).json()) as {
      items: unknown[];
      reset: boolean;
    };
    expect(again).toMatchObject({ items: [], reset: false });
    // Claude is working, so the reply waits; a retry under the same id is the same message.
    const send = () =>
      fetch(`${base}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "message-0001", text: "next" }),
      });
    expect(await (await send()).json()).toMatchObject({ delivered: false });
    expect((await send()).status).toBe(200);
    expect(pending(join(directory, "state", "kiln", "mailbox.sqlite"))).toMatchObject([
      { id: `phone-${paired.device.id}-message-0001`, from: "phone:test", to: `claude:${id}`, body: "next" },
    ]);
    const bad = await fetch(`${base}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "x", text: "y" }),
    });
    expect(bad.status).toBe(400);
    // An answer names the menu it was meant for, so one for a menu no longer on screen is refused.
    const answer = await fetch(`${base}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "gone", option: 1 }),
    });
    expect(answer.status).toBe(409);
    const upload = (name: string, body: string) =>
      fetch(`${base}/files?name=${encodeURIComponent(name)}`, { method: "POST", headers, body });
    const stored = (await (await upload("../photo 1.png", "png")).json()) as { path: string };
    expect(stored.path.startsWith(join(directory, "cache", "kiln", "uploads"))).toBe(true);
    expect(stored.path.endsWith("/photo-1.png")).toBe(true);
    expect(await Bun.file(stored.path).text()).toBe("png");
    expect((await upload("empty.txt", "")).status).toBe(400);
    const other = `${origin}/v1/sessions/${encodeURIComponent("claude:elsewhere-1")}`;
    expect((await fetch(`${other}/interrupt`, { method: "POST", headers })).status).toBe(409);
    expect((await fetch(`${origin}/v1/sessions/nope/view`, { headers })).status).toBe(404);
    // Without a provider id the mailbox could never deliver it, and an idle session has no turn to stop.
    const unnamed = `${origin}/v1/sessions/${encodeURIComponent("claude:44:1")}`;
    const abilities = ((await (await fetch(`${unnamed}/view`, { headers })).json()) as { abilities: unknown })
      .abilities;
    expect(abilities).toEqual({
      read: false,
      reply: "kiln can only write to a running session that reports its id",
      stop: false,
    });
    expect((await fetch(`${unnamed}/interrupt`, { method: "POST", headers })).status).toBe(409);
  } finally {
    server.stop();
    pairing.close();
    for (const [key, value] of [
      ["CLAUDE_CONFIG_DIR", before.config],
      ["XDG_STATE_HOME", before.state],
      ["XDG_CACHE_HOME", before.cache],
    ] as const)
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
  }
});
