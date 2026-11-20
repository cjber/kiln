import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeSignedIn, claudeUsage, forgetClaudeUsage } from "./claude-usage";

const now = Date.parse("2026-11-19T23:15:00Z");
const body = await Bun.file(join(import.meta.dir, "fixtures", "quota", "claude", "usage.json")).text();

function login(expiresAt = now + 3_600_000) {
  const dir = mkdtempSync(join(tmpdir(), "kiln-claude-usage-"));
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt } }),
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
