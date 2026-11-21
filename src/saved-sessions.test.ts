import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  attachParents,
  forget,
  reconcile,
  recordSpawn,
  rememberParents,
  restartStopped,
  spawnRecord,
} from "./saved-sessions";
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
const unknown = () => undefined;

test("a session saved in an earlier boot comes back stopped, until it is running again", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
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

  const restarted = reconcile(saved, [], "boot-2", 0, dead, unknown);
  expect(restarted.saved).toEqual(saved);
  expect(restarted.stopped).toMatchObject([
    { agent: "claude", id: "a", title: "fix the build", cwd: "/repo", lifecycle: "stopped", place: { kind: "saved" } },
  ]);
  expect(restarted.stopped[0]?.pid).toBeUndefined();

  const resumed = reconcile(
    saved,
    [{ ...running, pid: 20, processStart: 500 }],
    "boot-2",
    0,
    (pid) => pid === 20,
    () => 500,
  );
  expect(resumed.stopped).toEqual([]);
  expect(resumed.saved).toMatchObject([{ id: "a", boot: "boot-2", pid: 20 }]);
});

test("a spawned session seen running keeps what its spawn recorded for a restart on another account", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  const recorded = saved.map((item) => ({
    ...item,
    account: "work",
    brief: "fix it",
    tried: "home",
    interactive: true,
  }));
  const again = reconcile(recorded, [running], "boot-1", 1, dead, unknown);
  expect(again.saved).toMatchObject([{ account: "work", brief: "fix it", tried: "home", interactive: true }]);
});

test("a session killed in this boot whose spawn pane is still dead comes back stopped (#276)", () => {
  const spawned = { ...running, place: { kind: "kiln" as const, name: "claude-a" } };
  const { saved } = reconcile([], [spawned], "boot-1", 0, dead, unknown);
  const withPane = saved.map((item) => ({ ...item, pane: "claude-a" }));
  const deadPane = (pane: string) => pane === "claude-a";
  // Long after the kill, a pane nothing reaped still says the session was cut off, not closed.
  const killed = reconcile(withPane, [], "boot-1", 10_000_000, dead, unknown, () => true, deadPane);
  expect(killed.stopped).toMatchObject([{ id: "a", lifecycle: "stopped", place: { kind: "saved" } }]);
  expect(reconcile(killed.saved, [], "boot-1", 20_000_000, dead, unknown, () => true, deadPane).stopped).toHaveLength(
    1,
  );
  // Once the pane is gone, a session that quit in this boot was closed, as before.
  const reaped = reconcile(
    killed.saved,
    [],
    "boot-1",
    20_000_000,
    dead,
    unknown,
    () => true,
    () => false,
  );
  expect(reaped.stopped).toEqual([]);
  // A child's parent decides whether to run it again, so its dead pane does not offer it.
  const child = withPane.map((item) => ({ ...item, parent: "claude:p", goneAt: 0 }));
  expect(reconcile(child, [], "boot-1", 10_000_000, dead, unknown, () => true, deadPane).stopped).toEqual([]);
});

test("a listing whose process quit before it was written leaves a stopped session stopped", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  const stale = reconcile(saved, [{ ...running, pid: 20 }], "boot-2", 0, dead, unknown);
  expect(stale.saved).toEqual(saved);
  expect(reconcile(stale.saved, [], "boot-2", 0, dead, unknown).stopped).toMatchObject([
    { id: "a", lifecycle: "stopped" },
  ]);
});

test("a listing whose pid now belongs to another process leaves a stopped session stopped", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  const reused = reconcile(
    saved,
    [{ ...running, pid: 20, processStart: 500 }],
    "boot-2",
    0,
    () => true,
    () => 900,
  );
  expect(reused.saved).toEqual(saved);
});

