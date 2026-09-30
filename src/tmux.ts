import { join } from "node:path";

import type { Settings } from "./settings";

/**
 * Kiln's own tmux server. It exists only so a session outlives the moment you
 * leave it: no prefix, and one key (Ctrl+Q by default) is the way back.
 */
const config = join(import.meta.dir, "..", "tmux.conf");
const kiln = join(import.meta.dir, "..", "bin", "kiln");
const tmux = ["tmux", "-L", "kiln", "-f", config];

type Pane = { name: string; pid: number; activityAt: number };

function run(...args: string[]): boolean {
  return Bun.spawnSync([...tmux, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

export async function panes(): Promise<Pane[]> {
  const format = "#{session_name}\t#{pane_pid}\t#{window_activity}";
  const process = Bun.spawn([...tmux, "list-panes", "-a", "-F", format], { stdout: "pipe", stderr: "ignore" });
  if (await process.exited) return [];
  return (await new Response(process.stdout).text()).split("\n").filter(Boolean).map((line) => {
    const [name = "", pid, activity] = line.split("\t");
    return { name, pid: Number(pid), activityAt: Number(activity) * 1000 };
  });
}

export function exists(name: string): boolean {
  // `=` matches the name exactly rather than as a prefix.
  return run("has-session", "-t", `=${name}`);
}

export function start(name: string, cwd: string, argv: string[], title: string): boolean {
  return run("new-session", "-d", "-s", name, "-c", cwd, ...argv) && run("set-option", "-t", name, "@kiln_title", title);
}

/** Rebind the way back, dropping whichever key held it before so a changed setting leaves no stray binding. */
function bindDetach(key: string): void {
  const listed = Bun.spawnSync([...tmux, "list-keys", "-T", "root"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
  for (const line of listed.split("\n")) {
    const match = line.match(/^bind-key\s+(?:-r\s+)?-T root\s+(\S+)\s+detach-client$/);
    if (match?.[1]) run("unbind-key", "-n", match[1]);
  }
  run("bind-key", "-n", key, "detach-client");
}

function applySettings(settings: Settings): void {
  // `-f` only applies when the server starts, so re-read it for a server that predates an edit.
  run("source-file", config);
  bindDetach(settings.detachKey);
  run("set-option", "-g", "status", settings.statusBar ? "on" : "off");
  run("set-option", "-g", "status-right", `#('${kiln}' status)  #[fg=#777777]${settings.detachKey} back `);
}

export function attach(name: string, settings: Settings): void {
  applySettings(settings);
  // Kiln's server is separate from any tmux kiln itself runs in, so the nesting guard does not apply.
  const { TMUX: _outer, ...env } = Bun.env;
  Bun.spawnSync([...tmux, "attach-session", "-t", name], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
}

export function kill(name: string): boolean {
  return run("kill-session", "-t", name);
}
