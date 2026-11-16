/** Isolated subprocess for CLI fast-path tests, so module mocks cannot leak into other suites. */
import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { post } from "../src/mailbox";
import * as sessions from "../src/sessions";

const fixture = {
  id: "fixture-session",
  agent: "claude" as const,
  cwd: "/fixture",
  startedAt: 1,
  place: { kind: "kiln" as const, name: "fixture" },
};
mkdirSync(join(Bun.env.CLAUDE_CONFIG_DIR ?? ".", "projects", "-fixture"), { recursive: true });
writeFileSync(
  join(Bun.env.CLAUDE_CONFIG_DIR ?? ".", "projects", "-fixture", "fixture-session.jsonl"),
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
mock.module("../src/sessions", () => ({
  ...sessions,
  discovery: () => async () => {
    return { sessions: [fixture] };
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
await runMsgCli(["view", "claude:fixture-session"]);
await runMsgCli(["send", "@receiver", "ping", "--as", "@sender", "--json"]);
