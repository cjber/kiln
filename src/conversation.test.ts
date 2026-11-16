import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexItems,
  endedConversationReader,
  piItems,
  readConversation,
  readOpencodeConversation,
  recordItems,
} from "./conversation";

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
          { type: "input_text", text: '{"chunk_id":"a1","exit_code":1,"output":"\\u001b[31mno such file\\u001b[0m"}' },
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

test("a session that has ended is read by its full name from the transcript its provider kept", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-ended-"));
  directories.push(root);
  const names = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "XDG_DATA_HOME"] as const;
  const previous = names.map((name) => Bun.env[name]);
  for (const name of names) Bun.env[name] = join(root, name);
  const write = (path: string, lines: unknown[]) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  };
  try {
    const thread = "01a1e472-9ee5-7952-ad4b-21153573da40";
    write(join(root, "CODEX_HOME", "sessions", "2026", "11", "16", `rollout-2026-11-16T13-01-19-${thread}.jsonl`), [
      { type: "session_meta", payload: { id: thread } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Say hello and stop." }] },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] },
      },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Hello!" } },
    ]);
    expect(
      endedConversationReader(`codex:${thread}`)?.().items.map((item) => item.kind === "agent" && item.text),
    ).toContain("Hello!");

    // A Claude child's transcript is filed under its directory, which the name does not carry.
    const claude = "5f0c1d7e-0000-4000-8000-000000000001";
    write(join(root, "CLAUDE_CONFIG_DIR", "projects", "-work-repo", `${claude}.jsonl`), [
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "claude answer" }] } },
    ]);
    expect(endedConversationReader(`claude:${claude}`)?.().items).toEqual([
      { id: "a1:0", at: undefined, kind: "agent", text: "claude answer" },
    ]);

    const pi = "5f0c1d7e-0000-4000-8000-000000000002";
    write(join(root, "PI_CODING_AGENT_DIR", "sessions", "--work-repo--", `2026-11-16_${pi}.jsonl`), [
      { type: "message", id: "p1", message: { role: "assistant", content: [{ type: "text", text: "pi answer" }] } },
    ]);
    expect(endedConversationReader(`pi:${pi}`)?.().items.at(-1)).toMatchObject({ kind: "agent", text: "pi answer" });

    mkdirSync(join(root, "XDG_DATA_HOME", "opencode"), { recursive: true });
    const db = new Database(join(root, "XDG_DATA_HOME", "opencode", "opencode.db"));
    db.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)");
    db.run("INSERT INTO session_message VALUES ('m1', 'ses_done', 'assistant', 1, ?)", [
      JSON.stringify({ time: { created: 1, completed: 2 }, content: [{ type: "text", text: "opencode answer" }] }),
    ]);
    db.close();
    expect(endedConversationReader("opencode:ses_done")?.().items.at(-1)).toMatchObject({ text: "opencode answer" });

    // Only a full provider id names a transcript: not a missing one, a process name or a prefix.
    for (const name of [
      "codex:01a1e472-0000-0000-0000-000000000000",
      "codex:351399:1794834079045.629",
      "codex:01a1e472",
      "opencode:ses_other",
      "nobody:x",
      "codex:",
    ])
      expect(endedConversationReader(name)).toBeUndefined();
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete Bun.env[name];
      else Bun.env[name] = value;
    });
  }
});
