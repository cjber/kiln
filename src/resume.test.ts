import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeStopped } from "./launcher";
import { pickSessions } from "./resume-cli";
import type { Session } from "./sessions";
import { defaults } from "./settings";
import { exists, start, survives } from "./tmux";

// A private tmux server, so these tests never touch the real sessions.
Bun.env.KILN_TMUX_SERVER = `kiln-test-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "kiln-resume-"));
afterAll(() => {
  Bun.spawnSync(["tmux", "-L", `kiln-test-${process.pid}`, "kill-server"], { stderr: "ignore" });
  rmSync(dir, { recursive: true, force: true });
});

const stopped = (id: string, agent: Session["agent"] = "claude"): Session => ({
  agent,
  id,
  cwd: dir,
  startedAt: 1,
  lifecycle: "stopped",
  place: { kind: "saved" },
});

test("a kept pane reports why its command quit, and a running one is left alone", async () => {
  expect(start("quits", dir, ["sh", "-c", "echo no login; exit 3"], "quits", true)).toBe(true);
  expect(await survives("quits", 2_000, 50)).toEqual({ status: 3, output: "no login" });
  expect(exists("quits")).toBe(false);
  expect(start("runs", dir, ["sleep", "30"], "runs", true)).toBe(true);
  expect(await survives("runs", 300, 50)).toBe(true);
  expect(exists("runs")).toBe(true);
});

test("a resumed agent that quits at launch is started once more", async () => {
  const marker = join(dir, "tried");
  const flaky = `if [ -e ${marker} ]; then sleep 30; else touch ${marker}; echo lock busy; exit 1; fi`;
  const settings = { ...defaults, remoteControl: false, agents: { ...defaults.agents, claude: ["sh", "-c", flaky] } };
  const result = await resumeStopped(stopped("flaky"), settings, undefined, 400);
  expect(result).toHaveProperty("name");
  expect(exists((result as { name: string }).name)).toBe(true);
});

test("an agent that keeps quitting is reported with what it printed", async () => {
  const settings = {
    ...defaults,
    remoteControl: false,
    agents: { ...defaults.agents, claude: ["sh", "-c", "echo config locked; exit 2"] },
  };
  expect(await resumeStopped(stopped("broken"), settings, undefined, 400)).toEqual({
    problem: "Claude exited with status 2: config locked",
  });
});

test("names pick stopped sessions by whole name or unique prefix", () => {
  const rows = [stopped("abc123"), stopped("abd456"), stopped("abc123", "codex")];
  expect(pickSessions(rows, ["claude:abc"], "stopped")).toEqual([rows[0] as Session]);
  expect(pickSessions(rows, ["abd"], "stopped")).toEqual([rows[1] as Session]);
  expect(() => pickSessions(rows, ["abc"], "stopped")).toThrow("more than one");
  expect(() => pickSessions(rows, ["zzz"], "stopped")).toThrow('no stopped session "zzz"');
});
