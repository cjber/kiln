import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import configText from "../tmux.conf" with { type: "text" };

import type { Settings } from "./settings";

/**
 * Kiln's own tmux server. It exists only so a session outlives the moment you
 * leave it: no prefix, and one key (Ctrl+Q by default) is the way back.
 */
const kiln = import.meta.dir.startsWith("/$bunfs/") ? process.execPath : join(import.meta.dir, "..", "bin", "kiln");
const tmux = ["tmux", "-L", "kiln"];
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

type Pane = { name: string; pid: number };

function run(...args: string[]): boolean {
  return Bun.spawnSync([...tmux, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

export async function panes(): Promise<Pane[]> {
  const format = "#{session_name}\t#{pane_pid}";
  const process = Bun.spawn([...tmux, "list-panes", "-a", "-F", format], { stdout: "pipe", stderr: "ignore" });
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

export function exists(name: string): boolean {
  // `=` matches the name exactly rather than as a prefix.
  return run("has-session", "-t", `=${name}`);
}

export function start(name: string, cwd: string, argv: string[], title: string): boolean {
  return (
    run("-f", configPath(), "new-session", "-d", "-s", name, "-c", cwd, ...argv) &&
    run("set-option", "-t", name, "@kiln_title", title)
  );
}

/** Rebind the way back, dropping whichever key held it before so a changed setting leaves no stray binding. */
function bindDetach(key: string): void {
  const listed = Bun.spawnSync([...tmux, "list-keys", "-T", "root"], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString();
  for (const line of listed.split("\n")) {
    const match = line.match(/^bind-key\s+(?:-r\s+)?-T root\s+(\S+)\s+detach-client$/);
    if (match?.[1]) run("unbind-key", "-n", match[1]);
  }
  run("bind-key", "-n", key, "detach-client");
}

function applySettings(settings: Settings): void {
  // `-f` only applies when the server starts, so re-read it for a server that predates an edit.
  run("source-file", configPath());
  bindDetach(settings.detachKey);
  run("set-option", "-g", "status", settings.statusBar ? "on" : "off");
  run(
    "set-option",
    "-g",
    "status-right",
    `#('${kiln.replaceAll("'", "'\\''")}' status)  #[fg=#777777]${settings.detachKey} back `,
  );
}

export async function attach(name: string, settings: Settings): Promise<void> {
  applySettings(settings);
  // Kiln's server is separate from any tmux kiln itself runs in, so the nesting guard does not apply.
  const { TMUX: _outer, ...env } = Bun.env;
  await Bun.spawn([...tmux, "attach-session", "-t", name], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  }).exited;
}

export function kill(name: string): boolean {
  return run("kill-session", "-t", name);
}
