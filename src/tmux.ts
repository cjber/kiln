import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import configText from "../tmux.conf" with { type: "text" };

import type { Settings } from "./settings";

/**
 * Native sessions and the Codex Cloud viewer outlive attachment in a private server.
 * Ctrl+Q returns to the list without closing the agent.
 */
const kiln = import.meta.dir.startsWith("/$bunfs/") ? process.execPath : join(import.meta.dir, "..", "bin", "kiln");
const tmux = ["tmux", "-L", Bun.env.KILN_TMUX_SERVER || "kiln"];
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
  return Bun.spawnSync([...tmux, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

export async function panes(): Promise<{ name: string; pid: number }[]> {
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

/** The commands that rebind the way back, dropping whichever key held it before so a changed setting leaves no stray binding. */
function bindDetach(key: string): string[][] {
  const listed = Bun.spawnSync([...tmux, "list-keys", "-T", "root"], {
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
  const client = Bun.spawn([...tmux, "attach-session", "-t", name], {
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
