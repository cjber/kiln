import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedStatus, STATUS_TTL_MS } from "./status-cache";

const counting = () => {
  let calls = 0;
  return { refresh: async () => `${++calls} working`, calls: () => calls };
};

test("clients inside the TTL share one refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-status-"));
  const { refresh, calls } = counting();
  expect(await cachedStatus(refresh, dir)).toBe("1 working");
  expect(await cachedStatus(refresh, dir)).toBe("1 working");
  expect(calls()).toBe(1);
  expect(await cachedStatus(refresh, dir, Date.now() + STATUS_TTL_MS + 1)).toBe("2 working");
});

test("a client that loses the lock prints the stale line instead of refreshing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-status-"));
  const { refresh, calls } = counting();
  writeFileSync(join(dir, "status"), "old");
  writeFileSync(join(dir, "status.lock"), "");
  const stale = (Date.now() - STATUS_TTL_MS) / 1000;
  utimesSync(join(dir, "status"), stale, stale);
  expect(await cachedStatus(refresh, dir)).toBe("old");
  expect(calls()).toBe(0);
});

test("a lock left by a crashed refresh is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-status-"));
  const { refresh } = counting();
  writeFileSync(join(dir, "status.lock"), "");
  const crashed = (Date.now() - 60_000) / 1000;
  utimesSync(join(dir, "status.lock"), crashed, crashed);
  expect(await cachedStatus(refresh, dir)).toBe("1 working");
});
