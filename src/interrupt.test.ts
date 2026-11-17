import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interrupt, interruption } from "./messages";
import type { Session } from "./sessions";
import { start } from "./tmux";
import { killServer } from "./tmux-server";

Bun.env.KILN_TMUX_SERVER = `kiln-interrupt-test-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "kiln-interrupt-"));
afterAll(() => {
  killServer(Bun.env.KILN_TMUX_SERVER ?? "");
  rmSync(dir, { recursive: true, force: true });
});

const session = (overrides: Partial<Session>): Session => ({
  agent: "claude",
  id: "c1",
  cwd: dir,
  startedAt: 0,
  activity: "working",
  place: { kind: "kiln", name: "claude-1" },
  ...overrides,
});

test("a kiln pane takes Escape; elsewhere each agent is stopped through its own interface, or says why not", () => {
  expect(interruption(session({}))).toEqual({ via: "tmux" });
  expect(interruption(session({ agent: "pi" }))).toEqual({ via: "tmux" });
  expect(interruption(session({ agent: "codex", place: { kind: "elsewhere" } }))).toEqual({ via: "codex" });
  expect(interruption(session({ agent: "opencode", opencodeService: true }))).toEqual({ via: "opencode" });
  for (const unsupported of [
    session({ place: { kind: "elsewhere" } }),
    session({ agent: "codex", activity: undefined, place: { kind: "elsewhere" } }),
    session({ agent: "opencode" }),
    session({ agent: "pi", place: { kind: "elsewhere" } }),
  ])
    expect("unsupported" in interruption(unsupported)).toBe(true);
});

test("a working Claude session gets Escape in its pane; an idle one is left alone", async () => {
  const keys = join(dir, "keys");
  // The pane reads one raw key, as Claude's prompt does, and records it.
  expect(
    start("claude-1", dir, ["sh", "-c", `stty raw -echo; dd bs=1 count=1 of=${keys} 2>/dev/null; sleep 30`], "c"),
  ).toBe(true);
  await Bun.sleep(300);
  expect(await interrupt(session({ activity: "idle" }))).toBe(false);
  expect(await interrupt(session({}))).toBe(true);
  for (let tries = 0; tries < 50 && !Bun.file(keys).size; tries++) await Bun.sleep(50);
  expect(readFileSync(keys)).toEqual(Buffer.from([0x1b]));
});
