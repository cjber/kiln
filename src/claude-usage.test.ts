import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeNeedsLogin, claudeSignedIn, claudeUsage, forgetClaudeUsage } from "./claude-usage";

const now = Date.parse("2026-11-19T23:15:00Z");
const body = await Bun.file(join(import.meta.dir, "fixtures", "quota", "claude", "usage.json")).text();

function login(expiresAt = now + 3_600_000, refreshToken?: string) {
  const dir = mkdtempSync(join(tmpdir(), "kiln-claude-usage-"));
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt, refreshToken } }),
  );
  return { home, state: join(dir, "state") };
}

function provider(status = 200) {
  const asked: Headers[] = [];
  const request = (async (_url: unknown, init?: RequestInit) => {
    asked.push(new Headers(init?.headers));
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { asked, request };
}

test("one request per login is shared for five minutes, then asked again", async () => {
  // Another test file's forced refresh, at the real time, would make every read here a stale one.
  forgetClaudeUsage(0);
  const { home, state } = login();
  const { asked, request } = provider();
  const first = await claudeUsage(now, home, state, request);
  expect(first?.windows.map((w) => [w.label, w.percent])).toEqual([
    ["5h", 50],
    ["wk", 38],
  ]);
  expect(first?.fetchedAt).toBe(now);
  expect(asked[0]?.get("authorization")).toBe("Bearer token");
  expect(await claudeUsage(now + 60_000, home, state, request)).toEqual(first);
  expect(asked).toHaveLength(1);
  expect((await claudeUsage(now + 6 * 60_000, home, state, request))?.fetchedAt).toBe(now + 6 * 60_000);
  // A forced refresh asks again inside the five minutes.
  forgetClaudeUsage(now + 7 * 60_000);
  await claudeUsage(now + 7 * 60_000, home, state, request);
  expect(asked).toHaveLength(3);
});

test("a refused request or an expired token keeps the last good read, with its age", async () => {
  const { home, state } = login();
  const good = await claudeUsage(now, home, state, provider().request);
  const later = now + 10 * 60_000;
  expect(await claudeUsage(later, home, state, provider(429).request)).toEqual(good);
  const expired = login(now - 1);
  const { asked, request } = provider();
  expect(await claudeUsage(now, expired.home, expired.state, request)).toBeUndefined();
  expect(asked).toHaveLength(0);
});

test("a config dir with no login file is signed out", () => {
  const { home } = login();
  expect(claudeSignedIn(home)).toBe(true);
  if (process.platform !== "darwin") expect(claudeSignedIn(join(home, "absent"))).toBe(false);
});

test("an expired token is Claude Code's to renew, asked at most every half hour, and a refusal means sign in again", async () => {
  const { home, state } = login(now - 1, "refresh");
  const { asked, request } = provider();
  const answers: (boolean | undefined)[] = [undefined, false];
  const homes: string[] = [];
  const renew = async (asking: string) => {
    homes.push(asking);
    return answers.shift();
  };
  expect(await claudeUsage(now, home, state, request, renew)).toBeUndefined();
  await Bun.sleep(0);
  // Claude Code gave no answer, so the login is still one it may renew.
  expect(claudeNeedsLogin(now, home, state)).toBe(false);
  await claudeUsage(now + 10 * 60_000, home, state, request, renew);
  expect(homes).toEqual([home]);
  await claudeUsage(now + 31 * 60_000, home, state, request, renew);
  await Bun.sleep(0);
  expect(homes).toEqual([home, home]);
  expect(claudeNeedsLogin(now + 31 * 60_000, home, state)).toBe(true);
  expect(asked).toHaveLength(0);
  // Signing in again writes a live token, and the login is usable whatever was recorded before.
  writeFileSync(
    join(home, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "token", expiresAt: now + 2 * 3_600_000, refreshToken: "refresh" },
    }),
  );
  expect(claudeNeedsLogin(now + 32 * 60_000, home, state)).toBe(false);
  expect((await claudeUsage(now + 32 * 60_000, home, state, request, renew))?.fetchedAt).toBe(now + 32 * 60_000);
});

test("credentials with nothing to renew from need a login without asking Claude Code", async () => {
  const dead = login(0);
  const renew = async () => {
    throw new Error("not asked");
  };
  expect(await claudeUsage(now, dead.home, dead.state, provider().request, renew)).toBeUndefined();
  expect(claudeNeedsLogin(now, dead.home, dead.state)).toBe(true);
  expect(claudeNeedsLogin(now, join(dead.home, "absent"), dead.state)).toBe(false);
});

test("a usage 401 is treated as an expired token and a failed renewal needs login", async () => {
  const { home, state } = login();
  const renew = async () => false;
  const good = await claudeUsage(now - 6 * 60_000, home, state, provider().request, renew);

  expect(await claudeUsage(now, home, state, provider(401).request, renew)).toEqual(good);
  await Bun.sleep(0);
  expect(claudeNeedsLogin(now, home, state)).toBe(true);
});
