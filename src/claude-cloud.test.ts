import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCloudSnapshot, claudeCloudToken, loadClaudeCloud, parseClaudeCloudPage } from "./claude-cloud";
import type { Session } from "./sessions";

const session = {
  id: "cse_example",
  title: "Update search",
  status: "active",
  worker_status: "idle",
  environment_kind: "anthropic_cloud",
  created_at: "2026-09-30T09:00:00Z",
};
const page = (data: unknown[], next_cursor: string | null = null) => JSON.stringify({ data, next_cursor });

test("Claude cloud maps current states, leaves unknown ones unknown, and excludes archived, pooled and bridge sessions", () => {
  const states = ["running", "requires_action", "idle", "working", "WORKER_STATUS_UNSPECIFIED"];
  expect(
    parseClaudeCloudPage(page(states.map((worker_status) => ({ ...session, worker_status })))).sessions.map(
      (s) => s.activity,
    ),
  ).toEqual(["working", "waiting", "idle", undefined, undefined]);
  expect(
    parseClaudeCloudPage(
      page([
        { ...session, status: "archived" },
        { ...session, environment_kind: "bridge" },
        { ...session, title: "__warming__" },
      ]),
    ).sessions,
  ).toEqual([]);
  expect(() => parseClaudeCloudPage(page([{ ...session, id: "../../outside" }]))).toThrow("invalid session");
  expect(() => parseClaudeCloudPage("{}")).toThrow("invalid session page");
  expect(parseClaudeCloudPage(JSON.stringify({ data: [session] })).cursor).toBeNull();
});

test("credential faults never reveal the token or invalid source", () => {
  expect(claudeCloudToken("{}", 0)).toBeUndefined();
  expect(claudeCloudToken(JSON.stringify({ claudeAiOauth: { accessToken: "test-value", expiresAt: 100 } }), 0)).toBe(
    "test-value",
  );
  expect(() =>
    claudeCloudToken(JSON.stringify({ claudeAiOauth: { accessToken: "test-value", expiresAt: 100 } }), 101),
  ).toThrow("credentials expired");
  const invalid = () => claudeCloudToken('test-value "invalid');
  expect(invalid).toThrow("credentials file is invalid");
  expect(invalid).not.toThrow("test-value");
});

test("Claude listing follows and validates cursors, deduplicates rows and reports HTTP errors without response bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-claude-cloud-test-"));
  const previousFetch = globalThis.fetch;
  const previousConfig = Bun.env.CLAUDE_CONFIG_DIR;
  const which = spyOn(Bun, "which").mockReturnValue("claude");
  writeFileSync(
    join(root, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-value", expiresAt: Date.now() + 60_000 } }),
    { mode: 0o600 },
  );
  Bun.env.CLAUDE_CONFIG_DIR = root;
  let calls = 0;
  try {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.anthropic.com");
      expect(options?.redirect).toBe("error");
      calls++;
      return new Response(calls === 1 ? page([session], "next") : page([session]));
    }) as unknown as typeof fetch;
    expect(await loadClaudeCloud()).toHaveLength(1);
    expect(calls).toBe(2);
    globalThis.fetch = (async () => new Response(page([session], "same"))) as unknown as typeof fetch;
    await expect(loadClaudeCloud()).rejects.toThrow("repeated a pagination cursor");
    globalThis.fetch = (async () => new Response("private response", { status: 401 })) as unknown as typeof fetch;
    await expect(loadClaudeCloud()).rejects.toThrow("HTTP 401");
  } finally {
    which.mockRestore();
    globalThis.fetch = previousFetch;
    if (previousConfig === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
    else Bun.env.CLAUDE_CONFIG_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("every Claude account's cloud sessions are listed under its name, once each, and a failing login keeps the rest", async () => {
  const row = (id: string): Session => ({
    agent: "claude",
    id,
    cwd: "cloud",
    title: id,
    startedAt: 0,
    place: { kind: "cloud", id, title: id },
  });
  const settings = {
    accounts: [
      { agent: "claude" as const, name: "work", home: "/srv/cloud-test/work" },
      { agent: "claude" as const, name: "old", home: "/srv/cloud-test/old", disabled: true },
      { agent: "claude" as const, name: "broken", home: "/srv/cloud-test/broken" },
    ],
  };
  const asked: string[] = [];
  const load = async (home: string) => {
    asked.push(home);
    if (home.endsWith("broken")) throw new Error("Claude cloud listing failed (HTTP 401)");
    return home.endsWith("work") ? [row("shared"), row("mine")] : [row("shared")];
  };
  claudeCloudSnapshot(settings, load);
  await Bun.sleep(0);
  const found = claudeCloudSnapshot(settings, load);
  expect(asked.filter((home) => home.startsWith("/srv/cloud-test")).sort()).toEqual([
    "/srv/cloud-test/broken",
    "/srv/cloud-test/work",
  ]);
  expect(found.sessions.map((session) => [session.id, session.account])).toEqual([
    ["shared", "default"],
    ["mine", "work"],
  ]);
  expect(found.problem).toBe("broken: Claude cloud listing failed (HTTP 401); cloud rows may be stale");
});