test("a session closed during the same boot is dropped once kiln has outlived it", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  const gone = reconcile(saved, [], "boot-1", 1_000, dead, unknown);
  expect(gone.stopped).toEqual([]);
  expect(gone.saved).toMatchObject([{ id: "a", goneAt: 1_000 }]);
  // A shutdown that ends kiln inside the wait leaves the record for the next boot.
  expect(reconcile(gone.saved, [], "boot-2", 2_000, dead, unknown).stopped).toHaveLength(1);
  expect(reconcile(gone.saved, [], "boot-1", 60_000, dead, unknown).saved).toHaveLength(1);
  expect(reconcile(gone.saved, [], "boot-1", 121_000, dead, unknown).saved).toEqual([]);
  expect(reconcile(gone.saved, [running], "boot-1", 60_000, dead, unknown).saved[0]?.goneAt).toBeUndefined();
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
      { ...running, agent: "codex", id: "thread", pid: undefined, place: { kind: "thread", id: "thread", attach: [] } },
    ],
    "boot-1",
    0,
    dead,
    unknown,
  );
  expect(saved.map((item) => item.id)).toEqual(["kitty", "thread"]);
});

test("a process that moved to a new conversation replaces its record", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  expect(reconcile(saved, [{ ...running, id: "b" }], "boot-1", 0, dead, unknown).saved.map((item) => item.id)).toEqual([
    "b",
  ]);
});

test("a stopped row is hidden while its conversation is listed some other way", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  const job: Session = { ...running, pid: undefined, place: { kind: "job", id: "0b276145", attach: [] } };
  const result = reconcile(saved, [job], "boot-2", 0, dead, unknown);
  expect(result.stopped).toEqual([]);
  expect(result.saved).toHaveLength(1);
});

test("a row whose conversation its provider lists as finished is dropped, not offered after a restart", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  const done: Session = {
    ...running,
    pid: undefined,
    lifecycle: "completed",
    place: { kind: "job", id: "0b276145", attach: [] },
  };
  expect(reconcile(saved, [done], "boot-1", 0, () => true, unknown).saved).toEqual([]);
  expect(reconcile(saved, [done], "boot-2", 0, dead, unknown)).toEqual({ saved: [], stopped: [] });
});

test("a row from an earlier boot whose conversation is gone is dropped, not offered", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  // A running session is saved before its provider has written anything.
  expect(
    reconcile(
      saved,
      [],
      "boot-1",
      0,
      () => true,
      unknown,
      () => false,
    ).saved,
  ).toHaveLength(1);
  expect(reconcile(saved, [], "boot-2", 0, dead, unknown, () => false)).toEqual({ saved: [], stopped: [] });
});

test("a process missing from one listing is kept while it is still there", () => {
  const { saved } = reconcile([], [running], "boot-1", 0, dead, unknown);
  const gone = reconcile(saved, [], "boot-1", 1_000, dead, unknown);
  const unlisted = reconcile(gone.saved, [], "boot-1", 500_000, () => true, unknown);
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

test("a state file a newer kiln gave another column still lists the sessions a restart stopped", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  const terminal: Session = { ...running, agent: "codex" };
  recordSpawn({ agent: "opencode", id: "child", cwd: "/repo", parent: "codex:a", startedAt: 2 }, path);
  restartStopped([terminal], path);
  const db = new Database(path);
  db.exec("ALTER TABLE sessions ADD COLUMN future TEXT; UPDATE sessions SET boot = 'earlier';");
  db.close();
  // The child from the earlier boot is dropped, so the list is written back into the wider table.
  expect(restartStopped([], path).map((session) => session.id)).toEqual(["a"]);
  expect(
    new Database(path, { readonly: true })
      .query<{ id: string }, []>("SELECT id FROM sessions")
      .all()
      .map((row) => row.id),
  ).toEqual(["a"]);
});

test("a state file that cannot be read is an error, not an empty list", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "not a database");
  expect(() => restartStopped([], path)).toThrow();
});

test("a parent recorded for a spawn survives reconciliation and reaches the session", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  recordSpawn(
    { agent: "opencode", id: "child", cwd: "/repo", title: "task", parent: "claude:parent", startedAt: 2 },
    path,
  );
  const child: Session = {
    agent: "opencode",
    id: "child",
    pid: 30,
    cwd: "/repo",
    startedAt: 2,
    place: { kind: "thread", id: "child", attach: [] },
  };
  restartStopped([child], path);
  expect(attachParents([child], path)[0]?.spawnParent).toBe("claude:parent");
  expect(restartStopped([child], path)).toEqual([]);
  expect(attachParents([child], path)[0]?.spawnParent).toBe("claude:parent");
});

