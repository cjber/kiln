import { expect, test } from "bun:test";
import { sessionKey, sessionRows } from "./session-list";
import { nestSessions, type Session, sessionParent, sessionParents } from "./sessions";

const session = (id: string, parentSessionId?: string): Session => ({
  agent: "codex",
  id,
  parentSessionId,
  cwd: "/tmp/perf",
  startedAt: 1,
  place: { kind: "kiln", name: id },
});

test("indexed ancestry preserves first-match precedence, PID fallback and cycle rejection", () => {
  const first = { ...session("parent"), pid: 1 };
  const duplicate = { ...session("parent"), pid: 2 };
  const providerChild = { ...session("child", "parent"), parentSessionPid: 2 };
  const pidChild = { ...session("pid-child", "missing"), parentSessionPid: 2 };
  const a = session("a", "b");
  const b = session("b", "a");
  const cycleChild = session("cycle-child", "a");
  const sessions = [first, duplicate, providerChild, pidChild, a, b, cycleChild];
  const parents = sessionParents(sessions);
  expect(parents.get(providerChild)).toBe(first);
  expect(parents.get(pidChild)).toBe(duplicate);
  for (const member of [a, b, cycleChild]) expect(parents.get(member)).toBeUndefined();
  expect(nestSessions(sessions)).toEqual([first, providerChild, duplicate, pidChild, a, b, cycleChild]);
  const outside = session("outside", "referencing-outside");
  const referencing = session("referencing-outside", "outside");
  expect(sessionParent(outside, [referencing])).toBe(referencing);
  providerChild.parentSessionId = "missing";
  expect(sessionParents(sessions).get(providerChild)).toBe(duplicate);
});

test("500 shallow or deeply nested tasks stay within an interactive refresh budget", () => {
  for (const shape of ["shallow", "chain"] as const) {
    const sessions = Array.from({ length: 500 }, (_, index) =>
      session(
        String(index),
        shape === "chain"
          ? index
            ? String(index - 1)
            : undefined
          : index % 10
            ? String(index - (index % 10))
            : undefined,
      ),
    );
    const start = performance.now();
    const nested = nestSessions(sessions);
    const rows = sessionRows(nested, "project", "", new Set(sessions.map(sessionKey)));
    const elapsed = performance.now() - start;
    expect(nested).toHaveLength(500);
    expect(rows.filter((row) => row.kind === "session")).toHaveLength(500);
    expect(elapsed).toBeLessThan(500);
    if (shape === "chain") {
      expect(rows.at(-1)).toMatchObject({ depth: 499 });
      const hidden = sessions.map((row, index) => (index ? { ...row, place: { kind: "elsewhere" as const } } : row));
      expect(sessionRows(hidden, "project", "499", new Set()).filter((row) => row.kind === "session")).toHaveLength(
        500,
      );
    }
  }
});
