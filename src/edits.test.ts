import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeLedger, parseUnified, scanEdits, turnSummaries } from "./edits";

const scratch = mkdtempSync(join(tmpdir(), "kiln-edits-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const jsonl = (name: string, records: unknown[]) => {
  const path = join(scratch, name);
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return path;
};

describe("parseUnified", () => {
  test("reads each hunk by its header's counts", () => {
    const hunks = parseUnified(
      "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n\n@@ -9 +9,2 @@\n z\n+y\n\\ No newline at end of file\n",
    );
    expect(hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " "] },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 2, lines: [" z", "+y"] },
    ]);
  });
});

describe("scanEdits", () => {
  test("Claude: typed prompts start turns, edit results carry hunks and created files", () => {
    const path = jsonl("claude.jsonl", [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00Z",
        promptSource: "typed",
        message: { content: "add a cache" },
      },
      {
        type: "user",
        uuid: "r1",
        timestamp: "2026-01-01T00:01:00Z",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        toolUseResult: {
          type: "update",
          filePath: "/repo/a.ts",
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" a", "+b"] }],
        },
      },
      {
        type: "user",
        uuid: "r2",
        message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
        toolUseResult: { type: "create", filePath: "/repo/new.ts", content: "x\ny\n", structuredPatch: [] },
      },
    ]);
    const { ledger } = scanEdits(path, "claude");
    expect(ledger.turns.map((turn) => turn.prompt)).toEqual(["add a cache"]);
    expect(ledger.edits.map((edit) => [edit.file, edit.change, edit.turn])).toEqual([
      ["/repo/a.ts", "update", 0],
      ["/repo/new.ts", "create", 0],
    ]);
    expect(ledger.edits[1]?.hunks[0]?.lines).toEqual(["+x", "+y"]);
  });

  test("reads only what was appended, and a line still being written waits", () => {
    const path = jsonl("growing.jsonl", [
      { type: "user", uuid: "u1", promptSource: "typed", message: { content: "first" } },
    ]);
    const scan = scanEdits(path, "claude");
    appendFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u2", promptSource: "typed", message: { content: "second" } })}`,
    );
    expect(scanEdits(path, "claude", scan).ledger.turns).toHaveLength(1);
    appendFileSync(path, "\n");
    expect(scanEdits(path, "claude", scan).ledger.turns.map((turn) => turn.prompt)).toEqual(["first", "second"]);
  });

  test("Codex: FileChange events carry each file's diff, adds and deletes", () => {
    const path = jsonl("codex.jsonl", [
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "fix it" }] },
      },
      {
        type: "event_msg",
        timestamp: "2026-01-01T00:01:00Z",
        payload: {
          type: "item_completed",
          turn_id: "t",
          item: {
            type: "FileChange",
            id: "exec-1",
            changes: {
              "/repo/a.ts": { type: "update", unified_diff: "@@ -2,1 +2,2 @@\n b\n+c\n" },
              "/repo/b.ts": { type: "add", content: "new\n" },
              "/repo/c.ts": { type: "delete" },
              "relative.ts": { type: "add", content: "skipped\n" },
            },
          },
        },
      },
    ]);
    const { ledger } = scanEdits(path, "codex");
    expect(ledger.turns.map((turn) => turn.prompt)).toEqual(["fix it"]);
    expect(ledger.edits.map((edit) => [edit.file, edit.change])).toEqual([
      ["/repo/a.ts", "update"],
      ["/repo/b.ts", "create"],
      ["/repo/c.ts", "delete"],
    ]);
  });

  test("Pi: edit results carry a patch; a write counts only once it succeeds", () => {
    const path = jsonl("pi.jsonl", [
      { type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      {
        type: "message",
        id: "2",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "w1", name: "write", arguments: { path: "/repo/w.ts", content: "a\n" } },
            { type: "toolCall", id: "w2", name: "write", arguments: { path: "/repo/failed.ts", content: "a\n" } },
          ],
        },
      },
      { type: "message", id: "3", message: { role: "toolResult", toolCallId: "w1", toolName: "write", content: [] } },
      {
        type: "message",
        id: "4",
        message: { role: "toolResult", toolCallId: "w2", toolName: "write", isError: true, content: [] },
      },
      {
        type: "message",
        id: "5",
        message: {
          role: "toolResult",
          toolCallId: "e1",
          toolName: "edit",
          content: [],
          details: { patch: "--- /repo/e.ts\n+++ /repo/e.ts\n@@ -1 +1 @@\n-x\n+y\n" },
        },
      },
    ]);
    const { ledger } = scanEdits(path, "pi");
    expect(ledger.edits.map((edit) => [edit.file, edit.change])).toEqual([
      ["/repo/w.ts", "write"],
      ["/repo/e.ts", "update"],
    ]);
  });
});

test("OpenCode: completed tool parts carry patches relative to the session directory", () => {
  const path = join(scratch, "opencode.db");
  const db = new Database(path);
  db.run("CREATE TABLE session_message (seq INTEGER, id TEXT, session_id TEXT, type TEXT, data TEXT)");
  const insert = db.query("INSERT INTO session_message VALUES (?, ?, 's', ?, ?)");
  insert.run(1, "m1", "user", JSON.stringify({ text: "edit please", time: { created: 1 } }));
  insert.run(
    2,
    "m2",
    "assistant",
    JSON.stringify({
      time: { created: 2, completed: 3 },
      content: [
        {
          type: "tool",
          id: "p1",
          name: "edit",
          state: {
            status: "completed",
            metadata: { files: [{ file: "src/a.ts", patch: "@@ -1 +1,2 @@\n a\n+b\n", status: "modified" }] },
          },
        },
        {
          type: "tool",
          id: "p2",
          name: "write",
          state: { status: "completed", input: { filePath: "/repo/w.ts", content: "w\n" } },
        },
      ],
    }),
  );
  insert.run(3, "m3", "assistant", JSON.stringify({ time: { created: 4 }, content: [] }));
  db.close();
  const first = opencodeLedger(path, "s", "/repo");
  expect(first.seq).toBe(2);
  expect(first.ledger.edits.map((edit) => [edit.file, edit.change, edit.turn])).toEqual([
    ["/repo/src/a.ts", "update", 0],
    ["/repo/w.ts", "write", 0],
  ]);
});

test("turnSummaries counts each turn's files and lines, newest turn first", () => {
  const summaries = turnSummaries({
    turns: [{ prompt: "one" }, { prompt: "two" }],
    edits: [
      {
        id: "a",
        file: "/x",
        change: "update",
        turn: 0,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
      },
      {
        id: "b",
        file: "/y",
        change: "create",
        turn: 1,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+1", "+2"] }],
      },
      {
        id: "c",
        file: "/y",
        change: "update",
        turn: 1,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-1", "+3"] }],
      },
    ],
  });
  expect(summaries.map((turn) => [turn.prompt, turn.added, turn.removed])).toEqual([
    ["two", 3, 1],
    ["one", 1, 1],
  ]);
  expect(summaries[0]?.files).toEqual([{ file: "/y", added: 3, removed: 1, created: true, deleted: false, edits: 2 }]);
});
