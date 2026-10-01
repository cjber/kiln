/**
 * End-to-end check of kiln's list and tmux hand-over on a real PTY.
 *
 *   bun scripts/tui-e2e.ts [--evidence DIR] [--only NAME]
 *
 * An outer scratch tmux server supplies the PTY and runs scripts/tui-fixture.tsx (the production App with
 * fixture sessions) in a scratch HOME. A wrapper `tmux` redirects `-L kiln` to a second scratch server, so
 * the user's own tmux is never touched. `capture-pane` is the screen; `pipe-pane` keeps every byte the TUI
 * writes in DIR/<scenario>/raw.bin, which is where a flash between frames (tmux's "[detached ...]") shows.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmux = Bun.which("tmux");
if (!tmux) throw new Error("tui-e2e needs tmux on PATH");
const fixture = join(import.meta.dir, "tui-fixture.tsx");
const flags = process.argv.slice(2);
const flag = (name: string) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
const only = flag("--only");
if (only && !["functional", "failed-attach", "large"].includes(only)) throw new Error(`unknown scenario: ${only}`);
const base = flag("--evidence") ?? mkdtempSync(join(tmpdir(), "kiln-e2e-evidence-"));
const NAV_LIMIT_MS = 1_000;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const SESSION_SCRIPT = (marker: string) =>
  `echo ${marker}; while IFS= read -r l; do if [ "$l" = size ]; then echo "SIZE:$(stty size)"; else echo "GOT_${marker}:$l"; fi; done`;

type Row = Record<string, unknown>;
const row = (title: string, cwd: string, agent: string, place: Row, extra: Row = {}): Row => ({
  title,
  agent,
  cwd,
  startedAt: 1_700_000_000_000,
  lastActiveAt: Date.now(),
  place,
  ...extra,
});

let rigs = 0;

class Rig {
  private readonly id = `${process.pid}-${rigs++}`;
  readonly outer = `kiln-e2e-outer-${this.id}`;
  readonly inner = `kiln-e2e-inner-${this.id}`;
  readonly scratch = mkdtempSync(join(tmpdir(), "kiln-e2e-"));
  readonly raw: string;
  private readonly env: Record<string, string>;

  constructor(
    readonly evidence: string,
    rows: Row[],
  ) {
    mkdirSync(evidence, { recursive: true });
    this.raw = join(evidence, "raw.bin");
    writeFileSync(this.raw, "");
    const { TMUX: _outer, ...inherited } = Bun.env;
    const home = this.scratch;
    this.env = {
      ...(inherited as Record<string, string>),
      HOME: home,
      XDG_CONFIG_HOME: `${home}/.config`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      CODEX_HOME: `${home}/.codex`,
      PI_CODING_AGENT_DIR: `${home}/.pi/agent`,
      XDG_RUNTIME_DIR: `${home}/runtime`,
      PATH: `${home}/bin:${Bun.env.PATH}`,
      TERM: "xterm-256color",
      KILN_FIXTURE_SESSIONS: `${home}/sessions.json`,
    };
    mkdirSync(`${home}/bin`);
    mkdirSync(`${home}/runtime`, { mode: 0o700 });
    for (const name of ["pgrep", "kitty"]) writeFileSync(`${home}/bin/${name}`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(`${home}/bin/claude`, '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
    mkdirSync(`${home}/.config/kiln`, { recursive: true });
    writeFileSync(
      `${home}/.config/kiln/config.toml`,
      'detach_key = "C-g"\nzoxide = false\ncloud = false\nremote_control = false\nnotifications = false\n',
    );
    writeFileSync(`${home}/sessions.json`, JSON.stringify(rows));
    writeFileSync(
      `${home}/bin/tmux`,
      `#!/bin/sh\nif [ "$1" = -L ] && [ "$2" = kiln ]; then\n  shift 2\n  exec ${quote(tmux as string)} -L ${quote(this.inner)} "$@"\nfi\nexec ${quote(tmux as string)} "$@"\n`,
      { mode: 0o755 },
    );
  }

  private run(server: string, args: string[]): string {
    const result = Bun.spawnSync([tmux as string, "-L", server, ...args], {
      env: this.env,
      cwd: this.scratch,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    if (result.exitCode !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr.toString().trim()}`);
    return result.stdout.toString();
  }

  /** A session of kiln's private server that echoes input, for the list to open. */
  session(name: string, marker: string): void {
    this.run(this.inner, [
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "100",
      "-y",
      "24",
      "sh",
      "-c",
      SESSION_SCRIPT(marker),
    ]);
  }

  /** Start the fixture in the outer pane, recording its output from the first byte. */
  start(rows: number, cols: number): void {
    const gate = `go-${this.id}`;
    const launch = `${quote(tmux as string)} -L ${this.outer} wait-for ${gate} && exec ${quote(process.execPath)} ${quote(fixture)}`;
    this.run(this.outer, [
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "ui",
      "-x",
      String(cols),
      "-y",
      String(rows),
      launch,
    ]);
    this.run(this.outer, ["pipe-pane", "-o", "-t", "ui", `cat >> ${quote(this.raw)}`]);
    this.run(this.outer, ["wait-for", "-S", gate]);
  }

  resize(rows: number, cols: number): void {
    this.run(this.outer, ["resize-window", "-t", "ui", "-x", String(cols), "-y", String(rows)]);
  }

  screen(): string {
    return this.run(this.outer, ["capture-pane", "-p", "-t", "ui"]).trimEnd();
  }

  /** Text goes through literally; key names (Enter, Tab, C-g) go as keys. */
  type(text: string): void {
    this.run(this.outer, ["send-keys", "-l", "-t", "ui", text]);
  }

  key(...names: string[]): void {
    this.run(this.outer, ["send-keys", "-t", "ui", ...names]);
  }

  snapshot(name: string): void {
    writeFileSync(join(this.evidence, `${name}.txt`), `${this.screen()}\n`);
  }

  /** Milliseconds until `text` is on screen (or, with `absent`, gone). */
  async wait(text: string, what: string, absent = false, deadlineMs = 15_000): Promise<number> {
    const began = performance.now();
    for (;;) {
      const screen = this.screen();
      if (screen.includes(text) !== absent) return performance.now() - began;
      if (performance.now() - began > deadlineMs) throw new Error(`timed out ${what}: screen was\n${screen}`);
      await Bun.sleep(15);
    }
  }

  /** Ask the session for its size until it reports `text`; tmux resizes the pane after the terminal does. */
  async waitForSize(text: string, what: string): Promise<void> {
    const end = Date.now() + 15_000;
    for (;;) {
      this.type("size");
      this.key("Enter");
      try {
        await this.wait(text, what, false, 500);
        return;
      } catch (error) {
        if (Date.now() > end) throw error;
      }
    }
  }

  /** Whatever tmux prints on leaving is a flash on the terminal even when a later frame covers it. */
  async checkRaw(): Promise<void> {
    await Bun.sleep(200);
    const raw = readFileSync(this.raw, "latin1");
    for (const needle of ["[detached", "[exited", "[lost server"]) {
      const at = raw.indexOf(needle);
      if (at >= 0)
        throw new Error(
          `raw terminal output contains ${needle} at byte ${at}: ${JSON.stringify(raw.slice(Math.max(0, at - 60), at + 60))}`,
        );
    }
  }

  stop(): void {
    for (const server of [this.outer, this.inner])
      Bun.spawnSync([tmux as string, "-L", server, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
        timeout: 10_000,
      });
    rmSync(this.scratch, { recursive: true, force: true });
  }
}

