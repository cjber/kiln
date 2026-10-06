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

test("cross-provider parents use the parent's provider and keep grandchildren nested", () => {
  const root: Session = {
    agent: "codex",
    id: "root",
    cwd: "/z",
    startedAt: 1,
    place: { kind: "thread", id: "root", attach: [] },
  };
  const child: Session = {
    agent: "claude",
    id: "child",
    pid: 2,
    parentSessionId: "root",
    parentSessionAgent: "codex",
    cwd: "/a",
    startedAt: 2,
    place: { kind: "elsewhere" },
  };
  const grandchild: Session = {
    agent: "pi",
    pid: 3,
    parentSessionPid: 2,
    cwd: "/b",
    startedAt: 3,
    place: { kind: "elsewhere" },
  };
  const collision: Session = { ...root, agent: "claude" };
  expect(sessionParents([child, root, collision, grandchild]).get(child)).toBe(root);
  expect(nestSessions([grandchild, child, root])).toEqual([root, child, grandchild]);
});

test("every provider pair nests by process or explicit provider identity", () => {
  for (const parentAgent of ["claude", "codex", "pi"] as const) {
    for (const childAgent of ["claude", "codex", "pi"] as const) {
      const parent: Session = {
        agent: parentAgent,
        id: "parent",
        pid: 1,
        cwd: "/parent",
        startedAt: 1,
        place: { kind: "elsewhere" },
      };
      const child: Session = {
        agent: childAgent,
        id: "child",
        pid: 2,
        cwd: "/child",
        startedAt: 2,
        place: { kind: "elsewhere" },
      };
      for (const linked of [
        { ...child, parentSessionPid: 1 },
        { ...child, parentSessionId: "parent", parentSessionAgent: parentAgent },
      ]) {
        expect(nestSessions([linked, parent])).toEqual([parent, linked]);
        expect(nestSessions([linked])).toEqual([linked]);
      }
      const cyclicParent = { ...parent, parentSessionId: "child", parentSessionAgent: childAgent };
      const cyclicChild = { ...child, parentSessionId: "parent", parentSessionAgent: parentAgent };
      expect(nestSessions([cyclicParent, cyclicChild])).toEqual([cyclicParent, cyclicChild]);
    }
  }
});
