import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forget, reconcile, restartStopped } from "./saved-sessions";
import type { Session } from "./sessions";

const running: Session = {
  agent: "claude",
  id: "a",
  pid: 10,
  title: "fix the build",
  cwd: "/repo",
  startedAt: 1,
  place: { kind: "kiln", name: "claude-1" },
};
const dead = () => false;

test("a session saved in an earlier boot comes back stopped, until it is running again", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead);
  expect(saved).toEqual([
    {
      agent: "claude",
      id: "a",
      cwd: "/repo",
      title: "fix the build",
      startedAt: 1,
      lastActiveAt: undefined,
      boot: "boot-1",
      pid: 10,
    },
  ]);

  const restarted = reconcile(saved, [], "boot-2", 0, dead);
  expect(restarted.saved).toEqual(saved);
  expect(restarted.stopped).toMatchObject([
    { agent: "claude", id: "a", title: "fix the build", cwd: "/repo", lifecycle: "stopped", place: { kind: "saved" } },
  ]);
  expect(restarted.stopped[0]?.pid).toBeUndefined();

  const resumed = reconcile(saved, [{ ...running, pid: 20 }], "boot-2", 0, dead);
  expect(resumed.stopped).toEqual([]);
  expect(resumed.saved).toMatchObject([{ id: "a", boot: "boot-2", pid: 20 }]);
});

test("a session closed during the same boot is dropped once kiln has outlived it", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead);
  const gone = reconcile(saved, [], "boot-1", 1_000, dead);
  expect(gone.stopped).toEqual([]);
  expect(gone.saved).toMatchObject([{ id: "a", goneAt: 1_000 }]);
  // A shutdown that ends kiln inside the wait leaves the record for the next boot.
  expect(reconcile(gone.saved, [], "boot-2", 2_000, dead).stopped).toHaveLength(1);
  expect(reconcile(gone.saved, [], "boot-1", 60_000, dead).saved).toHaveLength(1);
  expect(reconcile(gone.saved, [], "boot-1", 121_000, dead).saved).toEqual([]);
  expect(reconcile(gone.saved, [running], "boot-1", 60_000, dead).saved[0]?.goneAt).toBeUndefined();
});

test("only top-level terminal sessions with a conversation are saved", () => {
  const { saved } = reconcile(
    [],
    [
      { ...running, id: undefined },
      { ...running, id: "child", parentSessionPid: 10 },
      { ...running, id: "--flag" },
      { ...running, id: "job", place: { kind: "job", id: "0b276145", attach: [] } },
      { ...running, id: "kitty", pid: 11, place: { kind: "kitty", socket: "unix:/k", windowId: 1 } },
    ],
    "boot-1",
    0,
    dead,
  );
  expect(saved.map((item) => item.id)).toEqual(["kitty"]);
});

test("a process that moved to a new conversation replaces its record", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead);
  expect(reconcile(saved, [{ ...running, id: "b" }], "boot-1", 0, dead).saved.map((item) => item.id)).toEqual(["b"]);
});

test("a stopped row is hidden while its conversation is listed some other way", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead);
  const job: Session = { ...running, pid: undefined, place: { kind: "job", id: "0b276145", attach: [] } };
  const result = reconcile(saved, [job], "boot-2", 0, dead);
  expect(result.stopped).toEqual([]);
  expect(result.saved).toHaveLength(1);
});

test("a process missing from one listing is kept while it is still there", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead);
  const gone = reconcile(saved, [], "boot-1", 1_000, dead);
  const unlisted = reconcile(gone.saved, [], "boot-1", 500_000, () => true);
  expect(unlisted.saved).toMatchObject([{ id: "a", boot: "boot-1" }]);
  expect(unlisted.saved[0]?.goneAt).toBeUndefined();
});

test("the saved list is stored, and forgetting removes one session from it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  const ids = () =>
    new Database(path, { readonly: true })
      .query<{ id: string }, []>("SELECT id FROM sessions ORDER BY id")
      .all()
      .map((row) => row.id);
  expect(restartStopped([running, { ...running, id: "b", pid: 11 }], path)).toEqual([]);
  expect(ids()).toEqual(["a", "b"]);
  forget(running, path);
  expect(ids()).toEqual(["b"]);
});
