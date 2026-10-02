import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pairing, serverOrigin } from "./pairing";
import { phoneSession, startServer } from "./server";
import { keepLast, type Session, sessionParents } from "./sessions";

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
          agent: "codex",
          id: "00000000-0000-0000-0000-000000000001",
          cwd: "/project",
          startedAt: 1,
          pid: 42,
          place: { kind: "acp", id: "00000000-0000-0000-0000-000000000001" },
        },
      ];
    }, "Session host"),
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
      sessions: { handoff: { reason: string } }[];
    };
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]?.handoff).toEqual({ reason: "Open this saved ACP session in kiln on your PC" });
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

test("phone projection retains provider ancestry without terminal PIDs", () => {
  const parent: Session = {
    id: "parent",
    agent: "codex",
    cwd: "/project",
    startedAt: 1,
    place: { kind: "acp", id: "parent" },
  };
  const child: Session = { ...parent, id: "child", parentSessionId: "parent" };
  expect(phoneSession(child, sessionParents([child, parent]).get(child)).parentId).toBe(phoneSession(parent).id);
});

test("paired phone reads the same ACP prompt, approval and completion as the local client", async () => {
  const { directory, pairing } = fixture();
  const { startAcpHost, acpRequest } = await import("./acp-host");
  const previousSocket = Bun.env.KILN_ACP_SOCKET;
  const previousConfig = Bun.env.XDG_CONFIG_HOME;
  Bun.env.KILN_ACP_SOCKET = join(directory, "host.sock");
  Bun.env.XDG_CONFIG_HOME = join(directory, "config");
  mkdirSync(join(Bun.env.XDG_CONFIG_HOME, "kiln"), { recursive: true });
  writeFileSync(
    join(Bun.env.XDG_CONFIG_HOME, "kiln", "config.toml"),
    `notifications = false\n[agents]\ncodex = ${JSON.stringify([process.execPath, resolve("scripts/acp-fixture.ts")])}\n`,
  );
  const host = startAcpHost();
  const session = await acpRequest<Session>("/sessions", { agent: "codex", cwd: process.cwd() });
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    discover: keepLast(() => acpRequest<Session[]>("/sessions"), "Session host"),
  });
  const paired = pairing.exchange(pairing.invite(), "ACP phone");
  if (!paired || !session.id) throw new Error("Missing ACP test identity");
  const origin = `http://127.0.0.1:${server.port}`;
  const headers = { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" };
  const route = `${origin}/v1/acp/${session.id}`;
  const command = (body: object) => fetch(route, { headers, method: "POST", body: JSON.stringify(body) });
  try {
    await Bun.sleep(30);
    expect((await fetch(route)).status).toBe(401);
    for (const body of ["{not json", "null"])
      expect((await fetch(route, { headers, method: "POST", body })).status).toBe(400);
    expect((await command({ type: "prompt", message: "approve this" })).status).toBe(200);
    let snapshot:
      | { activity: string; approvals: { id: string; options: { optionId: string }[] }[]; messages: { text: string }[] }
      | undefined;
    for (let i = 0; i < 100; i++) {
      snapshot = (await (await fetch(route, { headers })).json()) as typeof snapshot;
      if (snapshot?.activity === "waiting") break;
      await Bun.sleep(20);
    }
    expect(snapshot?.activity).toBe("waiting");
    expect(snapshot?.approvals).toHaveLength(1);
    const approval = snapshot?.approvals[0];
    if (!approval) throw new Error("Missing phone approval");
    expect((await command({ type: "approve", approvalId: "stale", optionId: "allow" })).status).toBe(409);
    expect((await command({ type: "approve", approvalId: approval.id, optionId: "allow" })).status).toBe(200);
    expect((await command({ type: "approve", approvalId: approval.id, optionId: "allow" })).status).toBe(409);
    for (let i = 0; i < 100; i++) {
      snapshot = (await (await fetch(route, { headers })).json()) as typeof snapshot;
      if (snapshot?.activity === "idle") break;
      await Bun.sleep(20);
    }
    expect(snapshot?.activity).toBe("idle");
    expect(snapshot?.approvals).toEqual([]);
    expect(snapshot?.messages.at(-1)?.text).toContain("Permission answered");
    expect(pairing.revoke(paired.device.id)).toBe(true);
    expect((await command({ type: "prompt", message: "revoked" })).status).toBe(401);
  } finally {
    server.stop();
    host.stop();
    pairing.close();
    if (previousSocket === undefined) delete Bun.env.KILN_ACP_SOCKET;
    else Bun.env.KILN_ACP_SOCKET = previousSocket;
    if (previousConfig === undefined) delete Bun.env.XDG_CONFIG_HOME;
    else Bun.env.XDG_CONFIG_HOME = previousConfig;
  }
});
