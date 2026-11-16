import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { post } from "./mailbox";
import { flush, spawnReportSender } from "./messages";
import { newOpencodeSessionId } from "./opencode";
import { piExtensionPath } from "./pi-status";
import { recordSpawn, spawnRecord } from "./saved-sessions";
import { type Agent, agentName, agents, listSessions } from "./sessions";
import { loadSettings } from "./settings";
import { ended, endedPane, kiln, panePid, reapEnded, start } from "./tmux";

export const spawnUsage = `usage: kiln msg spawn <agent> [--dir PATH] [--title T] [--model M] -- <prompt>`;

export type SpawnOptions = { agent: Agent; dir: string; title?: string; model?: string; prompt: string };

/** Parse one spawn command; the prompt follows `--`, so a leading dash stays text. */
export function spawnOptions(args: readonly string[], cwd = process.cwd()): SpawnOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { dir: { type: "string" }, title: { type: "string" }, model: { type: "string" } },
  });
  const [agent, ...prompt] = positionals;
  if (!agent || !agents.includes(agent as Agent) || !prompt.length) throw new Error(spawnUsage);
  const requested = values.dir ?? ".";
  const expanded =
    requested === "~" ? homedir() : requested.startsWith("~/") ? resolve(homedir(), requested.slice(2)) : requested;
  const dir = resolve(cwd, expanded);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return { agent: agent as Agent, dir, title: values.title, model: values.model, prompt: prompt.join(" ") };
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
  model?: string,
): string[] {
  const chosen = model ? ["--model", model] : [];
  switch (agent) {
    case "opencode":
      return [...command, "run", "--session", id, ...(title ? ["--title", title] : []), ...chosen, prompt];
    case "claude":
      return [...command, "-p", "--session-id", id, ...(title ? ["--name", title] : []), ...chosen, prompt];
    case "codex":
      return [...command, "exec", ...chosen, prompt];
    case "pi":
      return [...command, "-p", "--session-id", id, ...chosen, "-e", piExtensionPath(), prompt];
  }
}

/** A tmux `pane-died` hook value that runs one command through a shell, quoted for tmux's own parser. */
export function exitHook(argv: readonly string[]): string {
  return `run-shell -b "${shellCommand(argv).replaceAll(/([\\"$`])/g, "\\$1")}"`;
}

/** What a spawned child's exit report says, naming the child and the reason its process printed, if any. */
export function exitMessage(
  child: string,
  title: string | undefined,
  status: number | undefined,
  output: string | undefined,
): string {
  const worked = title ? ` while working on "${title}"` : "";
  const ended =
    status === 0
      ? `Child ${child} finished${worked}.`
      : status === undefined
        ? `Child ${child} ended${worked}.`
        : `Child ${child} exited with status ${status}${worked}.`;
  const reason = output?.trim();
  return reason ? `${ended}\n\nLast output:\n\n${reason}` : ended;
}

function processStartedAt(pid: number): number {
  try {
    return statSync(`/proc/${pid}`).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Start a headless agent in kiln's tmux server and record the calling agent, if any, as its parent. Returns its kiln id. */
export async function spawnAgent(options: SpawnOptions, parent?: string): Promise<string> {
  const command = loadSettings().agents[options.agent];
  if (!command[0] || !Bun.which(command[0]))
    throw new Error(`${command[0] ?? agentName(options.agent)} is not on PATH`);
  const title = options.title ?? `${options.agent} · ${basename(options.dir)}`;

  if (options.agent === "codex") {
    // Codex exec names its own thread only after it starts, so the process itself is its identity.
    const name = `codex-${crypto.randomUUID()}`;
    // The exit hook names the pane; the record made below supplies the id once the process exists.
    const hook = exitHook([kiln, "msg", "exit", name, "", parent ?? ""]);
    if (
      !start(
        name,
        options.dir,
        headlessCommand(command, "codex", "", options.prompt, undefined, options.model),
        title,
        false,
        hook,
      )
    )
      throw new Error(`could not start ${agentName("codex")}`);
    const pid = await panePid(name);
    if (!pid) throw new Error("could not find the Codex process kiln started");
    const id = `${pid}:${processStartedAt(pid)}`;
    recordSpawn({
      agent: "codex",
      id,
      cwd: options.dir,
      title,
      parent,
      startedAt: processStartedAt(pid),
      pid,
      pane: name,
    });
    if (ended(name)) await reportSpawnExit(name, "", parent ?? "");
    return `codex:${id}`;
  }

  const id = options.agent === "opencode" ? newOpencodeSessionId() : crypto.randomUUID();
  // Claude titles its own session from the prompt, and that title outranks the recorded one: name it only when asked.
  const argv = headlessCommand(
    command,
    options.agent,
    id,
    options.prompt,
    options.agent === "claude" ? options.title : title,
    options.model,
  );
  const name = `${options.agent}-${id.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
  const hook = exitHook([kiln, "msg", "exit", name, `${options.agent}:${id}`, parent ?? ""]);
  const startedAt = Date.now();
  if (!start(name, options.dir, argv, title, false, hook))
    throw new Error(`could not start ${agentName(options.agent)}`);
  const pid = await panePid(name);
  recordSpawn({ agent: options.agent, id, cwd: options.dir, title, parent, startedAt, pid, pane: name });
  if (ended(name)) await reportSpawnExit(name, `${options.agent}:${id}`, parent ?? "");
  return `${options.agent}:${id}`;
}

/**
 * A spawned child's process has exited: tell its parent why, so a child that stops on a usage limit is not lost, then
 * close the pane kept for this report. The parent may be gone too; the message then waits in the mailbox.
 */
export async function reportSpawnExit(name: string, _child: string, parent: string): Promise<void> {
  const record = spawnRecord(name);
  // The hook can beat registration. The spawner checks for an already-ended pane after saving its record.
  if (!record) return;
  const identity = `${record.agent}:${record.id}`;
  const separator = identity.indexOf(":");
  const ending = endedPane(name);
  if (!ending) return;
  let recipients: Awaited<ReturnType<typeof listSessions>> = [];
  if (parent) {
    try {
      recipients = await listSessions({ kitty: false });
    } catch {
      // An unavailable discovery source must not prevent an offline mailbox report.
    }
  }
  // Claim cleanup before posting. Only the reporter that removes this exact
  // dead process owns its exit; a replacement during discovery belongs to another run.
  if (!reapEnded(ending)) return;
  if (parent && separator > 0) {
    try {
      post(
        spawnReportSender(identity),
        parent,
        exitMessage(identity, record?.title, ending?.status, ending?.output),
        undefined,
        undefined,
        `exit:${identity}`,
      );
      await flush(recipients);
    } catch {
      // A parent kiln cannot reach right now can still read the message from its mailbox.
    }
  }
  // Provider conversations can be resumed independently of this pane. Exit hooks cannot
  // bind a remote interrupt/archive to its generation, so only explicit close does that.
}