test("a headless child keeps the parent ancestry found while its process ran, while its provider lists it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  const parent: Session = {
    agent: "claude",
    id: "lead",
    pid: 10,
    cwd: "/repo",
    startedAt: 1,
    place: { kind: "kiln", name: "claude-lead" },
  };
  const running: Session = {
    agent: "opencode",
    id: "ses_child",
    pid: 40,
    parentSessionPid: 10,
    cwd: "/repo",
    startedAt: 2,
    place: { kind: "elsewhere" },
  };
  rememberParents(attachParents([parent, running], path), path);
  // The run has exited; the OpenCode service still lists the session, with no process to trace.
  const { pid: _pid, parentSessionPid: _ancestor, ...finished } = running;
  restartStopped([parent, finished], path);
  expect(attachParents([parent, finished], path)[1]?.spawnParent).toBe("claude:lead");
  // A provider parent outranks ancestry, so nothing is recorded for a child that has one.
  const provided = { ...running, id: "ses_other", parentSessionId: "lead", parentSessionAgent: "claude" as const };
  rememberParents([parent, provided], path);
  expect(attachParents([provided], path)[0]?.spawnParent).toBeUndefined();
});

test("a child row stays while its session is listed, and is dropped like any closed one after", () => {
  const child = {
    agent: "opencode" as const,
    id: "ses_child",
    cwd: "/repo",
    parent: "claude:lead",
    startedAt: 2,
    boot: "b",
  };
  const listed: Session = {
    agent: "opencode",
    id: "ses_child",
    cwd: "/repo",
    startedAt: 2,
    place: { kind: "elsewhere" },
  };
  // Long after its process exited, a child its provider still lists keeps its row and its parent.
  const exited = { ...child, pid: 40, goneAt: 0 };
  expect(reconcile([exited], [listed], "b", 200_000, () => false, unknown).saved).toEqual([
    { ...exited, goneAt: undefined },
  ]);
  const gone = reconcile([child], [], "b", 0, () => false, unknown).saved;
  expect(reconcile(gone, [], "b", 200_000, () => false, unknown).saved).toEqual([]);
});

test("a parent read from a detached run's environment is recorded once, and outlives the run", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  const detached: Session = {
    agent: "opencode",
    id: "ses_detached",
    pid: 50,
    spawnParent: "claude:lead",
    cwd: "/repo",
    startedAt: 3,
    place: { kind: "elsewhere" },
  };
  rememberParents([detached], path);
  const { pid: _pid, spawnParent: _parent, ...finished } = detached;
  expect(attachParents([finished], path)[0]?.spawnParent).toBe("claude:lead");
});

test("a restart never turns a child into a stopped session", () => {
  const child = {
    agent: "opencode" as const,
    id: "ses_child",
    cwd: "/repo",
    parent: "claude:lead",
    startedAt: 2,
    boot: "b",
  };
  const after = reconcile([child], [], "c", 0, () => false, unknown);
  expect(after.stopped).toEqual([]);
  expect(after.saved).toEqual([]);
  // One its provider still lists keeps its row and parent across the restart, as nesting needs.
  const listed: Session = {
    agent: "opencode",
    id: "ses_child",
    cwd: "/repo",
    startedAt: 2,
    place: { kind: "elsewhere" },
  };
  expect(reconcile([child], [listed], "c", 0, () => false, unknown)).toEqual({
    saved: [{ ...child, boot: "c" }],
    stopped: [],
  });
});

test("a headless OpenCode run is never saved, even when its parent is unknown", () => {
  const run: Session = {
    agent: "opencode",
    id: "ses_run",
    cwd: "/repo",
    startedAt: 1,
    place: { kind: "thread", id: "ses_run", attach: ["opencode", "--session", "ses_run"] },
  };
  const codex: Session = { ...run, agent: "codex", id: "thread", place: { kind: "thread", id: "thread", attach: [] } };
  expect(reconcile([], [run, codex], "b", 0, () => false, unknown).saved.map((item) => item.agent)).toEqual(["codex"]);
});

