import { expect, test } from "bun:test";
import { afterMuseWord, buildMuseProcesses, classifyMuse, parseListed, parseRegistry } from "./muse";

const id = "01a1ee06-1787-71c3-b858-29eb0cd46d25";
const other = "01a1ee06-1787-71c3-b858-29eb0cd46d26";

test("a registry record is trusted only when its name, id and pid hint agree", () => {
  const source = JSON.stringify({
    session_id: id,
    session_name: "crystal-merak",
    process_generation_hint: "pid=4242",
    target_eligibility: "message_capable",
  });
  expect(parseRegistry(source, id)).toEqual({ id, name: "crystal-merak", pid: 4242, messageCapable: true });
  expect(parseRegistry(source, other)).toBeUndefined();
  expect(
    parseRegistry(JSON.stringify({ session_id: id, process_generation_hint: "pid=abc" }), id)?.pid,
  ).toBeUndefined();
  expect(parseRegistry("not json", id)).toBeUndefined();
  expect(parseRegistry(source, "../escape")).toBeUndefined();
});

test("a listed session keeps its name and side-chat parent, and malformed output lists none", () => {
  const listed = parseListed(
    JSON.stringify({ sessions: [{ sessionId: id, name: "crystal-merak", sideOf: other }, { sessionId: "nope" }] }),
  );
  expect(listed.get(id)).toEqual({ name: "crystal-merak", sideOf: other });
  expect(listed.size).toBe(1);
  expect(parseListed("[{").size).toBe(0);
  expect(parseListed(JSON.stringify({ sessions: {} })).size).toBe(0);
});

test("argv decides what a muse process is, and root options never hide exec", () => {
  expect(classifyMuse(["/home/me/.local/bin/muse-bin-1.4.23", "exec", "--session-id", id, "work"])).toEqual({
    kind: "exec",
    sessionId: id,
  });
  expect(classifyMuse(["muse", "--model", "big", "exec", "work"])).toEqual({ kind: "exec", sessionId: undefined });
  expect(classifyMuse(["muse", "resume", id])).toEqual({ kind: "interactive" });
  expect(classifyMuse(["muse", "fix the tests"])).toEqual({ kind: "interactive" });
  expect(classifyMuse(["muse", "sessions", "--json"])).toEqual({ kind: "other" });
  expect(classifyMuse(["muse", "session-message", "send"])).toEqual({ kind: "other" });
  expect(classifyMuse(["codex", "exec"])).toEqual({ kind: "other" });
  expect(classifyMuse(["muse", "exec", "--session-id", "not-a-uuid"])).toEqual({
    kind: "exec",
    sessionId: undefined,
  });
});

test("subcommands go directly after the muse word, wrappers included", () => {
  expect(afterMuseWord(["muse"])).toBe(1);
  expect(afterMuseWord(["wrapper", "/opt/muse-bin-1.4.23", "--flag"])).toBe(2);
  expect(afterMuseWord(["wrapper"])).toBe(1);
});

test("rows name interactive sessions from their log first and exec runs from their argv", () => {
  const registry = new Map([[7, { id: other, name: "registered", pid: 7, messageCapable: true }]]);
  const listed = new Map([[id, { name: "listed", sideOf: other }]]);
  const rows = buildMuseProcesses(
    [
      { pid: 7, args: ["muse"], cwd: "/repo", startedAt: 10, terminal: true, logId: id },
      { pid: 8, args: ["muse", "exec", "--session-id", id, "work"], cwd: "/repo", startedAt: 11, terminal: false },
      { pid: 9, args: ["muse"], cwd: "/repo", startedAt: 12, terminal: false },
      { pid: 10, args: ["muse"], cwd: "/repo", startedAt: 13, terminal: true },
    ],
    registry,
    listed,
  );
  expect(rows).toHaveLength(2);
  // The open log outranks the registry, and the listing names the session and its side-chat parent.
  expect(rows[0]).toMatchObject({ pid: 7, id, title: "listed", parentSessionId: other });
  expect(rows[0]?.activity).toBeUndefined();
  expect(rows[0]?.museExec).toBeUndefined();
  expect(rows[1]).toMatchObject({ pid: 8, id, activity: "working", museExec: true });
});

test("a registry record names a process only when the live listing names that session", () => {
  const candidate = { pid: 7, args: ["muse"], cwd: "/repo", startedAt: 10, terminal: true };
  const registry = new Map([[7, { id, pid: 7, messageCapable: true }]]);
  // The pid was reused by a newer session: the listing does not name the recorded one, so no row is listed.
  expect(buildMuseProcesses([candidate], registry, new Map())).toHaveLength(0);
  expect(buildMuseProcesses([candidate], registry, undefined)).toHaveLength(0);
  expect(buildMuseProcesses([candidate], registry, new Map([[id, {}]]))).toHaveLength(1);
  // An exec run without a kiln-chosen id or an open log stays unlisted rather than borrowing a registry id.
  const exec = { pid: 7, args: ["muse", "exec", "work"], cwd: "/repo", startedAt: 10, terminal: false };
  expect(buildMuseProcesses([exec], registry, new Map([[id, {}]]))).toHaveLength(0);
});
