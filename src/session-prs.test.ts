import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTranscript } from "./session-prs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const transcript = (...records: object[]) => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-session-prs-"));
  directories.push(directory);
  const path = join(directory, "t.jsonl");
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return path;
};
const claudeCall = (id: string, command: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command, description: "Open the PR" } }] },
});
const claudeResult = (id: string, text: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
});

test("a Claude session's opened pull requests come from its gh pr create results, not every URL it mentions", () => {
  const path = transcript(
    claudeCall("a", "gh search prs --author @me"),
    claudeResult("a", "https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2"),
    claudeCall("g", "grep 'gh pr create' transcript.jsonl"),
    claudeResult("g", "https://github.com/o/r/pull/8"),
    claudeCall("b", 'git push && gh pr create --title "x" --body "Refs https://github.com/o/r/pull/1"'),
    claudeResult("b", "https://github.com/o/r/pull/3"),
  );
  expect(scanTranscript(path).urls).toEqual(["https://github.com/o/r/pull/3"]);
});

test("a scan resumes where it stopped and skips a line still being written", () => {
  const path = transcript(claudeCall("b", "gh pr create --fill"));
  const first = scanTranscript(path);
  appendFileSync(path, JSON.stringify(claudeResult("b", "https://github.com/o/r/pull/9")).slice(0, 20));
  expect(scanTranscript(path, first).urls).toEqual([]);
  appendFileSync(path, `${JSON.stringify(claudeResult("b", "https://github.com/o/r/pull/9")).slice(20)}\n`);
  expect(scanTranscript(path, first).urls).toEqual(["https://github.com/o/r/pull/9"]);
});

test("Codex and Pi records name their opened pull requests too", () => {
  const codex = transcript(
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          command: ["/usr/bin/zsh", "-lc", "gh pr create --base main"],
          aggregated_output: "https://github.com/o/r/pull/4\n",
        },
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call", call_id: "c1", arguments: JSON.stringify({ cmd: "gh pr create --fill" }) },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1", output: "https://github.com/o/r/pull/5" },
    },
  );
  expect(scanTranscript(codex).urls).toEqual(["https://github.com/o/r/pull/4", "https://github.com/o/r/pull/5"]);
  const pi = transcript(
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "p1", arguments: { command: "gh pr create" } }] },
    },
    { type: "message", message: { role: "toolResult", toolCallId: "p1", content: "https://github.com/o/r/pull/6" } },
  );
  expect(scanTranscript(pi).urls).toEqual(["https://github.com/o/r/pull/6"]);
});
