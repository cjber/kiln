import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { headlessCommand, spawnOptions, spawnUsage } from "./spawn";

test("spawn takes the agent, an optional directory and title, and the prompt after --", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-spawn-"));
  try {
    expect(
      spawnOptions(["opencode", "--dir", dir, "--title", "fix the tests", "--", "run the API tests", "and fix them"]),
    ).toEqual({ agent: "opencode", dir, title: "fix the tests", prompt: "run the API tests and fix them" });
    expect(spawnOptions(["claude", "--", "--not-a-flag"], "/tmp")).toEqual({
      agent: "claude",
      dir: "/tmp",
      title: undefined,
      prompt: "--not-a-flag",
    });
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
