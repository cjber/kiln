/**
 * For exploratory QA (Bugpatrol): run the list on seeded sessions in a private tmux server, press keys, print the
 * screen. `bun scripts/qa-drive.ts COLS ROWS SEED [key...]`. SEED is `empty`, `short` or `many`. Each key is a tmux key
 * name (`Down`, `Tab`, `Escape`, `C-c`) or literal text (`/`, `j`, `fix`). Nothing reaches a real agent or the
 * user's state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seeds } from "./qa-sessions";

const [cols = "80", rows = "24", seed = "short", ...keys] = Bun.argv.slice(2);
const sessions = seeds[seed];
if (!sessions) throw new Error(`unknown seed ${seed}; use empty, short or many`);

const scratch = mkdtempSync(join(tmpdir(), "kiln-qa-"));
const server = `kiln-qa-${process.pid}`;
const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", server, "-f", "/dev/null", ...args], { stderr: "pipe" });
const pause = (ms: number) => Bun.sleep(ms);
try {
  const state = join(scratch, "sessions.json");
  await Bun.write(state, JSON.stringify(sessions));
  const fixture = resolve(import.meta.dir, "list-tui-fixture.tsx");
  const environment = Object.entries({
    KILN_E2E_SESSIONS: state,
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_STATE_HOME: join(scratch, "state"),
    XDG_DATA_HOME: join(scratch, "data"),
    KILN_TMUX_SERVER: `${server}-agents`,
  }).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  tmux("new-session", "-d", "-s", "qa", "-x", cols, "-y", rows, ...environment, "bun", fixture);
  await pause(2500);
  for (const key of keys) {
    const named = /^([A-Z][A-Za-z0-9]*|[CM]-.)$/.test(key) && key.length > 1;
    tmux("send-keys", "-t", "qa", ...(named ? [key] : ["-l", key]));
    await pause(250);
  }
  await pause(500);
  const screen = tmux("capture-pane", "-p", "-t", "qa").stdout.toString();
  console.log(screen.replace(/\s+$/, ""));
} finally {
  tmux("kill-server");
  // An agent the fixture started would live on its own server; never leave it behind.
  Bun.spawnSync(["tmux", "-L", `${server}-agents`, "kill-server"], { stderr: "ignore" });
  rmSync(scratch, { recursive: true, force: true });
}
