import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/**
 * A phone's UnifiedPush endpoint and its Web Push keys, all as the phone sent them. `machine` is the
 * phone's own name for this server (its paired origin), echoed in each alert so the phone can tell
 * machines apart even when two share a hostname.
 */
export type PushTarget = { endpoint: string; p256dh: string; auth: string; machine: string };

/** What a phone shows for one turn ending; titles are safe because only the phone can decrypt it. */
export type PushAlert = {
  v: 1;
  host: string;
  machine: string;
  session: string;
  title: string;
  agent: string;
  cwd: string;
  /** `read` clears the earlier alert for the session, once it has been looked at on the computer. */
  transition: "finished" | "input" | "read";
  /** The snapshot's `updatedAt` for the refresh that saw the change; the phone dedupes on it. */
  at: number;
};

const RECORD_SIZE = 4096;
const base64url = /^[A-Za-z0-9_-]+$/;

function decoded(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== "string" || value.length > 128 || !base64url.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length ? bytes : undefined;
}

/** A registration body the server accepts, or undefined: an HTTPS endpoint and a valid P-256 key. */
export function pushTarget(body: unknown): PushTarget | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { endpoint, p256dh, auth, machine } = body as Record<string, unknown>;
  if (
    typeof machine !== "string" ||
    !machine ||
    machine.length > 256 ||
    [...machine].some((character) => character.charCodeAt(0) < 32)
  )
    return undefined;
  if (typeof endpoint !== "string" || endpoint.length > 1024) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
  const key = decoded(p256dh, 65);
  if (key?.[0] !== 4 || !decoded(auth, 16)) return undefined;
  try {
    // Rejects a point that is not on the curve before anything is stored.
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(key);
  } catch {
    return undefined;
  }
  return { endpoint, p256dh: p256dh as string, auth: auth as string, machine };
}

/** RFC 8291 Web Push message encryption in one aes128gcm record (RFC 8188). */
export function encryptPush(
  payload: Uint8Array,
  target: Pick<PushTarget, "p256dh" | "auth">,
  { salt = randomBytes(16), privateKey }: { salt?: Buffer; privateKey?: Buffer } = {},
): Buffer {
  const userAgentKey = Buffer.from(target.p256dh, "base64url");
  const authSecret = Buffer.from(target.auth, "base64url");
  const ecdh = createECDH("prime256v1");
  if (privateKey) ecdh.setPrivateKey(privateKey);
  else ecdh.generateKeys();
  const serverKey = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(userAgentKey);
  const hkdf = (key: Buffer, salt: Buffer, info: Buffer, length: number) =>
    Buffer.from(hkdfSync("sha256", key, salt, info, length));
  const ikm = hkdf(secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), userAgentKey, serverKey]), 32);
  const key = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  // One record: the payload, then the 0x02 delimiter that marks the last record, with no padding.
  // UnifiedPush caps the whole body, header included, at 4096 bytes.
  if (21 + serverKey.length + payload.length + 1 + 16 > RECORD_SIZE) throw new Error("push payload is too large");
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(payload), cipher.update(Buffer.from([2])), cipher.final()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverKey.length, 20);
  return Buffer.concat([header, serverKey, sealed, cipher.getAuthTag()]);
}

const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length - 1)}…` : value);

/**
 * Posts `alert` to `target`. Resolves to "gone" when the endpoint answers 404 or 410, so the caller
 * drops that registration, and never rejects: a push failure must not reach the server.
 */
export async function sendPush(
  target: PushTarget,
  alert: PushAlert,
  send: typeof fetch = fetch,
  timeout = 10_000,
): Promise<"sent" | "gone" | "failed"> {
  try {
    const body = encryptPush(
      Buffer.from(JSON.stringify({ ...alert, title: clip(alert.title, 200), cwd: clip(alert.cwd, 300) })),
      target,
    );
    const response = await send(target.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
      headers: {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "3600",
        Urgency: "high",
      },
      body,
    });
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) return "gone";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