async function functional(evidence: string): Promise<object> {
  const cwd = "/tmp/kiln-e2e-cwd";
  const rig = new Rig(evidence, [
    row("Alpha one", cwd, "claude", { kind: "kiln", name: "one" }, { pid: 9001, activity: "working" }),
    row("Beta two", `${cwd}/other`, "codex", { kind: "kiln", name: "two" }, { pid: 9002, activity: "idle" }),
    row("Alpha child", cwd, "claude", { kind: "elsewhere", source: "pid 9003" }, { pid: 9003, parentSessionPid: 9001 }),
    row("Gamma gone", `${cwd}/gone`, "pi", { kind: "elsewhere", source: "pid 1" }, { pid: 9004 }),
  ]);
  const timings: Record<string, number> = {};
  const ms = (value: number) => Math.round(value);
  try {
    rig.session("one", "SESSION_ONE");
    rig.session("two", "SESSION_TWO");
    rig.start(24, 100);
    timings.list = ms(await rig.wait("q quit", "first list"));
    await rig.wait("Alpha one", "row Alpha one");
    rig.snapshot("list");
    if (rig.screen().includes("Alpha child")) throw new Error("child shown while its parent is collapsed");

    rig.key("Tab");
    await rig.wait("Alpha child", "expanding the parent");
    rig.key("Tab");
    await rig.wait("Alpha child", "collapsing the parent", true);

    rig.key("o");
    await rig.wait("last active", "sort cycle");
    rig.key("o", "o", "o", "o");
    await rig.wait("directory / task", "sort back to project");

    rig.type("/Beta");
    await rig.wait("/Beta", "filter echo");
    await rig.wait("Alpha one", "filter hiding non-matches", true);
    rig.key("Escape");
    await rig.wait("Alpha one", "filter cleared");

    // An unopenable child stays reachable under its parent and only reports why.
    rig.key("Tab");
    await rig.wait("Alpha child", "expanding for the unavailable child");
    rig.type("j");
    rig.key("Enter");
    await rig.wait("cannot open", "notice for an unavailable child");
    rig.type("k");
    rig.key("Tab");
    await rig.wait("Alpha child", "collapsing after the unavailable probe", true);

    rig.key("Enter");
    timings.open_one = ms(await rig.wait("SESSION_ONE", "opening session one"));
    rig.snapshot("attached-one");
    rig.type("hello");
    rig.key("Enter");
    await rig.wait("GOT_SESSION_ONE:hello", "input reaching session one");
    rig.resize(30, 120);
    await rig.waitForSize("SIZE:29 120", "pane following the resize");
    rig.snapshot("attached-one-resized");

    rig.key("C-g");
    timings.detach_one = ms(await rig.wait("q quit", "list after detach with the configured key"));
    await rig.wait("SESSION_ONE", "session text leaving the screen", true);
    rig.snapshot("list-after-detach");

    rig.type("j");
    rig.key("Enter");
    timings.open_two = ms(await rig.wait("SESSION_TWO", "opening session two"));
    rig.type("two");
    rig.key("Enter");
    await rig.wait("GOT_SESSION_TWO:two", "input reaching session two");
    rig.key("C-g");
    await rig.wait("q quit", "list after second detach");
    await rig.wait("SESSION_TWO", "session two leaving the screen", true);
    rig.type("k");
    rig.key("Enter");
    await rig.wait("SESSION_ONE", "reopening session one");
    rig.key("C-g");
    await rig.wait("q quit", "list after reopen");

    rig.resize(18, 80);
    await rig.wait("Alpha one", "list after resize");
    await rig.checkRaw();
    rig.type("q");
    return timings;
  } finally {
    rig.stop();
  }
}

