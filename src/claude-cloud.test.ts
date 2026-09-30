import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCloudToken, loadClaudeCloud, parseClaudeCloudPage } from "./claude-cloud";

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
  const states = [
    "working",
    "waiting",
    "idle",
    "completed",
    "archived",
    "cancelled",
    "rejected",
    "WORKER_STATUS_UNSPECIFIED",
    "new",
  ];
  expect(
    parseClaudeCloudPage(page(states.map((worker_status) => ({ ...session, worker_status })))).sessions.map(
      (s) => s.activity,
    ),
  ).toEqual(["working", "waiting", "idle", "idle", "idle", "idle", "waiting", undefined, undefined]);
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
  try {
    claudeCloudToken('test-value "invalid');
  } catch (error) {
    expect(String(error)).toContain("credentials file is invalid");
    expect(String(error)).not.toContain("test-value");
  }
});

test("Claude listing follows and validates cursors, deduplicates rows and reports HTTP errors without response bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-claude-cloud-test-"));
  const previousFetch = globalThis.fetch;
  const previousConfig = Bun.env.CLAUDE_CONFIG_DIR;
  const previousPath = Bun.env.PATH;
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(root, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-value", expiresAt: Date.now() + 60_000 } }),
    { mode: 0o600 },
  );
  Bun.env.CLAUDE_CONFIG_DIR = root;
  Bun.env.PATH = `${join(root, "bin")}:${previousPath}`;
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
    globalThis.fetch = previousFetch;
    if (previousConfig === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
    else Bun.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
