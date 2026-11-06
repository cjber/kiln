import { afterEach, expect, test } from "bun:test";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullRequests } from "./dashboard";
import { Pairing } from "./pairing";
import { encryptPush, failingAlerts, type PushAlert, pushTarget, sendPush } from "./push";
import { startServer } from "./server";
import type { Session } from "./sessions";

const b64 = (value: string) => Buffer.from(value.replaceAll(" ", ""), "base64url");

// RFC 8291 section 5 and appendix A.
const vector = {
  plaintext: b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
  asPrivate: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
  auth: b64("BTBZMqHH6r4Tts7J_aSIgg").toString("base64url"),
  message: b64(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  ),
};

/** The phone's side of RFC 8291, written independently of `encryptPush`. */
function decryptPush(message: Buffer, uaPrivate: Buffer, auth: string): Buffer {
  const salt = message.subarray(0, 16);
  const keyLength = message[20] ?? 0;
  const serverKey = message.subarray(21, 21 + keyLength);
  const body = message.subarray(21 + keyLength);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(serverKey), b64(auth), info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1);
}

function phoneKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

test("encryption matches the RFC 8291 example byte for byte and decrypts", () => {
  const message = encryptPush(
    vector.plaintext,
    { p256dh: vector.uaPublic, auth: vector.auth },
    { salt: vector.salt, privateKey: vector.asPrivate },
  );
  expect(message.equals(vector.message)).toBe(true);
  expect(decryptPush(message, vector.uaPrivate, vector.auth).equals(vector.plaintext)).toBe(true);
});

test("a fresh message round-trips with new keys and never repeats its ciphertext", () => {
  const phone = phoneKeys();
  const payload = Buffer.from(JSON.stringify({ v: 1, title: "Fix the build" }));
  const first = encryptPush(payload, phone);
  const second = encryptPush(payload, phone);
  expect(first.equals(second)).toBe(false);
  expect(decryptPush(first, phone.privateKey, phone.auth).equals(payload)).toBe(true);
  // The whole message, header included, stays within UnifiedPush's 4096 bytes.
  expect(encryptPush(Buffer.alloc(3993), phone)).toHaveLength(4096);
  expect(() => encryptPush(Buffer.alloc(3994), phone)).toThrow();
});

test("registrations need an HTTPS endpoint, a P-256 point and a 16-byte auth secret", () => {
  const { p256dh, auth } = phoneKeys();
  const endpoint = "https://ntfy.sh/upAbc123?up=1";
  const machine = "https://desk.tailnet.ts.net";
  expect(pushTarget({ endpoint, p256dh, auth, machine })).toEqual({ endpoint, p256dh, auth, machine });
  for (const body of [
    null,
    "text",
    { endpoint: "http://ntfy.sh/up", p256dh, auth },
    { endpoint: "https://user:secret@ntfy.sh/up", p256dh, auth },
    { endpoint: `https://ntfy.sh/${"a".repeat(1024)}`, p256dh, auth },
    { endpoint: "not a url", p256dh, auth },
    { endpoint, p256dh: p256dh.slice(1), auth },
    { endpoint, p256dh: `A${p256dh.slice(1)}`, auth },
    // Right length and prefix, but not a point on the curve.
    { endpoint, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), auth },
    { endpoint, p256dh, auth: `${auth}AA` },
    { endpoint, p256dh, auth: "not+base64/url" },
    { endpoint, p256dh: 4, auth },
    { endpoint, p256dh, auth, machine: "" },
    { endpoint, p256dh, auth, machine: "a\nb" },
    { endpoint, p256dh, auth, machine: "a".repeat(257) },
  ].map((body) => (body && typeof body === "object" && !("machine" in body) ? { ...body, machine } : body)))
    expect(pushTarget(body)).toBeUndefined();
  expect(pushTarget({ endpoint, p256dh, auth })).toBeUndefined();
});

const alert: PushAlert = {
  v: 1,
  host: "desk",
  machine: "https://desk.example",
  session: "claude:1",
  title: "t",
  agent: "claude",
  cwd: "/p",
  transition: "finished",
  at: 1,
};

