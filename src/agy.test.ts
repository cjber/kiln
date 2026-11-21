import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyActivity, agyRawSummaryFlags, agyTime, buildAgyProcesses, classifyAgy, readAgySummaries } from "./agy";

const id = "671610db-7d53-4eca-933c-eb227c076904";
const parent = "5daba879-99a5-4048-a2be-30a71c9a8942";
const child = "11111111-2222-4333-8444-555555555555";

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

/** Build a minimal `CascadeTrajectorySummary` protobuf with optional `waiting_steps` (field 8) and `has_active_children` (field 18). */
function rawSummary(options: { waiting?: boolean; activeChildren?: boolean } = {}): Uint8Array {
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
  if (options.activeChildren) {
    // field 18: has_active_children varint 1
    bytes.push(...varint((18 << 3) | 0), 1);
  }
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

test("raw_summary protobuf flags detect waiting_steps and has_active_children, and reject malformed blobs", () => {
  expect(agyRawSummaryFlags(undefined)).toEqual({ hasWaitingSteps: false, hasActiveChildren: false });
  expect(agyRawSummaryFlags(new Uint8Array())).toEqual({ hasWaitingSteps: false, hasActiveChildren: false });
  expect(agyRawSummaryFlags(rawSummary())).toEqual({ hasWaitingSteps: false, hasActiveChildren: false });
  expect(agyRawSummaryFlags(rawSummary({ waiting: true }))).toEqual({
    hasWaitingSteps: true,
    hasActiveChildren: false,
  });
  expect(agyRawSummaryFlags(rawSummary({ waiting: true, activeChildren: true }))).toEqual({
    hasWaitingSteps: true,
    hasActiveChildren: true,
  });
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
  expect(agyRawSummaryFlags(withFixed)).toEqual({ hasWaitingSteps: true, hasActiveChildren: false });
  // An empty waiting_steps entry (length 0) does not count as waiting.
  expect(agyRawSummaryFlags(new Uint8Array([(8 << 3) | 2, 0]))).toEqual({
    hasWaitingSteps: false,
    hasActiveChildren: false,
  });
  // Truncated length-delimited payload is rejected rather than trusted.
  expect(agyRawSummaryFlags(new Uint8Array([(8 << 3) | 2, 2, 0x10, 0x01, (1 << 3) | 2, 99]))).toEqual({
    hasWaitingSteps: false,
    hasActiveChildren: false,
  });
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

test("summaries with raw_summary mark waiting runs and in-process waiting subagents as waiting", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-agy-raw-"));
  try {
    const db = new Database(join(home, "conversation_summaries.db"));
    db.run(
      "create table conversation_summaries (conversation_id text primary key, title text, status text, parent_conversation_id text, last_modified_time text, raw_summary blob)",
    );
    const add = db.prepare("insert into conversation_summaries values (?, ?, ?, ?, ?, ?)");
    const t = "2026-11-21 11:00:00.0+00:00";
    add.run(id, "Needs approval", "CASCADE_RUN_STATUS_RUNNING", "", t, rawSummary({ waiting: true }));
    add.run(parent, "Has subagent", "CASCADE_RUN_STATUS_RUNNING", "", t, rawSummary({ activeChildren: true }));
    add.run(child, "Subagent", "CASCADE_RUN_STATUS_RUNNING", parent, t, rawSummary({ waiting: true }));
    db.close();
    // When only id and parent are open processes, child is an in-process subagent so its wait surfaces on parent.
    const combined = readAgySummaries([id, parent], home);
    expect(combined.get(id)?.activity).toBe("waiting");
    expect(combined.get(parent)?.activity).toBe("waiting");
    // When child is its own open process, child shows waiting and parent stays working.
    const separate = readAgySummaries([id, parent, child], home);
    expect(separate.get(parent)?.activity).toBe("working");
    expect(separate.get(child)?.activity).toBe("waiting");
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
