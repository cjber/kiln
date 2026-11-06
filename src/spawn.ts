import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { newOpencodeSessionId } from "./opencode";
import { piExtensionPath } from "./pi-status";
import { recordSpawn } from "./saved-sessions";
import { type Agent, agentName, agents } from "./sessions";
import { loadSettings } from "./settings";
import { kiln, panePid, start } from "./tmux";

export const spawnUsage = `usage: kiln msg spawn <agent> [--dir PATH] [--title T] -- <prompt>`;

export type SpawnOptions = { agent: Agent; dir: string; title?: string; prompt: string };

/** Parse one spawn command; the prompt follows `--`, so a leading dash stays text. */
export function spawnOptions(args: readonly string[], cwd = process.cwd()): SpawnOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { dir: { type: "string" }, title: { type: "string" } },
  });
  const [agent, ...prompt] = positionals;
  if (!agent || !agents.includes(agent as Agent) || !prompt.length) throw new Error(spawnUsage);
  const requested = values.dir ?? ".";
  const expanded =
    requested === "~" ? homedir() : requested.startsWith("~/") ? resolve(homedir(), requested.slice(2)) : requested;
  const dir = resolve(cwd, expanded);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return { agent: agent as Agent, dir, title: values.title, prompt: prompt.join(" ") };
}

/** One shell word, quoted so a prompt or a path cannot split into another command. */
function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export function shellCommand(argv: readonly string[]): string {
  return argv.map(quote).join(" ");
}

/** The provider's headless command for a conversation whose id kiln already chose. */
export function headlessCommand(
  command: readonly string[],
  agent: Agent,
  id: string,
  prompt: string,
  title?: string,
): string[] {
  switch (agent) {
    case "opencode":
      return [...command, "run", "--session", id, ...(title ? ["--title", title] : []), prompt];
    case "claude":
      return [...command, "-p", "--session-id", id, prompt];
    case "codex":
      return [...command, "exec", prompt];
    case "pi":
      return [...command, "-p", "--session-id", id, "-e", piExtensionPath(), prompt];
  }
}

function processStartedAt(pid: number): number {
  try {
    return statSync(`/proc/${pid}`).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Start a headless agent in kiln's tmux server and record the caller as its parent. Returns its kiln id. */
export async function spawnAgent(options: SpawnOptions, parent: string): Promise<string> {
  const command = loadSettings().agents[options.agent];
  if (!command[0] || !Bun.which(command[0]))
    throw new Error(`${command[0] ?? agentName(options.agent)} is not on PATH`);
  const title = options.title ?? `${options.agent} · ${basename(options.dir)}`;

  if (options.agent === "codex") {
    // Codex exec names its own thread only after it starts, so the process itself is its identity.
    const name = `codex-${crypto.randomUUID()}`;
    if (!start(name, options.dir, headlessCommand(command, "codex", "", options.prompt), title))
      throw new Error(`could not start ${agentName("codex")}`);
    const pid = await panePid(name);
    if (!pid) throw new Error("could not find the Codex process kiln started");
    const id = `${pid}:${processStartedAt(pid)}`;
    recordSpawn({ agent: "codex", id, cwd: options.dir, title, parent, startedAt: processStartedAt(pid), pid });
    return `codex:${id}`;
  }

  const id = options.agent === "opencode" ? newOpencodeSessionId() : crypto.randomUUID();
  const argv = headlessCommand(command, options.agent, id, options.prompt, title);
  const name = `${options.agent}-${id.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
  const started = options.agent === "opencode";
  // A spawned OpenCode run is archived when it exits, so its row does not outlive the work it did.
  const running = started
    ? ["sh", "-c", `${shellCommand(argv)}; ${shellCommand([kiln, "msg", "archive", `opencode:${id}`])}`]
    : argv;
  const startedAt = Date.now();
  if (!start(name, options.dir, running, title)) throw new Error(`could not start ${agentName(options.agent)}`);
  const pid = await panePid(name);
  recordSpawn({ agent: options.agent, id, cwd: options.dir, title, parent, startedAt, pid });
  return `${options.agent}:${id}`;
}
