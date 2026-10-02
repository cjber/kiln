import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Session } from "../src/sessions";

import { driver } from "./tuistory";

// Pin the external PTY driver without adding it to kiln's runtime or binary.
const scratch = mkdtempSync(join(tmpdir(), "kiln-tui-e2e-"));
const name = `kiln-e2e-${process.pid}`;
const state = join(scratch, "sessions.json");
const output = resolve(Bun.env.KILN_E2E_OUTPUT ?? join(tmpdir(), "kiln-tui-e2e-evidence"));
mkdirSync(output, { recursive: true });
const rows: Session[] = [
  {
    agent: "codex",
    id: "parent",
    title: "Review changes",
    cwd: "/tmp/atlas",
    activity: "waiting",
    startedAt: 1,
    place: { kind: "kiln", name: "parent" },
  },
  {
    agent: "codex",
    id: "child",
    parentSessionId: "parent",
    title: "Check tests",
    cwd: "/tmp/atlas",
    activity: "waiting",
    startedAt: 2,
    place: { kind: "kiln", name: "child" },
  },
  {
    agent: "claude",
    title: "Finished task",
    cwd: "/tmp/blog",
    activity: "idle",
    startedAt: 3,
    place: { kind: "kiln", name: "finished" },
  },
  {
    agent: "pi",
    title: "Unknown status",
    cwd: "/tmp/dotfiles",
    startedAt: 4,
    place: { kind: "kiln", name: "pi" },
  },
  {
    agent: "claude",
    title: "Background job",
    cwd: "/tmp/dotfiles",
    lifecycle: "completed",
    startedAt: 5,
    place: { kind: "job", id: "0b276145", attach: ["claude", "attach", "0b276145"] },
  },
];
const drive = driver(name, 19474);
const screen = () => drive("snapshot", "--trim");
async function press(key: string, expected: string) {
  await drive("press", key);
  const frame = await screen();
  assert.ok(frame.includes(expected), `${key}: expected ${expected}\n${frame}`);
}
try {
  await Bun.write(state, JSON.stringify(rows));
  await drive(
    "--cols",
    "100",
    "--rows",
    "18",
    "--env",
    `KILN_E2E_SESSIONS=${state}`,
    "--",
    "bun",
    "scripts/list-tui-fixture.tsx",
  );
  await drive("wait", "Review changes");
  assert.ok((await screen()).includes("2 need input"));
  assert.ok((await drive("snapshot", "--trim", "--fg", "#e5c46b")).includes("Review changes"));
  assert.ok((await drive("snapshot", "--trim", "--fg", "#e78a53")).includes("/tmp/atlas"));
  assert.ok((await drive("snapshot", "--trim", "--fg", "#6a9955")).includes("Finished task"));
  assert.match(await drive("snapshot", "--trim", "--fg", "#6a9955"), /Background job\s+completed/);
  assert.ok((await drive("snapshot", "--trim", "--fg", "#5f8787")).includes("codex"));
  assert.ok((await drive("snapshot", "--trim", "--fg", "#e78a53")).includes("claude"));
  await drive("screenshot", "-o", join(output, "tui-actions.png"));
  await press("tab", "Check tests");
  await press("j", "needs your input");
  await press("g", "Review changes");
  await press("x", "close");
  await press("esc", "q quit");
  await press("/", "type to filter");
  await drive("type", "Unknown status");
  assert.ok((await screen()).includes("status unavailable from provider"));
  await press("esc", "Review changes");
  for (const order of ["last active", "age", "harness", "directory", "directory / task"]) await press("o", order);
  await press("n", "[claude]");
  await press("l", "[codex]");
  await press("esc", "q quit");
  await press("S", "kiln skills");
  await press("esc", "Review changes");
  for (const row of rows) if (row.activity === "waiting") row.activity = "idle";
  await Bun.write(state, JSON.stringify(rows));
  await press("r", "ready");
  assert.ok(!(await screen()).includes("need input"));
  await drive("resize", "52", "12");
  await drive("wait", "q quit", "--timeout", "5000");
  assert.ok((await screen()).includes("q quit"));
  await drive("screenshot", "-o", join(output, "tui-narrow.png"));
  await drive("press", "q");
  console.log(`PTY E2E passed; screenshots: ${output}`);
} finally {
  await drive("close").catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}
