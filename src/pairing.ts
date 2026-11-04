import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PushTarget } from "./push";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const statePath = () => join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "devices.sqlite");
export type Device = { id: string; name: string; createdAt: number };

export class Pairing {
  private db: Database;
  constructor(path = statePath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT UNIQUE NOT NULL, createdAt INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS invitations (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS push (device TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL);",
    );
  }
  invite(now = Date.now()): string {
    const code = secret();
    this.db
      .transaction(() => {
        this.db.query("DELETE FROM invitations WHERE expires <= ?").run(now);
        this.db.query("INSERT INTO invitations VALUES (?, ?)").run(hash(code), now + 300_000);
      })
      .immediate();
    return code;
  }
  exchange(code: string, name: string, now = Date.now()): { device: Device; token: string } | undefined {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(code) ||
      !name.trim() ||
      name.length > 64 ||
      [...name].some((character) => character.charCodeAt(0) < 32)
    )
      return undefined;
    return this.db
      .transaction(() => {
        const invitation = this.db
          .query<{ expires: number }, [string]>("SELECT expires FROM invitations WHERE digest = ?")
          .get(hash(code));
        if (!invitation || invitation.expires <= now) return undefined;
        this.db.query("DELETE FROM invitations WHERE digest = ?").run(hash(code));
        const token = secret();
        const device = { id: randomBytes(12).toString("hex"), name: name.trim(), createdAt: now };
        this.db.query("INSERT INTO devices VALUES (?, ?, ?, ?)").run(device.id, device.name, hash(token), now);
        return { device, token };
      })
      .immediate();
  }
  authenticate(token: string): Device | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.db.query<Device, [string]>("SELECT id, name, createdAt FROM devices WHERE digest = ?").get(hash(token));
  }
  devices(): Device[] {
    return this.db.query<Device, []>("SELECT id, name, createdAt FROM devices ORDER BY createdAt").all();
  }
  revoke(id: string): boolean {
    return this.db
      .transaction(() => {
        this.db.query("DELETE FROM push WHERE device = ?").run(id);
        return this.db.query("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
      })
      .immediate();
  }
  /** One UnifiedPush registration per paired device; a new one replaces the last. */
  setPush(device: string, target: PushTarget) {
    this.db
      .query("INSERT OR REPLACE INTO push SELECT id, ?, ?, ? FROM devices WHERE id = ?")
      .run(target.endpoint, target.p256dh, target.auth, device);
  }
  /** Removes `device`'s registration, or only the given endpoint when it is still the current one. */
  deletePush(device: string, endpoint?: string) {
    if (endpoint === undefined) this.db.query("DELETE FROM push WHERE device = ?").run(device);
    else this.db.query("DELETE FROM push WHERE device = ? AND endpoint = ?").run(device, endpoint);
  }
  pushTargets(): (PushTarget & { device: string })[] {
    return this.db
      .query<PushTarget & { device: string }, []>(
        "SELECT push.device, endpoint, p256dh, auth FROM push JOIN devices ON devices.id = push.device",
      )
      .all();
  }
  close() {
    this.db.close();
  }
}

export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("server URL must be an HTTPS origin without a path");
  return url.origin;
}
