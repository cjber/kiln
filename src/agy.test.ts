import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyActivity, agyRawSummaryFlags, agyTime, buildAgyProcesses, classifyAgy, readAgySummaries } from "./agy";

const id = "671610db-7d53-4eca-933c-eb227c076904";
const parent = "5daba879-99a5-4048-a2be-30a71c9a8942";
const child = "11111111-2222-4333-8444-555555555555";
const grandchild = "22222222-3333-4444-8555-666666666666";

function varint(value: number): number[] {
  const out: number[] = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** Build a `CascadeTrajectorySummary` protobuf with fields 8 (`waiting_steps`), 18 (legacy `has_active_children`), 21 (`not_fully_idle`), and 30 (`has_running_subagents`). */
function rawSummary(
  options: {
    waiting?: boolean;
    runningSubagents?: boolean;
    legacyActiveChildren?: boolean;
    notFullyIdle?: boolean;
  } = {},
): Uint8Array {
  const bytes: number[] = [];
  // field 1: summary string "hi"
  bytes.push((1 << 3) | 2, 2, 0x68, 0x69);
  // field 5: status varint 2 (RUNNING)
  bytes.push((5 << 3) | 0, 2);
  if (options.waiting) {
    // field 8: waiting_steps length-delimited CortexTrajectoryStepWithIndex { field 2: step_index = 4 }
    const step = [(2 << 3) | 0, 4];
    bytes.push((8 << 3) | 2, ...varint(step.length), ...step);
  }
  if (options.legacyActiveChildren !== undefined)
    bytes.push(...varint((18 << 3) | 0), options.legacyActiveChildren ? 1 : 0);
  if (options.notFullyIdle !== undefined) bytes.push(...varint((21 << 3) | 0), options.notFullyIdle ? 1 : 0);
  if (options.runningSubagents !== undefined) bytes.push(...varint((30 << 3) | 0), options.runningSubagents ? 1 : 0);
  return new Uint8Array(bytes);
}

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

test("a run status maps onto activity, waiting steps surface when active, and unknown stays unknown", () => {
  expect(agyActivity("CASCADE_RUN_STATUS_IDLE")).toBe("idle");
  expect(agyActivity("CASCADE_RUN_STATUS_IDLE", true, false)).toBe("idle");
  expect(agyActivity("CASCADE_RUN_STATUS_IDLE", true, true)).toBe("waiting");
  for (const busy of ["RUNNING", "BUSY"]) {
    expect(agyActivity(`CASCADE_RUN_STATUS_${busy}`)).toBe("working");
    expect(agyActivity(`CASCADE_RUN_STATUS_${busy}`, true)).toBe("waiting");
  }
  expect(agyActivity("CASCADE_RUN_STATUS_CANCELING")).toBe("working");
  expect(agyActivity("CASCADE_RUN_STATUS_CANCELING", true)).toBe("working");
  expect(agyActivity("CASCADE_RUN_STATUS_UNSPECIFIED", true)).toBeUndefined();
  expect(agyActivity("")).toBeUndefined();
});

test("raw_summary protobuf flags detect waiting_steps, running subagents and not_fully_idle, and reject malformed blobs", () => {
  const none = { hasWaitingSteps: false, hasActiveChildren: false, notFullyIdle: false };
  expect(agyRawSummaryFlags(undefined)).toEqual(none);
  expect(agyRawSummaryFlags("not-a-blob")).toEqual(none);
  expect(agyRawSummaryFlags(new Uint8Array())).toEqual(none);
  expect(agyRawSummaryFlags(rawSummary())).toEqual(none);
  expect(agyRawSummaryFlags(rawSummary({ waiting: true, notFullyIdle: true }))).toEqual({
    hasWaitingSteps: true,
    hasActiveChildren: false,
    notFullyIdle: true,
  });
  // Live agy sets field 30 (has_running_subagents) and field 21 (not_fully_idle); field 18 is legacy fallback.
  expect(agyRawSummaryFlags(rawSummary({ runningSubagents: true, legacyActiveChildren: false }))).toEqual({
    hasWaitingSteps: false,
    hasActiveChildren: true,
    notFullyIdle: false,
  });
  expect(agyRawSummaryFlags(rawSummary({ legacyActiveChildren: true }))).toEqual({
    hasWaitingSteps: false,
    hasActiveChildren: true,
    notFullyIdle: false,
  });
  // Singular scalar bools follow protobuf last-write-wins semantics (1 then 0 clears the flag).
  expect(agyRawSummaryFlags(new Uint8Array([...varint((30 << 3) | 0), 1, ...varint((30 << 3) | 0), 0]))).toEqual(none);
  // Fixed 64-bit (wire 1) and 32-bit (wire 5) fields before field 8 are skipped cleanly.
  const withFixed = new Uint8Array([
    (1 << 3) | 1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    (2 << 3) | 5,
    0,
    0,
    0,
    0,
    (8 << 3) | 2,
    2,
    0x10,
    0x01,
  ]);
  expect(agyRawSummaryFlags(withFixed)).toEqual({
    hasWaitingSteps: true,
    hasActiveChildren: false,
    notFullyIdle: false,
  });
  // An empty waiting_steps entry (length 0) has no step and does not count as waiting.
  expect(agyRawSummaryFlags(new Uint8Array([(8 << 3) | 2, 0]))).toEqual(none);
  // Malformed nested protobuf inside field 8 (unterminated varint) is rejected.
  expect(agyRawSummaryFlags(new Uint8Array([(8 << 3) | 2, 1, 0x80]))).toEqual(none);
  // Field number 0 with non-zero wire type, invalid wire types, and truncated payloads are rejected.
  expect(agyRawSummaryFlags(new Uint8Array([0x02, 0x00, (8 << 3) | 2, 2, 0x10, 0x01]))).toEqual(none);
  expect(agyRawSummaryFlags(new Uint8Array([(1 << 3) | 3]))).toEqual(none);
  expect(agyRawSummaryFlags(new Uint8Array([(8 << 3) | 2, 2, 0x10, 0x01, (1 << 3) | 2, 99]))).toEqual(none);
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

test("summaries with raw_summary mark waiting runs and nested in-process subagents as waiting", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-agy-raw-"));
  const idleParent = "33333333-4444-4555-8666-777777777777";
  const cancelingParent = "44444444-5555-4666-8777-888888888888";
  const cancelingChild = "55555555-6666-4777-8888-999999999999";
  const unknownParent = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const unknownChild = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  const staleIdle = "88888888-9999-4aaa-8bbb-cccccccccccc";
  try {
    const db = new Database(join(home, "conversation_summaries.db"));
    db.run(
      "create table conversation_summaries (conversation_id text primary key, title text, status text, parent_conversation_id text, last_modified_time text, raw_summary blob)",
    );
    const add = db.prepare("insert into conversation_summaries values (?, ?, ?, ?, ?, ?)");
    const t = "2026-11-21 11:00:00.0+00:00";
    add.run(id, "Needs approval", "CASCADE_RUN_STATUS_RUNNING", "", t, rawSummary({ waiting: true }));
    // Live async subagent pattern: IDLE parent -> IDLE intermediate subagent -> waiting grandchild.
    add.run(
      idleParent,
      "Async parent",
      "CASCADE_RUN_STATUS_IDLE",
      "",
      t,
      rawSummary({ runningSubagents: true, notFullyIdle: true }),
    );
    add.run(
      child,
      "Middle subagent",
      "CASCADE_RUN_STATUS_IDLE",
      idleParent,
      t,
      rawSummary({ runningSubagents: true, notFullyIdle: true }),
    );
    add.run(grandchild, "Leaf subagent", "CASCADE_RUN_STATUS_RUNNING", child, t, rawSummary({ waiting: true }));
    // CANCELING and unknown parents never become waiting from a child.
    add.run(
      cancelingParent,
      "Canceling",
      "CASCADE_RUN_STATUS_CANCELING",
      "",
      t,
      rawSummary({ runningSubagents: true }),
    );
    add.run(cancelingChild, "Child", "CASCADE_RUN_STATUS_RUNNING", cancelingParent, t, rawSummary({ waiting: true }));
    add.run(unknownParent, "Unknown", "CASCADE_RUN_STATUS_UNSPECIFIED", "", t, rawSummary({ runningSubagents: true }));
    add.run(unknownChild, "Child", "CASCADE_RUN_STATUS_RUNNING", unknownParent, t, rawSummary({ waiting: true }));
    // Stale waiting_steps on a fully idle row stays idle; null raw_summary falls back to status.
    add.run(staleIdle, "Stale", "CASCADE_RUN_STATUS_IDLE", "", t, rawSummary({ waiting: true }));
    add.run(parent, "No blob", "CASCADE_RUN_STATUS_RUNNING", "", t, null);
    db.close();

    const combined = readAgySummaries([id, idleParent, cancelingParent, unknownParent, staleIdle, parent], home);
    expect(combined.get(id)?.activity).toBe("waiting");
    expect(combined.get(idleParent)?.activity).toBe("waiting");
    expect(combined.get(cancelingParent)?.activity).toBe("working");
    expect(combined.get(unknownParent)?.activity).toBeUndefined();
    expect(combined.get(staleIdle)?.activity).toBe("idle");
    expect(combined.get(parent)?.activity).toBe("working");

    // When grandchild is its own open process, it owns its wait and idleParent stays idle.
    const separate = readAgySummaries([idleParent, grandchild], home);
    expect(separate.get(idleParent)?.activity).toBe("idle");
    expect(separate.get(grandchild)?.activity).toBe("waiting");
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
