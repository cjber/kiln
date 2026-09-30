import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pairing } from "../src/pairing";
import { bridgeFor, piBridges, piRequest, piStates } from "../src/pi";
import { installPiExtension } from "../src/pi-install";
import { startServer } from "../src/server";
import remote from "./pi-remote.js";

test("Pi discovery verifies permissions and authenticated commands survive reconnect without a second prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-pi-test-"));
  const before = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  const handlers = new Map();
  const prompts = [];
  const context = {
    cwd: "/project",
    isIdle: () => true,
    abort: () => {},
    sessionManager: {
      getSessionId: () => "fixture",
      getSessionName: () => "Named Pi session",
      getBranch: () => [
        { type: "message", timestamp: "2026-09-30T12:00:00Z", message: { role: "user", content: "Existing prompt" } },
      ],
    },
    ui: { setStatus: () => {}, notify: () => {} },
  };
  remote({ on: (name, fn) => handlers.set(name, fn), sendUserMessage: (message) => prompts.push(message) });
  handlers.get("session_start")({}, context);
  let pairing;
  let server;
  try {
    let bridges = [];
    for (let tries = 0; tries < 100 && !bridges.length; tries++) {
      await Bun.sleep(5);
      bridges = piBridges();
    }
    expect(bridges).toHaveLength(1);
    const bridge = bridges[0];
    const states = await piStates([process.pid]);
    expect(states.get(process.pid)).toMatchObject({ title: "Named Pi session", activity: "idle" });
    chmodSync(bridge.socket, 0o666);
    expect(piBridges()).toEqual([]);
    chmodSync(bridge.socket, 0o600);
    expect(bridgeFor(process.pid)).toEqual(bridge);
    const state = await piRequest(bridge, { type: "get_state", transcript: true });
    expect(state.messages).toEqual([{ role: "user", text: "Existing prompt" }]);
    pairing = new Pairing(join(root, "devices.sqlite"));
    const first = pairing.exchange(pairing.invite(), "First");
    const second = pairing.exchange(pairing.invite(), "Second");
    server = startServer({
      port: 0,
      pairing,
      readCodexHost: async () => ({}),
      interval: 10,
      load: async () => [
        {
          agent: "pi",
          id: "fixture",
          pid: process.pid,
          piRemote: true,
          cwd: "/project",
          startedAt: 1,
          place: { kind: "elsewhere" },
        },
      ],
    });
    const url = `http://127.0.0.1:${server.port}/v1/pi/fixture`;
    await Bun.sleep(25);
    expect((await fetch(url)).status).toBe(401);
    const headers = { Authorization: `Bearer ${first.token}`, "Content-Type": "application/json" };
    expect((await fetch(url, { headers })).status).toBe(200);
    const body = JSON.stringify({
      type: "prompt",
      message: "A single prompt",
      id: "00000000-0000-0000-0000-000000000001",
    });
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(200);
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(200);
    expect(prompts).toEqual(["A single prompt"]);
    expect(
      (await fetch(url, { method: "POST", headers: { ...headers, Authorization: `Bearer ${second.token}` }, body }))
        .status,
    ).toBe(409);
    pairing.revoke(first.device.id);
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(401);
    expect(
      (
        await fetch(url.replace("fixture", "arbitrary-socket"), {
          headers: { Authorization: `Bearer ${second.token}` },
        })
      ).status,
    ).toBe(404);
  } finally {
    server?.stop();
    pairing?.close();
    handlers.get("session_shutdown")();
    if (before === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi extension installation stays opt-in and preserves unrelated extensions", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-pi-install-"));
  try {
    expect(installPiExtension(home, true)).toBeUndefined();
    const path = installPiExtension(home);
    expect(installPiExtension(home, true)).toBe(path);
    writeFileSync(path, "user extension");
    expect(() => installPiExtension(home)).toThrow("not managed by kiln");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
