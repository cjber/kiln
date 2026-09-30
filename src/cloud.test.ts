import { expect, test } from "bun:test";

import { cloudCache, parseCloudPage } from "./cloud";

const task = { id: "task_123", title: "Update search", status: "ready", updated_at: "2026-09-30T09:00:00Z" };
const page = (tasks = [task]) => JSON.stringify({ tasks, cursor: null });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("CLI tasks map every current status, leave new statuses unknown and reject malformed pages", () => {
  const statuses = ["pending", "ready", "applied", "error", "new-status"];
  expect(parseCloudPage(page(statuses.map((status) => ({ ...task, status })))).sessions.map((s) => s.activity)).toEqual(
    ["working", "waiting", "idle", "waiting", undefined],
  );
  expect(parseCloudPage(page()).sessions[0]?.place).toEqual({ kind: "cloud", id: task.id, title: task.title });
  expect(() => parseCloudPage("{}")).toThrow("invalid task page");
  expect(() => parseCloudPage(page([{ ...task, updated_at: "invalid" }]))).toThrow("invalid task");
});

test("slow cloud discovery never blocks reads or overlaps; refreshes are cached for 60 seconds", async () => {
  let clock = 0;
  let calls = 0;
  let complete: (sessions: ReturnType<typeof parseCloudPage>["sessions"]) => void = () => {};
  const read = cloudCache(
    () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    () => clock,
  );
  expect(read().sessions).toEqual([]);
  await settle();
  clock = 90_000;
  expect(read().sessions).toEqual([]);
  expect(calls).toBe(1);
  complete(parseCloudPage(page()).sessions);
  await settle();
  expect(read(false).sessions).toHaveLength(1);
  clock = 30_000;
  read();
  expect(calls).toBe(1);
  clock = 60_000;
  read();
  await settle();
  expect(calls).toBe(2);
  complete([]);
  await settle();
});

test("a failed refresh retains rows, reports the fault and waits before retrying", async () => {
  let clock = 0;
  let calls = 0;
  const read = cloudCache(
    async () => {
      calls++;
      if (calls > 1) throw new Error("offline");
      return parseCloudPage(page()).sessions;
    },
    () => clock,
  );
  read();
  await settle();
  clock = 60_000;
  read();
  await settle();
  expect(read().sessions).toHaveLength(1);
  expect(read().problem).toContain("offline");
  expect(calls).toBe(2);
});
