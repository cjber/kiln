import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pairing, serverOrigin } from "./pairing";
import { claudeBridgeLink, phoneHandoff } from "./phone-links";
import { phoneSession, startServer } from "./server";
import { type Session, sessionParent } from "./sessions";

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

test("Claude links require matching live-session metadata", () => {
  const { directory, pairing } = fixture();
  pairing.close();
  mkdirSync(join(directory, "sessions"));
  const session: Session = {
    id: "uuid",
    pid: 42,
    agent: "claude",
    cwd: "/project",
    startedAt: 1,
    place: { kind: "elsewhere" },
  };
  const file = join(directory, "sessions", "42.json");
  writeFileSync(file, JSON.stringify({ pid: 42, sessionId: "different", bridgeSessionId: "cse_safe" }));
  expect(claudeBridgeLink(session, directory)).toBeUndefined();
  writeFileSync(file, JSON.stringify({ pid: 42, sessionId: "uuid", bridgeSessionId: "cse_safe" }));
  expect(claudeBridgeLink(session, directory)).toBe("https://claude.ai/code/cse_safe");
});

test("HTTP and streams require credentials, refresh and reject revoked phones", async () => {
  const { pairing } = fixture();
  let fail = false;
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    readCodexHost: async () => ({ id: "slingshot:env_example:8765" }),
    load: async () => {
      if (fail) throw new Error("private provider response");
      return [
        {
          agent: "codex",
          id: "00000000-0000-0000-0000-000000000001",
          cwd: "/project",
          startedAt: 1,
          pid: 42,
          place: { kind: "elsewhere" },
        },
      ];
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${origin}/v1/sessions`)).status).toBe(401);
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
      sessions: { handoff: { url: string; exact: boolean } }[];
    };
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]?.handoff).toMatchObject({
      exact: true,
      url: "https://chatgpt.com/codex/remote/thread/00000000-0000-0000-0000-000000000001?hostId=slingshot%3Aenv_example%3A8765",
    });
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

test("local Codex handoffs use only validated thread and relay identities", () => {
  const session: Session = {
    agent: "codex",
    id: "00000000-0000-0000-0000-000000000001",
    cwd: "/project",
    startedAt: 1,
    place: { kind: "elsewhere" },
  };
  expect(phoneHandoff(session, "slingshot:env_example:8765")).toMatchObject({ exact: true });
  expect(phoneHandoff(session)).toMatchObject({ exact: false, url: "https://chatgpt.com/codex" });
  expect(phoneHandoff(session, "slingshot:env_example:8765&token=private")).toMatchObject({ exact: false });
  expect(phoneHandoff({ ...session, id: "../other" }, "slingshot:env_example:8765")).toMatchObject({ exact: false });
});

test("phone projection retains provider ancestry without terminal PIDs", () => {
  const parent: Session = {
    id: "parent",
    agent: "codex",
    cwd: "/project",
    startedAt: 1,
    place: { kind: "background", id: "parent", attach: [] },
  };
  const child: Session = { ...parent, id: "child", parentSessionId: "parent" };
  expect(phoneSession(child, sessionParent(child, [child, parent])).parentId).toBe(phoneSession(parent).id);
});
