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
