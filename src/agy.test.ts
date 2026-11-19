import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyActivity, agyTime, buildAgyProcesses, classifyAgy, readAgySummaries } from "./agy";

const id = "671610db-7d53-4eca-933c-eb227c076904";
const parent = "5daba879-99a5-4048-a2be-30a71c9a8942";

test("argv decides what an agy process is: print mode is headless, a subcommand is not a session", () => {
  expect(classifyAgy(["agy"])).toEqual({ kind: "interactive", conversationId: undefined });
  expect(classifyAgy(["agy", "--model", "m", "--conversation", id])).toEqual({
    kind: "interactive",
    conversationId: id,
  });
  expect(classifyAgy(["agy", `--conversation=${id}`]).kind).toBe("interactive");
  expect(classifyAgy(["agy", "-i", "go"]).kind).toBe("interactive");
  expect(classifyAgy(["agy", "-p", "work", "--model", "m"]).kind).toBe("exec");
  expect(classifyAgy(["agy", "--model", "m", "--print", "work"]).kind).toBe("exec");
  expect(classifyAgy(["agy", "acp"]).kind).toBe("other");
  expect(classifyAgy(["agy", "--add-dir", "/x", "models"]).kind).toBe("other");
  expect(classifyAgy(["node", "x"]).kind).toBe("other");
});

test("a run status maps onto activity, and an unknown one stays unknown", () => {
  expect(agyActivity("CASCADE_RUN_STATUS_IDLE")).toBe("idle");
  for (const busy of ["RUNNING", "BUSY", "CANCELING"])
    expect(agyActivity(`CASCADE_RUN_STATUS_${busy}`)).toBe("working");
  expect(agyActivity("CASCADE_RUN_STATUS_UNSPECIFIED")).toBeUndefined();
  expect(agyActivity("")).toBeUndefined();
});

test("a summary time parses with its nanoseconds trimmed", () => {
  expect(agyTime("2026-11-19 23:12:50.93496578+00:00")).toBe(Date.parse("2026-11-19T23:12:50.934Z"));
  expect(agyTime("nope")).toBeUndefined();
});

test("summaries are read from agy's own database, read-only, for the ids asked", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-agy-"));
  try {
    const db = new Database(join(home, "conversation_summaries.db"));
    db.run(
      "create table conversation_summaries (conversation_id text primary key, title text, status text, parent_conversation_id text, last_modified_time text)",
    );
    const add = db.prepare("insert into conversation_summaries values (?, ?, ?, ?, ?)");
    add.run(id, "Fix the tests", "CASCADE_RUN_STATUS_RUNNING", parent, "2026-11-19 23:12:50.9+00:00");
    add.run(parent, "", "CASCADE_RUN_STATUS_IDLE", "", "2026-11-19 23:12:06.9+00:00");
    db.close();
    const found = readAgySummaries([id, parent, "missing"], home);
    expect(found.get(id)).toMatchObject({ title: "Fix the tests", activity: "working", parentId: parent });
    expect(found.get(parent)).toMatchObject({ title: undefined, activity: "idle", parentId: undefined });
    expect(found.has("missing")).toBe(false);
    expect(readAgySummaries([id], join(home, "absent")).size).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("interactive rows take their status from the summary, headless runs are working, helpers are skipped", () => {
  const base = { cwd: "/repo", startedAt: 1, terminal: true };
  const summaries = new Map([[id, { title: "Fix", activity: "idle" as const, lastActiveAt: 5 }]]);
  const rows = buildAgyProcesses(
    [
      { ...base, pid: 1, args: ["agy"], openId: id },
      { ...base, pid: 2, args: ["agy"] },
      { ...base, pid: 3, args: ["agy", "-p", "work"], terminal: false, openId: parent },
      { ...base, pid: 4, args: ["agy"], terminal: false },
      { ...base, pid: 5, args: ["agy", "acp"] },
      { ...base, pid: 6, args: ["agy", "--conversation", parent] },
    ],
    summaries,
  );
  expect(rows.map((row) => row.pid)).toEqual([1, 2, 3, 6]);
  expect(rows[0]).toMatchObject({ agent: "agy", id, title: "Fix", activity: "idle", lastActiveAt: 5 });
  // No first prompt yet: no conversation, so no id and no status.
  expect(rows[1]).toMatchObject({ id: undefined, activity: undefined });
  expect(rows[2]).toMatchObject({ id: parent, activity: "working", agyExec: true });
  expect(rows[3]).toMatchObject({ id: parent });
});
