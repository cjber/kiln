import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piStatus } from "./pi-status";

const directory = mkdtempSync(join(tmpdir(), "kiln-pi-status-"));
const before = Bun.env.KILN_PI_STATUS_DIR;
Bun.env.KILN_PI_STATUS_DIR = directory;
afterEach(() => {
  if (before === undefined) delete Bun.env.KILN_PI_STATUS_DIR;
  else Bun.env.KILN_PI_STATUS_DIR = before;
  rmSync(directory, { recursive: true, force: true });
});

test("a Pi status record applies only to the process that wrote it, and unknown states stay unknown", () => {
  const record = { pid: 7, startedAt: 1000, sessionId: "abc", title: "Fix tests", activity: "waiting", updatedAt: 5 };
  writeFileSync(join(directory, "7.json"), JSON.stringify(record));
  expect(piStatus(7, 1000.4)).toEqual({ id: "abc", title: "Fix tests", activity: "waiting", lastActiveAt: 5 });
  expect(piStatus(7, 2000)).toEqual({});
  expect(piStatus(8, 1000)).toEqual({});
  writeFileSync(join(directory, "7.json"), JSON.stringify({ ...record, activity: "compacting" }));
  expect(piStatus(7, 1000).activity).toBeUndefined();
});