test("sending reports gone endpoints and swallows failures and timeouts", async () => {
  const target = { endpoint: "https://push.example/up", machine: "https://desk.example", ...phoneKeys() };
  const seen: RequestInit[] = [];
  const reply = (status: number) =>
    (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status });
    }) as unknown as typeof fetch;
  expect(await sendPush(target, alert, reply(201))).toBe("sent");
  expect(seen[0]?.headers).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: "3600" });
  expect(await sendPush(target, alert, reply(410))).toBe("gone");
  expect(await sendPush(target, alert, reply(404))).toBe("gone");
  expect(await sendPush(target, alert, reply(500))).toBe("failed");
  const broken = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  expect(await sendPush(target, alert, broken)).toBe("failed");
  const hanging = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) =>
      init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    )) as unknown as typeof fetch;
  expect(await sendPush(target, alert, hanging, 20)).toBe("failed");
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("the push route validates, replaces, unregisters, pushes turn ends and forgets revoked phones", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-push-test-"));
  directories.push(directory);
  const pairing = new Pairing(join(directory, "devices.sqlite"));
  let activity: Session["activity"] = "working";
  const sent: { endpoint: string; alert: PushAlert }[] = [];
  let reply: "sent" | "gone" = "sent";
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    idleInterval: 20,
    discover: async () => ({
      sessions: [
        {
          agent: "claude",
          id: "s1",
          cwd: "/project",
          title: "Fix the build",
          startedAt: 1,
          activity,
          place: { kind: "kiln", name: "claude-1" },
        },
      ],
      problem: "",
      stale: false,
    }),
    push: async (target, next) => {
      sent.push({ endpoint: target.endpoint, alert: next });
      return reply;
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const register = (body: unknown, token: string, type = "application/json") =>
    fetch(`${origin}/v1/push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
      body: JSON.stringify(body),
    });
  try {
    const paired = pairing.exchange(pairing.invite(), "Pixel");
    if (!paired) throw new Error("pairing failed");
    const keys = phoneKeys();
    const body = {
      endpoint: "https://ntfy.sh/upOne",
      p256dh: keys.p256dh,
      auth: keys.auth,
      machine: "https://desk.example",
    };
    expect((await register(body, "x".repeat(43))).status).toBe(401);
    expect((await register(body, paired.token, "text/plain")).status).toBe(415);
    expect((await register({ ...body, endpoint: "http://ntfy.sh/up" }, paired.token)).status).toBe(400);
    expect(
      (
        await fetch(`${origin}/v1/push`, {
          method: "POST",
          headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    const large = await register({ ...body, padding: "a".repeat(5000) }, paired.token);
    expect(large.status).toBe(413);
    expect(pairing.pushTargets()).toEqual([]);
    expect((await register({ ...body, endpoint: "https://ntfy.sh/upOld" }, paired.token)).status).toBe(200);
    expect((await register(body, paired.token)).status).toBe(200);
    expect(pairing.pushTargets()).toEqual([{ device: paired.device.id, ...body }]);

    await Bun.sleep(60);
    activity = "idle";
    while (!sent.length) await Bun.sleep(10);
    const snapshot = (await (
      await fetch(`${origin}/v1/sessions`, { headers: { Authorization: `Bearer ${paired.token}` } })
    ).json()) as { updatedAt: number; host: string; sessions: { id: string }[] };
    expect(sent).toHaveLength(1);
    expect(sent[0]?.endpoint).toBe(body.endpoint);
    expect(sent[0]?.alert).toMatchObject({
      v: 1,
      host: snapshot.host,
      machine: "https://desk.example",
      session: snapshot.sessions[0]?.id,
      title: "Fix the build",
      transition: "finished",
    });
    expect(sent[0]?.alert.at).toBeLessThanOrEqual(snapshot.updatedAt);

    // Working again means the person answered, so the phone clears the alert.
    activity = "working";
    while (sent.at(-1)?.alert.transition !== "read") await Bun.sleep(10);
    expect(sent.at(-1)?.alert).toMatchObject({ session: "claude:s1", at: sent[0]?.alert.at });

    // An endpoint the distributor says is gone is dropped after its next push.
    reply = "gone";
    activity = "waiting";
    while (pairing.pushTargets().length) await Bun.sleep(10);
    expect(sent.at(-1)?.alert.transition).toBe("input");

    expect((await register(body, paired.token)).status).toBe(200);
    const removed = await fetch(`${origin}/v1/push`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    expect(removed.status).toBe(200);
    expect(pairing.pushTargets()).toEqual([]);

    expect((await register(body, paired.token)).status).toBe(200);
    pairing.revoke(paired.device.id);
    expect(pairing.pushTargets()).toEqual([]);
  } finally {
    server.stop();
    pairing.close();
  }
});

test("an alert is cleared once its terminal is attached or typed in after it, and only once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-push-test-"));
  directories.push(directory);
  const pairing = new Pairing(join(directory, "devices.sqlite"));
  let activity: Session["activity"] = "working";
  let seenAt = 0;
  const sent: PushAlert[] = [];
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    idleInterval: 20,
    discover: async () => ({
      sessions: [
        {
          agent: "claude",
          id: "s1",
          cwd: "/project",
          startedAt: 1,
          activity,
          place: { kind: "kiln", name: "claude-1" },
        },
      ],
      problem: "",
      stale: false,
    }),
    seen: async () => new Map([["claude-1", seenAt]]),
    push: async (_, next) => {
      sent.push(next);
      return "sent";
    },
  });
  try {
    const paired = pairing.exchange(pairing.invite(), "Pixel");
    if (!paired) throw new Error("pairing failed");
    const keys = phoneKeys();
    pairing.setPush(paired.device.id, {
      endpoint: "https://ntfy.sh/upOne",
      p256dh: keys.p256dh,
      auth: keys.auth,
      machine: "https://desk.example",
    });
    await Bun.sleep(60);
    activity = "idle";
    while (!sent.length) await Bun.sleep(10);
    const at = sent[0]?.at ?? 0;
    // Looking before the alert is not reading it.
    seenAt = at;
    await Bun.sleep(80);
    expect(sent.map((alert) => alert.transition)).toEqual(["finished"]);
    const rows = (await (
      await fetch(`http://127.0.0.1:${server.port}/v1/sessions`, {
        headers: { Authorization: `Bearer ${paired.token}` },
      })
    ).json()) as { sessions: { seenAt?: number }[] };
    expect(rows.sessions[0]?.seenAt).toBe(at);
    seenAt = at + 1000;
    while (sent.length < 2) await Bun.sleep(10);
    await Bun.sleep(80);
    expect(sent.map((alert) => alert.transition)).toEqual(["finished", "read"]);
  } finally {
    server.stop();
    pairing.close();
  }
});

