import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exitHook, exitMessage, headlessCommand, spawnOptions, spawnUsage } from "./spawn";
import { ended, kill, start } from "./tmux";

// A private tmux server, so these tests never touch the real sessions.
Bun.env.KILN_TMUX_SERVER = `kiln-spawn-${process.pid}`;
const paneDir = mkdtempSync(join(tmpdir(), "kiln-spawn-pane-"));
afterAll(() => {
  Bun.spawnSync(["tmux", "-L", `kiln-spawn-${process.pid}`, "kill-server"], { stderr: "ignore" });
  rmSync(paneDir, { recursive: true, force: true });
});

test("spawn takes the agent, an optional directory and title, and the prompt after --", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-spawn-"));
  try {
    expect(
      spawnOptions(["opencode", "--dir", dir, "--title", "fix the tests", "--", "run the API tests", "and fix them"]),
    ).toEqual({
      agent: "opencode",
      dir,
      title: "fix the tests",
      model: undefined,
      prompt: "run the API tests and fix them",
    });
    expect(spawnOptions(["claude", "--", "--not-a-flag"], "/tmp")).toEqual({
      agent: "claude",
      dir: "/tmp",
      title: undefined,
      model: undefined,
      prompt: "--not-a-flag",
    });
    expect(spawnOptions(["claude", "--model", "claude-sonnet-5", "--", "work"], dir).model).toBe("claude-sonnet-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn defaults to the current directory and rejects a missing prompt or agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-spawn-"));
  try {
    expect(spawnOptions(["pi", "--", "check the build"], dir)).toEqual({
      agent: "pi",
      dir: resolve(dir),
      title: undefined,
      model: undefined,
      prompt: "check the build",
    });
    for (const args of [[], ["unknown", "--", "hi"], ["opencode"]])
      expect(() => spawnOptions(args, dir)).toThrow(spawnUsage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headless commands keep the id kiln chose for the child", () => {
  expect(headlessCommand(["opencode"], "opencode", "ses_x", "do the work", "task")).toEqual([
    "opencode",
    "run",
    "--session",
    "ses_x",
    "--title",
    "task",
    "do the work",
  ]);
  expect(headlessCommand(["claude"], "claude", "session-id", "do the work")).toEqual([
    "claude",
    "-p",
    "--session-id",
    "session-id",
    "do the work",
  ]);
  expect(headlessCommand(["claude"], "claude", "session-id", "do the work", "sweep oss")).toEqual([
    "claude",
    "-p",
    "--session-id",
    "session-id",
    "--name",
    "sweep oss",
    "do the work",
  ]);
});

test("a chosen model is passed to every provider's headless command", () => {
  expect(headlessCommand(["claude"], "claude", "id", "work", undefined, "sonnet")).toEqual([
    "claude",
    "-p",
    "--session-id",
    "id",
    "--model",
    "sonnet",
    "work",
  ]);
  expect(headlessCommand(["codex"], "codex", "", "work", undefined, "gpt-5")).toEqual([
    "codex",
    "exec",
    "--model",
    "gpt-5",
    "work",
  ]);
  expect(headlessCommand(["opencode"], "opencode", "ses_1", "work", "task", "provider/model")).toEqual([
    "opencode",
    "run",
    "--session",
    "ses_1",
    "--title",
    "task",
    "--model",
    "provider/model",
    "work",
  ]);
  expect(headlessCommand(["pi"], "pi", "id", "work", undefined, "model")).toEqual([
    "pi",
    "-p",
    "--session-id",
    "id",
    "--model",
    "model",
    "-e",
    expect.any(String),
    "work",
  ]);
});

test("an exit hook quotes its command for tmux and a report names the reason", () => {
  expect(exitHook(["/home/me/bin/kiln", "msg", "exit", "claude-1", "claude:child", "claude:parent"])).toBe(
    'run-shell -b "/home/me/bin/kiln msg exit claude-1 claude:child claude:parent"',
  );
  // A path with spaces stays one word inside the hook's shell command.
  expect(exitHook(["/home/me/kiln bin/kiln", "msg", "exit", "claude-1"])).toBe(
    "run-shell -b \"'/home/me/kiln bin/kiln' msg exit claude-1\"",
  );
  expect(exitMessage("claude:child", "limit child", 1, "You've hit your limit")).toBe(
    'Child claude:child exited with status 1 while working on "limit child".\n\nLast output:\n\nYou\'ve hit your limit',
  );
  expect(exitMessage("claude:child", undefined, 0, undefined)).toBe("Child claude:child finished.");
  expect(exitMessage("claude:child", undefined, undefined, "  ")).toBe("Child claude:child ended.");
});

test("a spawned pane's exit hook runs, and its kept pane reports the status and output", async () => {
  const marker = join(paneDir, "hook-ran");
  expect(
    start(
      "limit-child",
      paneDir,
      ["sh", "-c", "echo you hit the limit; exit 3"],
      "limit child",
      false,
      exitHook(["/usr/bin/touch", marker]),
    ),
  ).toBe(true);
  for (let waited = 0; !existsSync(marker) && waited < 2_000; waited += 50) await Bun.sleep(50);
  expect(existsSync(marker)).toBe(true);
  expect(ended("limit-child")).toEqual({ status: 3, output: "you hit the limit" });
  expect(kill("limit-child")).toBe(true);
});
