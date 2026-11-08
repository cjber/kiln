import { expect, test } from "bun:test";
import { collisionWatch, warn } from "./collisions";
import type { FileEdit, Ledger } from "./edits";
import type { Session } from "./sessions";

const session = (agent: Session["agent"], id: string): Session => ({
  agent,
  id,
  cwd: "/repo",
  startedAt: 0,
  place: { kind: "kiln", name: id },
});
const edit = (id: string, file: string, turn: number): FileEdit => ({ id, file, change: "update", hunks: [], turn });

test("a new edit to a file another running session is working on warns both, once", () => {
  const claude = session("claude", "a");
  const codex = session("codex", "b");
  const ledgers = new Map<Session, Ledger>([
    [claude, { turns: [{ prompt: "p" }], edits: [edit("1", "/repo/x.ts", 0)] }],
    [codex, { turns: [{ prompt: "q" }], edits: [] }],
  ]);
  const read = (session: Session) => ledgers.get(session) as Ledger;
  const watch = collisionWatch();
  // The first read is history: nothing warns.
  expect(watch([claude, codex], read)).toEqual([]);
  (ledgers.get(codex) as Ledger).edits.push(edit("2", "/repo/x.ts", 0), edit("3", "/repo/y.ts", 0));
  const found = watch([claude, codex], read);
  expect(found.map((collision) => [collision.to.id, collision.other.id, collision.file])).toEqual([
    ["b", "a", "/repo/x.ts"],
    ["a", "b", "/repo/x.ts"],
  ]);
  const sent = new Map<string, string>();
  expect(
    warn(found, (_from, to, body, _path, _now, id) => {
      sent.set(id ?? "", `${to}: ${body}`);
      return { id: id ?? "", from: "", to, body, createdAt: 0 };
    }),
  ).toBe(2);
  expect([...sent.values()][0]).toContain("claude:a");
  // A second edit in the same pair of turns has the same keys, so the mailbox keeps one message each.
  (ledgers.get(codex) as Ledger).edits.push(edit("4", "/repo/x.ts", 0));
  expect(watch([claude, codex], read).map((collision) => collision.key)).toEqual(
    found.map((collision) => collision.key),
  );
});

test("a file another session edited for an earlier prompt, or a stopped session, warns nobody", () => {
  const claude = session("claude", "a");
  const codex = session("codex", "b");
  const stopped = { ...session("pi", "c"), lifecycle: "stopped" as const };
  const ledgers = new Map<Session, Ledger>([
    [claude, { turns: [{ prompt: "old" }, { prompt: "new" }], edits: [edit("1", "/repo/x.ts", 0)] }],
    [codex, { turns: [{ prompt: "q" }], edits: [] }],
    [stopped, { turns: [{ prompt: "r" }], edits: [edit("5", "/repo/x.ts", 0)] }],
  ]);
  const read = (session: Session) => ledgers.get(session) as Ledger;
  const watch = collisionWatch();
  watch([claude, codex, stopped], read);
  (ledgers.get(codex) as Ledger).edits.push(edit("2", "/repo/x.ts", 0));
  expect(watch([claude, codex, stopped], read)).toEqual([]);
});
