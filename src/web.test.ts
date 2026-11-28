import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pairing } from "./pairing";
import { startServer } from "./server";
import { keepLast } from "./sessions";
import { defaults, type Settings } from "./settings";
import { cookieToken } from "./web";

const site = "https://kiln.example";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function serve(settings: () => Settings, origin: string | null = site) {
  const directory = mkdtempSync(join(tmpdir(), "kiln-web-test-"));
  directories.push(directory);
  const pairing = new Pairing(join(directory, "devices.sqlite"));
  const resumed: string[] = [];
  const server = startServer({
    port: 0,
    pairing,
    origin: origin ?? undefined,
    seen: async () => new Map(),
    interval: 20,
    settings,
    discover: keepLast(
      async () => [
        { agent: "claude", id: "gone", cwd: directory, startedAt: 1, lifecycle: "stopped", place: { kind: "saved" } },
      ],
      "Session host",
    ),
    resume: async (session) => {
      resumed.push(session.id ?? "");
      return { name: "claude-gone" };
    },
  });
  const address = `http://127.0.0.1:${server.port}`;
  return {
    pairing,
    resumed,
    address,
    call: (path: string, init: RequestInit = {}) => fetch(`${address}${path}`, init),
    stop() {
      server.stop();
      pairing.close();
    },
  };
}

