import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeBridgeLink, phoneHandoff } from "./phone-links";
import type { Session } from "./sessions";

test("native handoffs require exact provider identities", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-links-"));
  const session: Session = {
    agent: "claude",
    id: "local",
    pid: 123,
    cwd: "/repo",
    startedAt: 1,
    place: { kind: "kiln", name: "claude" },
  };
  try {
    mkdirSync(join(root, "sessions"));
    const record = join(root, "sessions", "123.json");
    writeFileSync(record, JSON.stringify({ pid: 123, sessionId: "local", bridgeSessionId: "session_example" }));
    expect(claudeBridgeLink(session, root)).toBe("https://claude.ai/code/session_example");
    writeFileSync(record, JSON.stringify({ pid: 124, sessionId: "local", bridgeSessionId: "session_example" }));
    expect(claudeBridgeLink(session, root)).toBeUndefined();
    writeFileSync(
      record,
      JSON.stringify({ pid: 123, sessionId: "local", bridgeSessionId: "../../private?token=secret" }),
    );
    expect(claudeBridgeLink(session, root)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const codex: Session = { ...session, agent: "codex", id: "00000000-0000-0000-0000-000000000001" };
  expect(phoneHandoff(codex, "slingshot:env_example:8765")).toEqual({
    url: "https://chatgpt.com/codex/remote/thread/00000000-0000-0000-0000-000000000001?hostId=slingshot%3Aenv_example%3A8765",
    label: "Open in ChatGPT",
    exact: true,
  });
  expect(phoneHandoff(codex, "slingshot:env_bad&token=secret:8765")).toMatchObject({
    exact: false,
    url: "https://chatgpt.com/codex",
  });
  expect(phoneHandoff({ ...session, agent: "pi" })).toEqual({ reason: "Open this Pi session in kiln on your PC" });
});

test("an OpenCode session opens in the web UI only when the service holds it", () => {
  const served: Session = {
    agent: "opencode",
    id: "ses_abc",
    cwd: "/repo",
    startedAt: 1,
    opencodeService: true,
    place: { kind: "thread", id: "ses_abc", attach: ["opencode", "--session", "ses_abc"] },
  };
  const origin = "https://machine.example.ts.net:4096";
  expect(phoneHandoff(served, undefined, origin)).toEqual({
    url: `${origin}/server/aHR0cHM6Ly9tYWNoaW5lLmV4YW1wbGUudHMubmV0OjQwOTY/session/ses_abc`,
    label: "Open in OpenCode",
    exact: true,
  });
  expect(phoneHandoff(served)).toEqual({ reason: "Run kiln setup to open OpenCode sessions on your phone" });
  expect(phoneHandoff({ ...served, opencodeService: false }, undefined, origin)).toEqual({
    reason: "Open this OpenCode session in kiln on your PC",
  });
  expect(phoneHandoff({ ...served, id: "ses_../x" }, undefined, origin)).not.toHaveProperty("url");
});
