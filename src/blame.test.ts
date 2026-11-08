import { describe, expect, test } from "bun:test";
import { blame, type Owned } from "./blame";
import type { FileEdit, Hunk } from "./edits";

/** Apply `edit` to `lines` as an agent would, with one line of context around each changed run. */
function apply(lines: string[], start: number, remove: number, insert: string[]): Hunk {
  const before = lines.slice(Math.max(0, start - 1), start);
  const after = lines.slice(start + remove, start + remove + 1);
  const removed = lines.slice(start, start + remove);
  lines.splice(start, remove, ...insert);
  const oldStart = start - before.length + 1;
  return {
    oldStart,
    oldLines: before.length + removed.length + after.length,
    newStart: oldStart,
    newLines: before.length + insert.length + after.length,
    lines: [
      ...before.map((line) => ` ${line}`),
      ...removed.map((line) => `-${line}`),
      ...insert.map((line) => `+${line}`),
      ...after.map((line) => ` ${line}`),
    ],
  };
}

const edit = (id: string, hunks: Hunk[], change: FileEdit["change"] = "update"): FileEdit => ({
  id,
  file: "/repo/a.ts",
  change,
  hunks,
  turn: 0,
});

describe("blame", () => {
  test("credits each line to the newest edit that wrote it", () => {
    const lines = ["one", "two", "three", "four"];
    const first = edit("first", [apply(lines, 1, 1, ["TWO", "TWO-B"])]);
    const second = edit("second", [apply(lines, 4, 1, ["FOUR"])]);
    const owners = blame(lines, [
      { edit: first, owner: "claude" },
      { edit: second, owner: "codex" },
    ]);
    expect(lines).toEqual(["one", "TWO", "TWO-B", "three", "FOUR"]);
    expect(owners.map((owned) => owned?.owner)).toEqual([undefined, "claude", "claude", undefined, "codex"]);
  });

  test("a line rewritten later belongs to the later edit", () => {
    const lines = ["a", "b", "c"];
    const first = edit("first", [apply(lines, 1, 1, ["B"])]);
    const second = edit("second", [apply(lines, 1, 1, ["B2"])]);
    const owners = blame(lines, [
      { edit: first, owner: 1 },
      { edit: second, owner: 2 },
    ]);
    expect(owners.map((owned) => owned?.owner)).toEqual([undefined, 2, undefined]);
  });

  test("finds a hunk shifted by lines something else inserted above it", () => {
    const lines = ["a", "b", "c", "d"];
    const first = edit("first", [apply(lines, 3, 1, ["D"])]);
    lines.unshift("header 1", "header 2");
    const owners = blame(lines, [{ edit: first, owner: "x" }]);
    expect(owners.map((owned) => owned?.owner)).toEqual([undefined, undefined, undefined, undefined, undefined, "x"]);
  });

  test("a line changed outside any transcript is nobody's", () => {
    const lines = ["a", "b", "c"];
    const first = edit("first", [apply(lines, 1, 1, ["B"])]);
    lines[1] = "B formatted";
    expect(blame(lines, [{ edit: first, owner: "x" }]).every((owned) => owned === undefined)).toBe(true);
  });

  test("a created file owns every line while nothing else has changed it", () => {
    const created = edit(
      "create",
      [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ["+a", "+b", "+c"] }],
      "create",
    );
    expect(blame(["a", "b", "c"], [{ edit: created, owner: "x" }]).map((owned) => owned?.owner)).toEqual([
      "x",
      "x",
      "x",
    ]);
    expect(blame(["a", "b changed", "c"], [{ edit: created, owner: "x" }]).every((owned) => !owned)).toBe(true);
  });

  test("stops at a gap instead of crediting older edits", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const first = edit("first", [apply(lines, 1, 1, ["B"])]);
    lines[1] = "B formatted";
    const second = edit("second", [apply(lines, 3, 1, ["D"])]);
    // The line `first` wrote was reformatted after it, so `first` is no longer found and nothing older is credited.
    const owners = blame(lines, [
      { edit: first, owner: "old" },
      { edit: second, owner: "new" },
    ]);
    expect(owners.map((owned) => owned?.owner)).toEqual([undefined, undefined, undefined, "new", undefined]);
  });

  test("an edit whose context a formatter rewrote is found by its own lines", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const first = edit("first", [apply(lines, 2, 1, ["C"])]);
    lines[1] = "b formatted";
    lines[3] = "d formatted";
    const owners = blame(lines, [{ edit: first, owner: "x" }]);
    expect(owners.map((owned) => owned?.owner)).toEqual([undefined, undefined, "x", undefined, undefined]);
  });

  test("an ambiguous hunk away from its header attributes nothing", () => {
    const hunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" }", "+x", " }"] };
    // Inserted lines above moved it, and two places now fit.
    const owners = blame(["top", "}", "x", "}", "}", "x", "}"], [{ edit: edit("e", [hunk]), owner: "a" }]);
    expect(owners.every((owned) => !owned)).toBe(true);
  });

  test("matches a random history of edits by two agents", () => {
    let seed = 11;
    const random = (below: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return Math.floor((seed / 2 ** 31) * below);
    };
    for (let round = 0; round < 100; round++) {
      // Every line is unique, so the truth is unambiguous.
      let counter = 0;
      const lines = Array.from({ length: 5 + random(20) }, () => `base ${counter++}`);
      const truth: (string | undefined)[] = lines.map(() => undefined);
      const edits: Owned<string>[] = [];
      for (let step = 0; step < 1 + random(8); step++) {
        const owner = random(2) ? "claude" : "codex";
        const start = random(lines.length + 1);
        const remove = Math.min(random(3), lines.length - start);
        const insert = Array.from({ length: random(4) }, () => `${owner} ${counter++}`);
        edits.push({ edit: edit(`e${step}`, [apply(lines, start, remove, insert)]), owner });
        truth.splice(start, remove, ...insert.map(() => owner));
      }
      expect(blame(lines, edits).map((owned) => owned?.owner)).toEqual(truth);
    }
  });
});
