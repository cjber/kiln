import { describe, expect, test } from "bun:test";
import { nestSessions, type Session, sessionParents } from "./sessions";

describe("nested sessions", () => {
  const parent: Session = { pid: 1, agent: "codex", cwd: "/z", startedAt: 1, place: { kind: "kiln", name: "parent" } };
  const child: Session = {
    pid: 2,
    parentSessionPid: 1,
    agent: "claude",
    cwd: "/a",
    startedAt: 2,
    place: { kind: "kiln", name: "child" },
  };
  const other: Session = { pid: 3, agent: "pi", cwd: "/b", startedAt: 3, place: { kind: "kiln", name: "child" } };
  test("provider ancestry takes precedence and cycles stay visible", () => {
    const provider = { ...other, agent: "codex" as const, id: "provider" };
    const nested = { ...parent, id: "nested", parentSessionId: "provider", parentSessionPid: 2 };
    expect(sessionParents([child, nested, provider]).get(nested)).toBe(provider);
    const a = { ...parent, id: "a", parentSessionId: "b" };
    const b = { ...provider, id: "b", parentSessionId: "a" };
    expect(nestSessions([a, b])).toHaveLength(2);
    expect(sessionParents([a, b]).get(a)).toBeUndefined();
  });
  test("a child sorts beneath its parent even when its directory sorts first", () => {
    expect(nestSessions([child, other, parent])).toEqual([other, parent, child]);
  });
  test("a child stays visible when its parent is absent", () => {
    expect(nestSessions([child, other])).toEqual([child, other]);
  });
});
