import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import configText from "../tmux.conf" with { type: "text" };

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

/** The rows a session's pane shows, unjoined so they line up with the cursor, and the cursor's row. */
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
      "-p",
      "-t",
      `=${name}:`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (shown.exitCode !== 0) return undefined;
  const [cursorY = "", ...rows] = shown.stdout.toString().split("\n");
  return { rows, cursorY: Number(cursorY) };
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
 */
export function start(
  name: string,
  cwd: string,
  argv: string[],
  title: string,
  keep = false,
  onExit?: string,
): boolean {
  // Commands after `new-session` in one call act on the new session; `=name` does not resolve it there yet.
  const kept = keep || onExit ? [";", "set-option", "-w", "remain-on-exit", "on"] : [];
  const hook = onExit ? [";", "set-hook", "-w", "pane-died", onExit] : [];
  return run(
    "-f",
    configPath(),
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    cwd,
    ...argv,
    ...kept,
    ...hook,
    ";",
    "set-option",
    "@kiln_title",
    title,
  );
}

/** How a kept pane of a session started with `start` ended: its status and the output still on screen. */
export function ended(name: string): { status: number; output: string } | undefined {
  const target = `=${name}:`;
  const shown = Bun.spawnSync([...tmux(), "display-message", "-p", "-t", target, "#{pane_dead}\t#{pane_dead_status}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (shown.exitCode !== 0) return undefined;
  const [dead, status = ""] = shown.stdout.toString().trim().split("\t");
  if (dead !== "1") return undefined;
  const captured = Bun.spawnSync([...tmux(), "capture-pane", "-p", "-J", "-S", "-", "-t", target], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // tmux adds its own "Pane is dead" line below what the command printed.
  const output = captured.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("Pane is dead"))
    .slice(-20)
    .join("\n");
  return { status: Number(status) || 0, output };
}

/** Why a session's command quit, read from its kept pane. */
type EarlyExit = { status: number; output: string };

/**
 * Watch a session started by `start` with `keep` for `graceMs`. A command still running then is left to close its session as
 * usual when it exits; one that quit is reported with its last output, and its session is closed.
 */
export async function survives(name: string, graceMs: number, pollMs = 250): Promise<true | EarlyExit> {
  const target = `=${name}:`;
  const deadline = Date.now() + graceMs;
  for (;;) {
    const shown = Bun.spawnSync(
      [...tmux(), "display-message", "-p", "-t", target, "#{pane_dead}\t#{pane_dead_status}"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (shown.exitCode !== 0) return { status: -1, output: "" };
    const [dead, status = ""] = shown.stdout.toString().trim().split("\t");
    if (dead === "1") {
      const captured = Bun.spawnSync([...tmux(), "capture-pane", "-p", "-J", "-S", "-", "-t", target], {
        stdout: "pipe",
        stderr: "pipe",
      });
      kill(name);
      // tmux adds its own "Pane is dead" line below what the command printed.
      const lines = captured.stdout
        .toString()
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("Pane is dead"));
      const output = lines.slice(-20).join("\n");
      return { status: Number(status) || 0, output };
    }
    if (Date.now() >= deadline) {
      run("set-option", "-w", "-t", target, "remain-on-exit", "off");
      return true;
    }
    await Bun.sleep(pollMs);
  }
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
