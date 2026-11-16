/** Isolated subprocess for CLI fast-path tests, so module mocks cannot leak into other suites. */
import { mock } from "bun:test";
import { post } from "../src/mailbox";
import * as sessions from "../src/sessions";

mock.module("../src/sessions", () => ({
  ...sessions,
  discovery: () => async () => {
    throw new Error("mailbox-only command must not discover sessions");
  },
}));
const { runMsgCli } = await import("../src/msg-cli");
post("@sender", "@reader", "reply");
await runMsgCli(["inbox", "--as", "@reader", "--json"]);
await runMsgCli(["send", "@receiver", "ping", "--as", "@sender", "--json"]);
