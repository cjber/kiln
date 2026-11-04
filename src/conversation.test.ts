import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConversation, recordItems } from "./conversation";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function transcript(lines: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), "kiln-conversation-test-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return path;
}

const typed = (uuid: string, text: string) => ({
  type: "user",
  uuid,
  timestamp: "2026-11-04T12:00:00.000Z",
  origin: { kind: "human" },
  message: { content: text },
});

test("records become prompts, replies, tool calls and their results", () => {
  expect(recordItems(typed("u1", " fix the build "))).toEqual([
    { id: "u1", at: Date.parse("2026-11-04T12:00:00.000Z"), kind: "you", text: "fix the build" },
  ]);
  expect(
    recordItems({
      type: "assistant",
      uuid: "a1",
      message: {
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "Running it" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test", description: "Run tests" } },
        ],
      },
    }),
  ).toEqual([
    { id: "a1:1", at: undefined, kind: "agent", text: "Running it" },
    { id: "t1", at: undefined, kind: "tool", tool: "Bash", text: "Run tests" },
  ]);
  const [result] = recordItems({
    type: "user",
    uuid: "r1",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "1\n2\n3\n4\n5\n6\n7\n8" }],
    },
  });
  expect(result).toEqual({
    id: "r1:0",
    at: undefined,
    kind: "result",
    of: "t1",
    text: "1\n2\n3\n4\n5\n6\n…",
    error: true,
  });
});

test("injected prompts are notices, and meta and sidechain records are left out", () => {
  expect(
    recordItems({
      type: "user",
      uuid: "n1",
      origin: { kind: "task-notification" },
      message: { content: "<task-notification>done</task-notification>" },
    })[0]?.kind,
  ).toBe("notice");
  expect(recordItems({ type: "user", uuid: "m1", isMeta: true, message: { content: "caveat" } })).toEqual([]);
  expect(recordItems({ ...typed("s1", "helper"), isSidechain: true })).toEqual([]);
  expect(recordItems({ type: "ai-title", aiTitle: "x" })).toEqual([]);
});

test("a cursor resumes after complete lines only, and a replaced file resets", () => {
  const path = transcript([typed("u1", "one"), typed("u2", "two")]);
  const first = readConversation(path);
  expect(first.reset).toBe(true);
  expect(first.items.map((item) => item.text)).toEqual(["one", "two"]);
  expect(readConversation(path, first.cursor).items).toEqual([]);
  // A line still being written waits for its newline.
  appendFileSync(path, JSON.stringify(typed("u3", "three")).slice(0, 20));
  const partial = readConversation(path, first.cursor);
  expect(partial.items).toEqual([]);
  expect(partial.cursor).toBe(first.cursor);
  appendFileSync(path, `${JSON.stringify(typed("u3", "three")).slice(20)}\n`);
  const next = readConversation(path, partial.cursor);
  expect(next.reset).toBe(false);
  expect(next.items.map((item) => item.text)).toEqual(["three"]);
  expect(readConversation(path, "1:0").reset).toBe(true);
  expect(readConversation(path, `${next.cursor.split(":")[0]}:999999`).reset).toBe(true);
  expect(readConversation(path, undefined, 1).items.map((item) => item.text)).toEqual(["three"]);
});
