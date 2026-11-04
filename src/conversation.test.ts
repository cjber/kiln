import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexItems, piItems, readConversation, readOpencodeConversation, recordItems } from "./conversation";

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

test("Codex and Pi records map to the same items, without Codex's injected context", () => {
  const response = (payload: unknown) => ({ type: "response_item", timestamp: "2026-11-04T10:00:00Z", payload });
  expect(
    [
      response({
        type: "message",
        role: "user",
        id: "m0",
        content: [{ type: "input_text", text: "<environment_context>" }],
      }),
      response({ type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "fix it" }] }),
      response({ type: "function_call", name: "shell", call_id: "c1", arguments: '{"command":"ls"}' }),
      response({
        type: "custom_tool_call",
        name: "exec",
        call_id: "c2",
        input: 'tools.exec_command({cmd:"bun test"})',
      }),
      response({ type: "custom_tool_call", name: "exec", call_id: "c3", input: "*** Update File: src/a.ts\n" }),
      response({
        type: "custom_tool_call_output",
        id: "o2",
        call_id: "c2",
        output: [{ type: "input_text", text: "Script completed\nWall time 1s\nOutput:\n3 pass" }],
      }),
      response({
        type: "custom_tool_call_output",
        id: "o3",
        call_id: "c3",
        output: [
          { type: "input_text", text: "Script completed\nWall time 1s\nOutput:\n" },
          { type: "input_text", text: "{}" },
          { type: "input_text", text: '{"chunk_id":"a1","exit_code":1,"output":"no such file"}' },
        ],
      }),
      response({ type: "message", role: "assistant", id: "m2", content: [{ type: "output_text", text: "Done." }] }),
    ]
      .flatMap(codexItems)
      .map((item) => [item.kind, "tool" in item ? item.tool : "", item.text]),
  ).toEqual([
    ["you", "", "fix it"],
    ["tool", "shell", "ls"],
    ["tool", "exec", "bun test"],
    ["tool", "exec", "Edit src/a.ts"],
    ["result", "", "3 pass"],
    ["result", "", "no such file"],
    ["agent", "", "Done."],
  ]);
  const pi = (message: unknown) => ({ type: "message", id: "p", timestamp: "2026-11-04T10:00:00Z", message });
  expect(
    [
      pi({ role: "user", content: [{ type: "text", text: "hi" }] }),
      pi({
        role: "assistant",
        content: [{ type: "thinking" }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }],
      }),
      pi({ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "nope" }], isError: true }),
    ].flatMap(piItems),
  ).toMatchObject([
    { kind: "you", text: "hi" },
    { kind: "tool", tool: "read", text: "a.ts" },
    { kind: "result", of: "t1", text: "nope", error: true },
  ]);
});

test("an OpenCode session reads from its database and waits for a message still being written", () => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-opencode-"));
  const path = join(directory, "opencode.db");
  const db = new Database(path);
  db.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)");
  const add = (seq: number, type: string, data: unknown) =>
    db.run("INSERT INTO session_message VALUES (?, 'ses_a', ?, ?, ?)", [`m${seq}`, type, seq, JSON.stringify(data)]);
  try {
    add(1, "user", { time: { created: 1 }, text: "look" });
    add(2, "assistant", {
      time: { created: 2, completed: 3 },
      content: [
        { type: "reasoning", text: "hmm" },
        {
          type: "tool",
          id: "t1",
          name: "shell",
          state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a.ts" }] },
        },
        {
          type: "tool",
          id: "t2",
          name: "read",
          state: { status: "error", input: { path: "b" }, error: { message: "missing" } },
        },
        { type: "text", text: "Found a.ts" },
      ],
    });
    add(3, "assistant", { time: { created: 4 }, content: [{ type: "text", text: "partial" }] });
    const first = readOpencodeConversation(path, "ses_a");
    expect(first.items.map((item) => [item.kind, item.text])).toEqual([
      ["you", "look"],
      ["tool", "ls"],
      ["result", "a.ts"],
      ["tool", "b"],
      ["result", "missing"],
      ["agent", "Found a.ts"],
    ]);
    expect(first).toMatchObject({ cursor: "2", reset: true });
    db.run("UPDATE session_message SET data = ? WHERE seq = 3", [
      JSON.stringify({ time: { created: 4, completed: 5 }, content: [{ type: "text", text: "whole" }] }),
    ]);
    expect(readOpencodeConversation(path, "ses_a", first.cursor)).toMatchObject({
      items: [{ kind: "agent", text: "whole" }],
      cursor: "3",
      reset: false,
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