test("a pull request turning red alerts once, and clears once it leaves failing or its session closes", () => {
  const alerts = failingAlerts();
  const row = (stage: "working" | "checks" | "green" | "failing", id = "claude:1") => ({
    id,
    title: "Fix retry",
    agent: "claude",
    cwd: "/w",
    stage,
    pr: { number: 212 },
  });
  const step = (rows: ReturnType<typeof row>[], at: number, enabled = true) =>
    alerts(rows, "desk", at, enabled).map((alert) => `${alert.session} ${alert.transition} #${alert.pr} ${alert.at}`);
  // A server start sees `working` until the first lookup lands, which is not a pull request turning red.
  expect(step([row("working")], 1)).toEqual([]);
  expect(step([row("failing")], 2)).toEqual([]);
  expect(step([row("checks")], 3)).toEqual([]);
  expect(step([row("failing")], 4)).toEqual(["claude:1 failing #212 4"]);
  expect(step([row("failing")], 5)).toEqual([]);
  expect(step([row("green")], 6)).toEqual(["claude:1 failing-cleared #212 6"]);
  expect(step([row("failing")], 7)).toEqual(["claude:1 failing #212 7"]);
  // A closed session's alert is cleared too.
  expect(step([], 8)).toEqual(["claude:1 failing-cleared #212 8"]);
  // With no push target there is nobody to tell, and the history starts over.
  expect(step([row("green")], 9)).toEqual([]);
  expect(step([row("failing")], 10, false)).toEqual([]);
  expect(step([row("failing")], 11)).toEqual([]);
});

test("a registered phone alone keeps pull requests looked up and is pushed a failing pull request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-push-test-"));
  directories.push(directory);
  mkdirSync(join(directory, ".git"));
  writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/cb/x\n");
  const pairing = new Pairing(join(directory, "devices.sqlite"));
  let conclusion = "IN_PROGRESS";
  let lookups = 0;
  const sent: PushAlert[] = [];
  const pr = () => ({
    number: 212,
    url: "https://github.com/o/r/pull/212",
    state: "OPEN",
    isDraft: false,
    additions: 1,
    deletions: 0,
    labels: [],
    statusCheckRollup: [conclusion === "IN_PROGRESS" ? { status: "IN_PROGRESS" } : { status: "COMPLETED", conclusion }],
  });
  const server = startServer({
    port: 0,
    pairing,
    interval: 20,
    idleInterval: 20,
    pushInterval: 20,
    seen: async () => new Map(),
    discover: async () => ({
      sessions: [
        { agent: "claude", id: "s1", cwd: directory, startedAt: 1, place: { kind: "kiln", name: "claude-1" } },
      ],
      problem: "",
      stale: false,
    }),
    prs: pullRequests({
      gh: true,
      prAge: 0,
      exec: async (argv) => {
        lookups++;
        return JSON.stringify(argv[2] === "graphql" ? { data: { p0: pr() } } : [pr()]);
      },
    }),
    push: async (_, next) => {
      sent.push(next);
      return "sent";
    },
  });
  try {
    await Bun.sleep(80);
    // No phone watches and none is registered, so `gh` is never run.
    expect(lookups).toBe(0);
    const paired = pairing.exchange(pairing.invite(), "Pixel");
    if (!paired) throw new Error("pairing failed");
    const keys = phoneKeys();
    pairing.setPush(paired.device.id, {
      endpoint: "https://ntfy.sh/upOne",
      p256dh: keys.p256dh,
      auth: keys.auth,
      machine: "https://desk.example",
    });
    while (!lookups) await Bun.sleep(10);
    await Bun.sleep(100);
    conclusion = "FAILURE";
    while (!sent.some((alert) => alert.transition === "failing")) await Bun.sleep(10);
    expect(sent.find((alert) => alert.transition === "failing")).toMatchObject({ session: "claude:s1", pr: 212 });
    conclusion = "SUCCESS";
    while (!sent.some((alert) => alert.transition === "failing-cleared")) await Bun.sleep(10);
    // Turn alerts and their reads are a separate stream, so nothing else was pushed.
    expect(sent.map((alert) => alert.transition)).toEqual(["failing", "failing-cleared"]);
  } finally {
    server.stop();
    pairing.close();
  }
});
