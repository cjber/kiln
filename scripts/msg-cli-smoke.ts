/** Isolated subprocess for CLI fast-path tests, so module mocks cannot leak into other suites. */
import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { post } from "../src/mailbox";
import * as sessions from "../src/sessions";

const fixtureRoot = Bun.env.CLAUDE_CONFIG_DIR;
if (!fixtureRoot || !Bun.env.XDG_STATE_HOME)
  throw new Error("CLI smoke requires isolated CLAUDE_CONFIG_DIR and XDG_STATE_HOME");

const fixture = {
  id: "fixture-session",
  agent: "claude" as const,
  cwd: "/fixture",
  startedAt: 1,
  place: { kind: "kiln" as const, name: "fixture" },
};
mkdirSync(join(fixtureRoot, "projects", "-fixture"), { recursive: true });
writeFileSync(
  join(fixtureRoot, "projects", "-fixture", "fixture-session.jsonl"),
  `${JSON.stringify({ type: "user", uuid: "u1", message: { content: "fixture prompt" } })}\n${JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: {
      content: [
        { type: "text", text: "fixture answer" },
        { type: "tool_use", id: "tool1", name: "Read", input: { file_path: "notes.md" } },
      ],
    },
  })}\n`,
);
// A child that has ended is no longer discovered; its transcript is still on disk.
mkdirSync(join(fixtureRoot, "projects", "-elsewhere"), { recursive: true });
writeFileSync(
  join(fixtureRoot, "projects", "-elsewhere", "ended-session.jsonl"),
  `${JSON.stringify({ type: "assistant", uuid: "e1", message: { content: [{ type: "text", text: "ended answer" }] } })}\n`,
);
mock.module("../src/sessions", () => ({
  ...sessions,
  discovery: () => async () => {
    if (Bun.env.VIEW_ONLY === "1") return { sessions: [fixture] };
    throw new Error("mailbox-only command must not discover sessions");
  },
}));
const { runMsgCli } = await import("../src/msg-cli");
post("@sender", "@reader", "reply");
await runMsgCli(["inbox", "--as", "@reader", "--json"]);
let lateId = "";
setTimeout(() => {
  lateId = post("@sender", "@reader", "late").id;
}, 30);
await runMsgCli(["inbox", "--as", "@reader", "--peek", "--wait", "0.2", "--json"]);
await runMsgCli(["inbox", "--as", "@reader", "--peek", "--json"]);
if (!lateId) throw new Error("late message was not posted");
await runMsgCli(["ack", lateId, "--as", "@reader"]);
await runMsgCli(["inbox", "--as", "@reader", "--peek", "--wait", "0.02", "--json"]);
if (Bun.env.VIEW_ONLY === "1") {
  await runMsgCli(["view", "claude:fixture-session"]);
  await runMsgCli(["view", "claude:ended-session", "--json"]);
}
await runMsgCli(["send", "@receiver", "ping", "--as", "@sender", "--json"]);
