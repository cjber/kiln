import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("the extension hands each message kiln leaves to Pi once, as a follow-up, and removes its inbox on exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiln-pi-inbox-"));
  const previous = Bun.env.KILN_PI_STATUS_DIR;
  Bun.env.KILN_PI_STATUS_DIR = directory;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const sent: unknown[][] = [];
  const pi = {
    on: (name: string, handler: () => void) => handlers.set(name, handler),
    sendUserMessage: (...args: unknown[]) => sent.push(args),
  };
  const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => "s1", getSessionName: () => "t" } };
  try {
    const inbox = join(directory, `${process.pid}.inbox`);
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "1.json"), JSON.stringify({ text: "waiting before start" }));
    const { default: extension } = await import(`../pi-extension/kiln-status.js?${Date.now()}`);
    extension(pi);
    handlers.get("session_start")?.({}, ctx);
    handlers.get("session_start")?.({}, ctx);
    writeFileSync(join(inbox, "2.tmp"), JSON.stringify({ text: "half written" }));
    writeFileSync(join(inbox, "3.json"), JSON.stringify({ text: "after start" }));
    for (let tries = 0; sent.length < 2 && tries < 50; tries++) await Bun.sleep(20);
    expect(sent).toEqual([
      ["waiting before start", { deliverAs: "followUp" }],
      ["after start", { deliverAs: "followUp" }],
    ]);
    handlers.get("session_shutdown")?.({}, ctx);
    expect(existsSync(inbox)).toBe(false);
  } finally {
    if (previous === undefined) delete Bun.env.KILN_PI_STATUS_DIR;
    else Bun.env.KILN_PI_STATUS_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