test("a spawn is found by its pane after its process has gone, even when its row moved to a thread id", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  recordSpawn(
    {
      agent: "codex",
      id: "40:7",
      cwd: "/repo",
      title: "audit",
      parent: "claude:lead",
      startedAt: 7,
      pid: 40,
      pane: "codex-1",
    },
    path,
  );
  expect(spawnRecord("codex-1", path)).toMatchObject({ agent: "codex", id: "40:7", parent: "claude:lead" });
  expect(spawnRecord("other", path)).toBeUndefined();
  // The row moves to the thread id once Codex names it, and keeps the pane its exit hook still names.
  restartStopped(
    [{ agent: "codex", id: "thread", pid: 40, cwd: "/repo", startedAt: 7, place: { kind: "kiln", name: "c" } }],
    path,
  );
  expect(spawnRecord("codex-1", path)).toMatchObject({ agent: "codex", id: "thread", pane: "codex-1" });
});

test("a spawned run keeps the start time its exit hook was bound to while it runs", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  recordSpawn(
    {
      agent: "claude",
      id: "child",
      cwd: "/repo",
      parent: "codex:lead",
      startedAt: 5_000,
      pid: 40,
      pane: "claude-child",
    },
    path,
  );
  // The listing reads the process's own start time, which is not the run's.
  restartStopped(
    [
      {
        agent: "claude",
        id: "child",
        pid: 40,
        cwd: "/repo",
        startedAt: 4_990,
        place: { kind: "kiln", name: "claude-child" },
      },
    ],
    path,
  );
  expect(spawnRecord("claude-child", path)).toMatchObject({ startedAt: 5_000, parent: "codex:lead" });
  // Resumed in a pane of its own, as `kiln resume` starts it, the conversation is a later run than the spawn's.
  restartStopped(
    [
      {
        agent: "claude",
        id: "child",
        pid: 41,
        cwd: "/repo",
        startedAt: 9_000,
        place: { kind: "kiln", name: "claude-0123456789abcdef" },
      },
    ],
    path,
  );
  expect(spawnRecord("claude-child", path)).toMatchObject({ startedAt: 9_000 });
});

test("a spawned Codex run keeps its recorded parent and title once its thread id is known", () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiln-saved-")), "kiln", "sessions.sqlite");
  recordSpawn(
    { agent: "codex", id: "40:7", cwd: "/repo", title: "audit", parent: "claude:lead", startedAt: 7, pid: 40 },
    path,
  );
  const unnamed: Session = { agent: "codex", pid: 40, cwd: "/repo", startedAt: 7, place: { kind: "kiln", name: "c" } };
  expect(attachParents([unnamed], path)[0]).toMatchObject({ spawnParent: "claude:lead", title: "audit" });

  const named = { ...unnamed, id: "0193-thread" };
  expect(attachParents([named], path)[0]).toMatchObject({ spawnParent: "claude:lead", title: "audit" });
  // Saving the run under its thread id replaces the row recorded for its process.
  restartStopped([named], path);
  expect(attachParents([named], path)[0]).toMatchObject({ spawnParent: "claude:lead", title: "audit" });
  expect(restartStopped([named], path)).toEqual([]);
  expect(attachParents([named], path)[0]).toMatchObject({ spawnParent: "claude:lead", title: "audit" });
});

test("a child's record outlives its process while its pane waits for the exit report, so the report can reap it", () => {
  const spawned = { ...running, place: { kind: "kiln" as const, name: "codex-a" } };
  const { saved } = reconcile([], [spawned], "boot-1", 0, dead, unknown);
  const child = saved.map((item) => ({ ...item, parent: "claude:p", pane: "codex-a" }));
  const kept = (pane: string) => pane === "codex-a";
  // The exit hook can run long after the process is gone; until it reaps the pane, its record is what it reports from.
  const gone = reconcile(
    child,
    [],
    "boot-1",
    10_000_000,
    dead,
    unknown,
    () => true,
    () => false,
    kept,
  );
  const waiting = reconcile(
    gone.saved,
    [],
    "boot-1",
    10_500_000,
    dead,
    unknown,
    () => true,
    () => false,
    kept,
  );
  expect(waiting.saved).toMatchObject([{ id: "a", pane: "codex-a" }]);
  expect(waiting.stopped).toHaveLength(0);
  // Once the report has reaped the pane, the record goes as any closed child's does.
  expect(
    reconcile(
      waiting.saved,
      [],
      "boot-1",
      20_000_000,
      dead,
      unknown,
      () => true,
      () => false,
      () => false,
    ).saved,
  ).toHaveLength(0);
});
