import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

import configText from "../tmux.conf" with { type: "text" };

import { withoutFaint } from "./prompt";
import type { Settings } from "./settings";

/** This kiln's own executable: tmux's status bar calls it for `kiln status`, and messages name it for replies. */
export const kiln = import.meta.dir.startsWith("/$bunfs/")
  ? process.execPath
  : join(import.meta.dir, "..", "bin", "kiln");
/** Read on each call, so a test can point kiln at a server of its own. */
const tmux = () => ["tmux", "-L", Bun.env.KILN_TMUX_SERVER || "kiln"];
let config: string | undefined;

/** tmux reads a real file, including when the configuration is embedded in a standalone executable. */
function configPath(): string {
  if (!config) {
    const directory = mkdtempSync(join(tmpdir(), "kiln-"));
    config = join(directory, "tmux.conf");
    writeFileSync(config, configText, { mode: 0o600 });
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  }
  return config;
}

function run(...args: string[]): boolean {
  return Bun.spawnSync([...tmux(), ...args], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

/** The PID of a session's pane command, when tmux can say. */
export async function panePid(name: string): Promise<number | undefined> {
  const shown = Bun.spawnSync([...tmux(), "display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (shown.exitCode !== 0) return undefined;
  const pid = Number(shown.stdout.toString().trim());
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

export async function panes(): Promise<{ name: string; pid: number }[]> {
  const format = "#{session_name}\t#{pane_pid}";
  const process = Bun.spawn([...tmux(), "list-panes", "-a", "-F", format], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => process.kill(), 2_000);
  const [source, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  clearTimeout(timeout);
  if (code) return [];
  return source
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", pid] = line.split("\t");
      return { name, pid: Number(pid) };
    });
}

/**
 * When the person last looked at each session, in milliseconds: the later of its last attach and the last key a
 * client attached to it sent. tmux keeps both to the second.
 */
export async function lastSeen(): Promise<Map<string, number>> {
  const read = async (args: string[]) => {
    try {
      const process = Bun.spawn([...tmux(), ...args], { stdout: "pipe", stderr: "ignore" });
      const timeout = setTimeout(() => process.kill(), 2_000);
      const [source, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
      clearTimeout(timeout);
      return code ? [] : source.split("\n").filter(Boolean);
    } catch {
      // Without tmux nothing has been looked at, and the sessions still list.
      return [];
    }
  };
  const lines = (
    await Promise.all([
      read(["list-sessions", "-F", "#{session_name}\t#{session_last_attached}"]),
      read(["list-clients", "-F", "#{session_name}\t#{client_activity}"]),
    ])
  ).flat();
  const seen = new Map<string, number>();
  for (const line of lines) {
    const [name = "", seconds = ""] = line.split("\t");
    const at = Number(seconds) * 1000;
    if (name && at > (seen.get(name) ?? 0)) seen.set(name, at);
  }
  return seen;
}

/**
 * Paste text into a session's pane as one bracketed paste, then press Enter, as if it were typed. A paste keeps
 * newlines from submitting early; the pause lets the agent's TUI take the paste before the key that sends it.
 */
export async function submitText(name: string, text: string): Promise<void> {
  const buffer = `kiln-${crypto.randomUUID()}`;
  const target = `=${name}:`;
  if (!run("set-buffer", "-b", buffer, "--", text) || !run("paste-buffer", "-p", "-d", "-b", buffer, "-t", target)) {
    run("delete-buffer", "-b", buffer);
    throw new Error(`could not type into ${name}`);
  }
  await Bun.sleep(300);
  if (!run("send-keys", "-t", target, "Enter")) throw new Error(`could not type into ${name}`);
}

/** What a session's pane shows now, wrapped lines joined, with the pane's width in columns. */
export function screen(name: string): { text: string; width: number } | undefined {
  const shown = Bun.spawnSync(
    [
      ...tmux(),
      "display-message",
      "-p",
      "-t",
      `=${name}:`,
      "#{pane_width}",
      ";",
      "capture-pane",
      "-p",
      "-J",
      "-t",
      `=${name}:`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (shown.exitCode !== 0) return undefined;
  const [width = "0", ...text] = shown.stdout.toString().split("\n");
  return { text: text.join("\n"), width: Number(width) };
}

/**
 * Press keys in a session's pane, then paste text if there is some, then press Enter: how a menu option is picked,
 * with what it asks for typed into it.
 */
export async function pick(name: string, keys: string[], text?: string): Promise<void> {
  const target = `=${name}:`;
  if (keys.length && !run("send-keys", "-t", target, ...keys)) throw new Error(`could not type into ${name}`);
  if (text) {
    const buffer = `kiln-${crypto.randomUUID()}`;
    await Bun.sleep(150);
    if (!run("set-buffer", "-b", buffer, "--", text) || !run("paste-buffer", "-p", "-d", "-b", buffer, "-t", target)) {
      run("delete-buffer", "-b", buffer);
      throw new Error(`could not type into ${name}`);
    }
  }
  await Bun.sleep(300);
  if (!run("send-keys", "-t", target, "Enter")) throw new Error(`could not type into ${name}`);
}

/** Press a key in a session's pane, as tmux names it (`Escape`, `Enter`, `C-c`). */
export function sendKey(name: string, key: string): boolean {
  return run("send-keys", "-t", `=${name}:`, key);
}

/** The rows a session's pane shows, unjoined so they line up with the cursor and without faint text, and the cursor's row. */
export function rowsAndCursor(name: string): { rows: string[]; cursorY: number } | undefined {
  const shown = Bun.spawnSync(
    [
      ...tmux(),
      "display-message",
      "-p",
      "-t",
      `=${name}:`,
      "#{cursor_y}",
      ";",
      "capture-pane",
      "-e",
      "-p",
      "-t",
      `=${name}:`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (shown.exitCode !== 0) return undefined;
  const [cursorY = "", ...rows] = shown.stdout.toString().split("\n");
  return { rows: rows.map(withoutFaint), cursorY: Number(cursorY) };
}

/** How many terminals have the session open; none when it has closed. */
export function attachedClients(name: string): number | undefined {
  if (!exists(name)) return undefined;
  const shown = Bun.spawnSync([...tmux(), "display-message", "-p", "-t", `=${name}:`, "#{session_attached}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return shown.exitCode === 0 ? Number(shown.stdout.toString().trim()) : undefined;
}

export function exists(name: string): boolean {
  // `=` matches the name exactly rather than as a prefix.
  return run("has-session", "-t", `=${name}`);
}

/**
 * Start a detached session. With `keep`, its pane stays after the command exits, so `survives` can read why an agent
 * quit at launch; the option is set in the same tmux call that creates the session, before the command can exit.
 * `onExit` is a tmux hook command run from the kept pane after it dies, which is how a spawned child reports itself.
 * `env` is set for the command alone, over what kiln's tmux server has.
 */
export function start(
  name: string,
  cwd: string,
  argv: string[],
  title: string,
  keep = false,
  onExit?: string,
  env: Record<string, string> = {},
): boolean {
  const generation = crypto.randomUUID();
  const environment = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  // Commands after `new-session` in one call act on the new session; `=name` does not resolve it there yet.
  if (onExit) {
    // The hook has to exist before the command can exit, so start a placeholder, set it up, then replace the command.
    if (
      !run(
        "-f",
        configPath(),
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        "sleep",
        "60",
        ";",
        "set-option",
        "-w",
        "remain-on-exit",
        "on",
        ";",
        "set-option",
        "-p",
        "@kiln_generation",
        generation,
        ";",
        "set-hook",
        "-w",
        "pane-died",
        onExit,
        ";",
        "set-option",
        "@kiln_title",
        title,
      )
    )
      return false;
    if (run("respawn-pane", "-k", "-t", `=${name}:`, "-c", cwd, ...environment, "--", ...argv)) return true;
    // The placeholder must not report an exit for an agent that never started.
    run("set-hook", "-u", "-w", "-t", `=${name}:`, "pane-died");
    kill(name);
    return false;
  }
  const kept = keep ? [";", "set-option", "-w", "remain-on-exit", "on"] : [];
  return run(
    "-f",
    configPath(),
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    cwd,
    ...environment,
    ...argv,
    ...kept,
    ";",
    "set-option",
    "-p",
    "@kiln_generation",
    generation,
    ";",
    "set-option",
    "@kiln_title",
    title,
  );
}

/** Replace a live pane command in place, preserving its tmux session and scrollback. */
export function respawn(name: string, cwd: string, argv: string[]): boolean {
  return run(
    "set-option",
    "-p",
    "-t",
    `=${name}:`,
    "@kiln_generation",
    crypto.randomUUID(),
    ";",
    "set-hook",
    "-u",
    "-w",
    "-t",
    `=${name}:`,
    "pane-died",
    ";",
    "set-option",
    "-w",
    "-t",
    `=${name}:`,
    "remain-on-exit",
    "on",
    ";",
    "respawn-pane",
    "-k",
    "-t",
    `=${name}:`,
    "-c",
    cwd,
    "--",
    ...argv,
  );
}

/** The pane a read saw: its id and the generation `start` or `respawn` gave it, which a respawn replaces. */
export type Pane = { pane: string; generation: string };

/** How a kept pane of a session started with `start` ended: its exit status and the output still on screen. */
export type PaneExit = Pane & { status: number; output: string };

/**
 * Read a kept pane's exit, or say its command still runs or its session is gone. tmux marks a pane dead once its terminal
 * closes, which can come before the command exits, so a pane counts as ended only once tmux has its exit status. A dead
 * pane whose command runs on is `closed`. A command killed by a signal has the status a shell gives it, 128 plus the
 * signal number.
 *
 * A tmux built with libutempter, as Debian and Ubuntu ship it, runs a helper when a pane's terminal closes and resets
 * SIGCHLD to its default while it waits for it, so a command that exits meanwhile is never reaped and its status never
 * read. A dead pane without a status sends tmux the SIGCHLD it may have lost; tmux then reaps every exited child, and a
 * command that has exited, `exiting` until then, has its status on the next read. A command whose process cannot be
 * inspected is `unknown`.
 */
function readExit(name: string): PaneExit | Watched | "gone" {
  const target = `=${name}:`;
  const shown = Bun.spawnSync(
    [
      ...tmux(),
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_id}\t#{@kiln_generation}\t#{pid}\t#{pane_pid}",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (shown.exitCode !== 0) return "gone";
  const [dead, status = "", signal = "", pane = "", generation = "", server = "", command = ""] = shown.stdout
    .toString()
    .trimEnd()
    .split("\t");
  // tmux 3.8 exits 0 with empty formats for a session that is not there; every pane has an id.
  if (!pane) return "gone";
  if (dead !== "1") return { waiting: "running", pane, generation };
  if (!status && !signal) {
    try {
      if (Number(server) > 0) process.kill(Number(server), "SIGCHLD");
    } catch {
      // The server can exit after the read; the next read then finds the session gone.
    }
    const exited = hasExited(Number(command));
    return { waiting: exited === undefined ? "unknown" : exited ? "exiting" : "closed", pane, generation };
  }
  const captured = Bun.spawnSync([...tmux(), "capture-pane", "-p", "-J", "-S", "-", "-t", target], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = lastLines(captured.stdout.toString());
  return { status: status ? Number(status) : 128 + signalNumber(signal), output, pane, generation };
}

/** Whether a process has exited, including one its parent has not reaped yet; undefined when its state cannot be read. */
function hasExited(pid: number): boolean | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The state follows the parenthesised command name, which may contain spaces.
    return stat[stat.lastIndexOf(")") + 2] === "Z";
  } catch {
    return undefined;
  }
}

/** tmux names a signal by number on Linux and by name, such as `term`, where the system has signal names. */
function signalNumber(signal: string): number {
  const number = Number(signal);
  if (Number.isInteger(number)) return number;
  return constants.signals[`SIG${signal.toUpperCase()}` as keyof typeof constants.signals] ?? 0;
}

export function endedPane(name: string): PaneExit | undefined {
  const exit = readExit(name);
  return exit === "gone" || "waiting" in exit ? undefined : exit;
}

/**
 * Read a kept pane's state: its exit, why it has none yet, or `gone` once its session is no longer there. A watcher that
 * must tell a running pane from one whose session has closed reads this, where `endedPane` answers only an exit.
 */
export function paneState(name: string): PaneExit | Watched | "gone" {
  return readExit(name);
}

/** Read an exit without exposing tmux's process-generation fields to callers. */
export function ended(name: string): { status: number; output: string } | undefined {
  const exit = endedPane(name);
  return exit ? { status: exit.status, output: exit.output } : undefined;
}

/** Claim an inspected exit inside tmux, so an asynchronous reporter cannot reap a replacement. */
export function reapEnded(exit: PaneExit): boolean {
  return /^[0-9a-f-]{36}$/.test(exit.generation) && onObserved(exit, "#{pane_dead}", `kill-pane -t ${exit.pane}`).acted;
}

/**
 * What `onObserved` did: `acted` when it ran its commands, with what they printed, and `replaced` when a respawn gave
 * the pane a new command since it was read.
 */
type Observed = { acted: true; printed: string } | { acted: false; replaced: boolean };

/**
 * Run tmux `commands` on the pane a read saw, checked inside tmux so a respawn between the read and the action is left
 * alone: only while that pane still has the generation read and `condition`, a tmux format, holds. A pane that is gone
 * counts as not replaced.
 */
function onObserved(seen: Pane, condition: string, commands: string): Observed {
  if (!/^%\d+$/.test(seen.pane) || !/^[0-9a-f-]*$/.test(seen.generation)) return { acted: false, replaced: false };
  const same = `#{==:#{@kiln_generation},${seen.generation}}`;
  const result = Bun.spawnSync(
    [
      ...tmux(),
      "if-shell",
      "-F",
      "-t",
      seen.pane,
      `#{&&:${same},${condition}}`,
      `${commands} ; display-message -p acted`,
      `display-message -p -t ${seen.pane} '#{?${same},kept,replaced}'`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const printed = result.exitCode === 0 ? result.stdout.toString().trimEnd() : "";
  const said = printed.slice(printed.lastIndexOf("\n") + 1);
  if (said === "acted") return { acted: true, printed: printed.slice(0, printed.length - said.length) };
  return { acted: false, replaced: said === "replaced" };
}

/** Why a session's command quit, read from its kept pane. */
type EarlyExit = { status: number; output: string };

/** Why a kept pane has no exit to read yet: its command runs, or its pane is dead without a status, as `readExit` says. */
export type Waiting = "running" | "closed" | "exiting" | "unknown";

/** A kept pane read without an exit, and why. */
export type Watched = Pane & { waiting: Waiting };

/**
 * Watch a session started by `start` with `keep` for `graceMs`. A command still running then is left to close its session as
 * usual when it exits; one that quit is reported with its last output, and its session is closed. One whose exit tmux has
 * not collected by then is reported with status -1. A pane that a respawn gives a new command meanwhile belongs to
 * whoever respawned it: it is left alone and the session counts as running.
 */
export async function survives(name: string, graceMs: number, pollMs = 250): Promise<true | EarlyExit> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const exit = quit(name);
    if (exit === true || "status" in exit) return exit;
    // A command that quit just now is read on the next poll, as is one tmux is still collecting, until the deadline.
    if (Date.now() >= deadline) {
      if (exit.waiting === "exiting") return abandon(exit);
      if (release(exit)) return true;
    }
    await Bun.sleep(pollMs);
  }
}

/**
 * Watch a session started by `start` with `keep` until `started` says its agent is running, or it quits, which is
 * reported as by `survives`. `timeoutMs` only bounds a launch that hangs, such as one waiting on a question: its
 * session is closed and reported with what it shows.
 */
export async function awaitStart(
  name: string,
  started: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 250,
): Promise<true | EarlyExit | { hung: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exit = quit(name);
    if (exit === true || "status" in exit) return exit;
    // The agent can quit while `started` awaits; its kept pane is then read on the next poll.
    if (exit.waiting !== "exiting" && (await started()) && release(exit)) return true;
    if (Date.now() >= deadline) {
      if (exit.waiting === "exiting") return abandon(exit);
      const closed = onObserved(exit, "1", `${capture(exit.pane)} ; kill-session -t ${exit.pane}`);
      if (!closed.acted && closed.replaced) return true;
      return { hung: closed.acted ? lastLines(closed.printed) : "" };
    }
    await Bun.sleep(pollMs);
  }
}

/** The last lines a pane printed, without blank lines or tmux's own "Pane is dead" line below them. */
function lastLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("Pane is dead"))
    .slice(-20)
    .join("\n");
}

/** The tmux command that prints a pane's whole history. */
function capture(pane: string): string {
  return `capture-pane -p -J -S - -t ${pane}`;
}

/**
 * How a kept pane's command quit, closing its session, or why it has not, as `readExit` says. A session that is gone has
 * status -1, and true says a respawn replaced the pane after it was read.
 */
function quit(name: string): EarlyExit | Watched | true {
  const exit = readExit(name);
  if (exit === "gone") return { status: -1, output: "" };
  if ("waiting" in exit) return exit;
  const closed = onObserved(exit, "#{pane_dead}", `kill-session -t ${exit.pane}`);
  if (!closed.acted && closed.replaced) return true;
  return { status: exit.status, output: exit.output };
}

/**
 * Close the session of a command that exited without tmux collecting its status by the deadline, which the nudge in
 * `readExit` should prevent. It is reported with what it printed and status -1, as kiln reports any exit it cannot read.
 * A pane respawned since it was read is left alone, and true says so.
 */
function abandon(seen: Watched): EarlyExit | true {
  const closed = onObserved(seen, "#{pane_dead}", `${capture(seen.pane)} ; kill-session -t ${seen.pane}`);
  if (!closed.acted && closed.replaced) return true;
  return { status: -1, output: closed.acted ? lastLines(closed.printed) : "" };
}

/**
 * Stop keeping a pane whose command still runs, so its session closes as usual when it exits. A pane already dead is
 * kept, checked inside tmux so the command cannot die in between, and false says to read its exit instead. A pane that
 * is already dead without a status, `closed` or `unknown`, is released unless tmux has its status by then: its
 * terminal is already closed, so tmux collects its exit as usual. A pane respawned since it was read is left alone, its
 * new command watched by whoever respawned it, and counts as released.
 */
function release(seen: Watched): boolean {
  const condition = seen.waiting === "running" ? "#{?pane_dead,0,1}" : "#{==:#{pane_dead_status}#{pane_dead_signal},}";
  const released = onObserved(seen, condition, `set-option -w -t ${seen.pane} remain-on-exit off`);
  return released.acted || released.replaced;
}

/** The commands that rebind the way back, dropping whichever key held it before so a changed setting leaves no stray binding. */
function bindDetach(key: string): string[][] {
  const listed = Bun.spawnSync([...tmux(), "list-keys", "-T", "root"], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString();
  const unbind = listed.split("\n").flatMap((line) => {
    const match = line.match(/^bind-key\s+(?:-r\s+)?-T root\s+(\S+)\s+detach-client$/);
    return match?.[1] ? [["unbind-key", "-q", "-n", match[1]]] : [];
  });
  return [...unbind, ["bind-key", "-n", key, "detach-client"]];
}

function applySettings(settings: Settings): boolean {
  // One tmux invocation for the lot; `;` separates its commands. `-f` only applies when the server
  // starts, so the file is re-read for a server that predates an edit.
  const commands = [
    ["source-file", configPath()],
    ...bindDetach(settings.detachKey),
    ["set-option", "-g", "status", settings.statusBar ? "on" : "off"],
    [
      "set-option",
      "-g",
      "status-right",
      `#('${kiln.replaceAll("'", "'\\''")}' status)  #[fg=#777777]${settings.detachKey} back `,
    ],
  ];
  return run(...commands.flatMap((command, index) => (index ? [";", ...command] : command)));
}

/**
 * Hand the terminal to the session until it is detached. stdout is discarded because tmux prints
 * "[detached ...]" there as it leaves, which flashes over the list; the list resumes without
 * the detach banner.
 */
export async function attach(name: string, settings: Settings): Promise<void> {
  if (!applySettings(settings)) throw new Error("could not configure kiln's tmux server");
  // Kiln's server is separate from any tmux kiln itself runs in, so the nesting guard does not apply.
  const { TMUX: _outer, ...env } = Bun.env;
  const client = Bun.spawn([...tmux(), "attach-session", "-t", name], {
    stdin: "inherit",
    stdout: "ignore",
    stderr: "pipe",
    env,
  });
  const [problem, code] = await Promise.all([new Response(client.stderr).text(), client.exited]);
  if (code) throw new Error(problem.trim() || `tmux attach-session exited with status ${code}`);
}
export function kill(name: string): boolean {
  return run("kill-session", "-t", name);
}
