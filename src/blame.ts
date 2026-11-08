import type { FileEdit, Hunk } from "./edits";

/** An edit and whoever made it; `owner` is opaque here (the session, in practice). */
export type Owned<Owner> = { edit: FileEdit; owner: Owner };

/** One line of the model: its text, and the line of the file on disk it is, if it still is one. */
type Entry = { text: string; line?: number };

/**
 * Where `block` is in `model`: at `expected`, the position the hunk's header names, or else at the one place it
 * appears exactly, as `patch` finds a hunk that other changes shifted. No match, or more than one away from
 * `expected`, is -1: the history has a gap there, and a guessed position would credit the wrong lines.
 */
function locate(model: readonly Entry[], block: readonly string[], expected: number): number {
  const fits = (at: number) => {
    if (at < 0 || at + block.length > model.length) return false;
    for (let index = 0; index < block.length; index++) if (model[at + index]?.text !== block[index]) return false;
    return true;
  };
  if (fits(expected)) return expected;
  // An empty block fits anywhere, so it is found only where its header names.
  if (!block.length) return -1;
  let found = -1;
  for (let at = 0; at + block.length <= model.length; at++)
    if (fits(at)) {
      if (found !== -1) return -1;
      found = at;
    }
  return found;
}

/**
 * Who wrote each line of a file, given its lines on disk now and the edits made to it, oldest first. Like `git blame`,
 * it walks back from the current text, undoing each edit: a line an edit added and nothing changed since belongs to
 * that edit. The walk stops at the first edit whose text is no longer where it should be, since something no
 * transcript recorded (a formatter, a shell command, a person) changed the file there and nothing older can be
 * matched with certainty. A whole-file write or a delete also ends it. Index `i` is line `i + 1`.
 */
export function blame<Owner>(current: readonly string[], edits: readonly Owned<Owner>[]): (Owned<Owner> | undefined)[] {
  const owners: (Owned<Owner> | undefined)[] = new Array(current.length).fill(undefined);
  let model: Entry[] = current.map((text, index) => ({ text, line: index }));
  const claim = (entry: Entry | undefined, owned: Owned<Owner>) => {
    if (entry?.line !== undefined && owners[entry.line] === undefined) owners[entry.line] = owned;
  };
  for (let index = edits.length - 1; index >= 0; index--) {
    const owned = edits[index] as Owned<Owner>;
    const { edit } = owned;
    if (edit.change === "delete") break;
    if (edit.change === "create" || edit.change === "write") {
      const written = (edit.hunks[0]?.lines ?? []).map((line) => line.slice(1));
      if (written.length !== model.length || written.some((line, at) => model[at]?.text !== line)) break;
      for (const entry of model) claim(entry, owned);
      if (edit.change === "write") break;
      model = [];
      continue;
    }
    // Undo the hunks last first, so each one's position is still the one its header names.
    const hunks = [...edit.hunks].sort((a, b) => b.newStart - a.newStart);
    const next = undo(model, hunks, owned, claim);
    if (!next) break;
    model = next;
  }
  return owners;
}

/**
 * Where a hunk's new side is in the model, and the lines to undo there. Its leading and trailing context lines only
 * locate it; a formatter often rewrites them, so when the whole hunk is not found, the lines from its first change to
 * its last are looked for on their own, still exactly. A hunk that only deletes has nothing of its own to find.
 */
function place(model: readonly Entry[], hunk: Hunk): { at: number; lines: readonly string[] } | undefined {
  const newSide = (lines: readonly string[]) => lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
  // A hunk that adds nothing names the line before it; the first new line is at `newStart` otherwise.
  const expected = hunk.newLines ? hunk.newStart - 1 : hunk.newStart;
  const whole = locate(model, newSide(hunk.lines), expected);
  if (whole !== -1) return { at: whole, lines: hunk.lines };
  const first = hunk.lines.findIndex((line) => line[0] !== " ");
  const last = hunk.lines.findLastIndex((line) => line[0] !== " ");
  if (first === -1) return undefined;
  const core = hunk.lines.slice(first, last + 1);
  const side = newSide(core);
  if (!side.length) return undefined;
  const at = locate(model, side, expected + first);
  return at === -1 ? undefined : { at, lines: core };
}

/** The model before `hunks` were applied, or undefined when one of them is not where it should be. */
function undo<Owner>(
  model: Entry[],
  hunks: readonly Hunk[],
  owned: Owned<Owner>,
  claim: (entry: Entry | undefined, owned: Owned<Owner>) => void,
): Entry[] | undefined {
  const result = [...model];
  const claimed: Entry[] = [];
  for (const hunk of hunks) {
    const placed = place(result, hunk);
    if (!placed) return undefined;
    const { at, lines } = placed;
    // Context lines keep their entries, so they stay tied to the file on disk; removed lines come back unowned.
    const restored: Entry[] = [];
    let offset = 0;
    for (const line of lines) {
      if (line[0] === "-") restored.push({ text: line.slice(1) });
      else {
        const entry = result[at + offset++];
        if (line[0] === "+") {
          if (entry) claimed.push(entry);
        } else if (entry) restored.push(entry);
      }
    }
    result.splice(at, offset, ...restored);
  }
  // Lines are credited only once every hunk of the edit is found, so a half-found edit claims nothing.
  for (const entry of claimed) claim(entry, owned);
  return result;
}