/** Pairs as the web client does and returns the cookie the server set. */
async function pairBrowser(server: ReturnType<typeof serve>) {
  const response = await server.call("/v1/pair", {
    method: "POST",
    headers: { Origin: site, "Content-Type": "application/json" },
    body: JSON.stringify({ code: server.pairing.invite(), name: "Laptop" }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  const cookie = response.headers.get("Set-Cookie") ?? "";
  return { body, cookie, pair: cookie.split(";")[0] ?? "" };
}

test("a browser pairs into an HttpOnly, Secure, SameSite=Strict cookie and never sees its token", async () => {
  const server = serve(() => defaults);
  try {
    const { body, cookie, pair } = await pairBrowser(server);
    expect(body.token).toBeUndefined();
    expect(body.device).toMatchObject({ name: "Laptop" });
    expect(cookie).toStartWith("__Host-kiln=");
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(cookie).toContain(attribute);
    const token = cookieToken(new Request(server.address, { headers: { Cookie: `other=1; ${pair}` } }));
    expect(token && server.pairing.authenticate(token)?.name).toBe("Laptop");
    // A plain GET from the page carries no Origin, as browsers send them same-origin.
    expect((await server.call("/v1/sessions", { headers: { Cookie: pair } })).status).toBe(200);
  } finally {
    server.stop();
  }
});

test("the server's own page is served with a policy that blocks framing and foreign script", async () => {
  const server = serve(() => defaults);
  try {
    const page = await server.call("/");
    expect(page.headers.get("Content-Type")).toStartWith("text/html");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await page.text()).toContain('src="/web.js"');
    expect((await server.call("/web.js")).headers.get("Content-Type")).toStartWith("text/javascript");
  } finally {
    server.stop();
  }
});

test("a server without an origin serves no web client and refuses every browser request", async () => {
  const server = serve(() => defaults, null);
  try {
    expect(await (await server.call("/")).text()).toContain("Open the kiln app on your phone");
    expect((await server.call("/web.js")).status).toBe(401);
    const pair = await server.call("/v1/pair", {
      method: "POST",
      headers: { Origin: site, "Content-Type": "application/json" },
      body: JSON.stringify({ code: server.pairing.invite(), name: "Laptop" }),
    });
    expect(pair.status).toBe(403);
  } finally {
    server.stop();
  }
});

test("a foreign Origin is refused for pairing, reads, writes and the event stream", async () => {
  const server = serve(() => ({ ...defaults, phoneWrite: true }));
  try {
    const { pair } = await pairBrowser(server);
    for (const foreign of [
      "https://evil.example",
      "null",
      "https://kiln.example.evil.example",
      "http://kiln.example",
    ]) {
      const headers = { Cookie: pair, Origin: foreign, "Content-Type": "application/json" };
      expect((await server.call("/v1/sessions", { headers })).status).toBe(403);
      expect((await server.call("/v1/sessions/claude%3Agone/resume", { method: "POST", headers })).status).toBe(403);
      const pairing = await server.call("/v1/pair", {
        method: "POST",
        headers,
        body: JSON.stringify({ code: server.pairing.invite(), name: "Evil" }),
      });
      expect(pairing.status).toBe(403);
    }
    const socket = new WebSocket(`${server.address.replace("http:", "ws:")}/v1/events`, {
      headers: { Cookie: pair, Origin: "https://evil.example" },
    });
    expect(await new Promise((resolve) => (socket.onerror = () => resolve("refused")))).toBe("refused");
    expect(server.resumed).toEqual([]);
  } finally {
    server.stop();
  }
});

test("a cookie write or event stream without an Origin is refused, so a cross-site form cannot post", async () => {
  const server = serve(() => ({ ...defaults, phoneWrite: true }));
  try {
    const { pair } = await pairBrowser(server);
    const resume = await server.call("/v1/sessions/claude%3Agone/resume", {
      method: "POST",
      headers: { Cookie: pair },
    });
    expect(resume.status).toBe(403);
    const socket = new WebSocket(`${server.address.replace("http:", "ws:")}/v1/events`, { headers: { Cookie: pair } });
    expect(await new Promise((resolve) => (socket.onerror = () => resolve("refused")))).toBe("refused");
    expect(server.resumed).toEqual([]);
  } finally {
    server.stop();
  }
});

test("a missing or unknown cookie is not paired", async () => {
  const server = serve(() => ({ ...defaults, phoneWrite: true }));
  try {
    expect((await server.call("/v1/sessions", { headers: { Origin: site } })).status).toBe(401);
    const unknown = `__Host-kiln=${"a".repeat(43)}`;
    expect((await server.call("/v1/sessions", { headers: { Origin: site, Cookie: unknown } })).status).toBe(401);
    const write = await server.call("/v1/sessions/claude%3Agone/resume", { method: "POST", headers: { Origin: site } });
    expect(write.status).toBe(401);
  } finally {
    server.stop();
  }
});

test("revoking a browser closes its stream and refuses its cookie; unpairing revokes it too", async () => {
  const server = serve(() => defaults);
  try {
    const first = await pairBrowser(server);
    const socket = new WebSocket(`${server.address.replace("http:", "ws:")}/v1/events`, {
      headers: { Cookie: first.pair, Origin: site },
    });
    const snapshot = await new Promise<{ host: string }>((resolve, reject) => {
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)));
      socket.onerror = () => reject(new Error("stream failed"));
    });
    expect(typeof snapshot.host).toBe("string");
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    server.pairing.revoke(String((first.body.device as { id: string }).id));
    expect(await closed).toBe(4001);
    expect((await server.call("/v1/sessions", { headers: { Cookie: first.pair } })).status).toBe(401);

    const second = await pairBrowser(server);
    const unpaired = await server.call("/v1/unpair", {
      method: "POST",
      headers: { Cookie: second.pair, Origin: site },
    });
    expect(unpaired.status).toBe(200);
    expect(unpaired.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(server.pairing.devices()).toEqual([]);
  } finally {
    server.stop();
  }
});

test("a browser on a read-only computer cannot write", async () => {
  let current: Settings = { ...defaults, zoxide: false };
  const server = serve(() => current);
  try {
    const { pair } = await pairBrowser(server);
    const headers = { Cookie: pair, Origin: site };
    await Bun.sleep(40);
    const snapshot = (await (await server.call("/v1/sessions", { headers })).json()) as { write: boolean };
    expect(snapshot.write).toBe(false);
    expect((await server.call("/v1/sessions/claude%3Agone/resume", { method: "POST", headers })).status).toBe(403);
    expect(server.resumed).toEqual([]);
    current = { ...current, phoneWrite: true };
    const resumed = await server.call("/v1/sessions/claude%3Agone/resume", { method: "POST", headers });
    expect(await resumed.json()).toEqual({ terminal: "claude-gone" });
    expect(server.resumed).toEqual(["gone"]);
  } finally {
    server.stop();
  }
});