/** A row whose tmux session is gone: the hand-over fails and the list says so without breaking. */
async function failedAttach(evidence: string): Promise<object> {
  const rig = new Rig(evidence, [row("Orphan", "/tmp", "claude", { kind: "kiln", name: "missing" }, { pid: 9100 })]);
  try {
    rig.session("other", "OTHER"); // a running server, so tmux names the missing session
    rig.start(24, 100);
    await rig.wait("Orphan", "the orphan row");
    rig.key("Enter");
    await rig.wait("can't find session: missing", "a notice naming the failed attach");
    rig.snapshot("failed-attach");
    rig.key("j"); // any key clears the notice, so the list is still taking input
    await rig.wait("q quit", "the list responding after the failed attach");
    await rig.checkRaw();
    return {};
  } finally {
    rig.stop();
  }
}

async function large(evidence: string): Promise<object> {
  const rows = Array.from({ length: 500 }, (_, index) => {
    const dir = Math.floor(index / 10);
    return row(
      `task-${String(dir).padStart(2, "0")}-${String(index % 10).padStart(2, "0")}`,
      `/tmp/kiln-e2e-proj-${String(dir).padStart(2, "0")}`,
      ["claude", "codex", "pi"][index % 3] as string,
      { kind: "kiln", name: `missing-${index}` },
      { pid: 20_000 + index, activity: "idle" },
    );
  });
  const rig = new Rig(evidence, rows);
  try {
    const started = performance.now();
    rig.start(30, 100);
    await rig.wait("500 tasks", "500 rows listed");
    const first = performance.now() - started;
    rig.snapshot("large-list");
    const samples: [string, number][] = [];
    const press = async (label: string, send: () => void) => {
      const observe = () => {
        const screen = rig.screen();
        if (label.startsWith("sort") || label.startsWith("filter")) return screen.split("\n")[0];
        return screen.match(/›\s+(task-\d+-\d+)/)?.[1];
      };
      const before = observe();
      const began = performance.now();
      send();
      while (observe() === before) {
        if (performance.now() - began > 5_000) throw new Error(`no response to ${label}`);
        await Bun.sleep(10);
      }
      samples.push([label, performance.now() - began]);
    };
    const keys = (name: string, count: number, key: string) =>
      Array.from({ length: count }, (_, index) => [`${name}${index}`, () => rig.key(key)] as const);
    const plan = [
      ...keys("j", 40, "j"),
      ...keys("k", 10, "k"),
      ["G", () => rig.key("G")],
      ["g", () => rig.key("g")],
      ["ctrl-d", () => rig.key("C-d")],
      ["ctrl-u", () => rig.key("C-u")],
      ["sort", () => rig.key("o")],
      ["sort2", () => rig.key("o")],
    ] as const;
    for (const [label, send] of plan) await press(label, send);
    rig.type("/");
    await rig.wait("type to filter", "filter mode");
    for (const letter of "tas") await press(`filter-${letter}`, () => rig.type(letter));
    rig.snapshot("large-filter");
    const ordered = samples.map(([, ms]) => ms).sort((a, b) => a - b);
    const [worstKey, worst] = samples.reduce((a, b) => (b[1] > a[1] ? b : a));
    const result = {
      first_list_ms: Math.round(first),
      keys: samples.length,
      median_ms: Math.round(ordered[Math.floor(ordered.length / 2)] as number),
      worst_ms: Math.round(worst),
      worst_key: worstKey,
    };
    if (worst >= NAV_LIMIT_MS)
      throw new Error(`navigation took ${Math.round(worst)} ms (limit ${NAV_LIMIT_MS}): ${JSON.stringify(result)}`);
    return result;
  } finally {
    rig.stop();
  }
}

const scenarios = { functional, "failed-attach": failedAttach, large };
let failed = false;
for (const [name, scenario] of Object.entries(scenarios)) {
  if (only && only !== name) continue;
  const began = performance.now();
  const evidence = join(base, name);
  try {
    console.log(
      `${name}: PASS ${JSON.stringify(await scenario(evidence))} (${((performance.now() - began) / 1000).toFixed(1)}s)`,
    );
  } catch (error) {
    failed = true;
    console.log(`${name}: FAIL ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`evidence: ${base}`);
process.exit(failed ? 1 : 0);
