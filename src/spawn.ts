import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudeConfig, type LaunchOutcome, settleLaunch, trustClaudeWorkspace } from "./claude-trust";
import { promptArguments } from "./launcher";
import { post } from "./mailbox";
import { flush, spawnReportSender } from "./messages";
import { codexThreadId } from "./native-sessions";
import { newOpencodeSessionId } from "./opencode";
import { piExtensionPath } from "./pi-status";
import { recordSpawn, spawnRecord } from "./saved-sessions";
import { type Agent, agentName, agents, listSessions } from "./sessions";
import { loadSettings } from "./settings";
import { ended, kill, kiln, panePid, paneState, reapEnded, start } from "./tmux";

export const spawnUsage = `usage: kiln msg spawn <agent> [--dir PATH] [--title T] [--model M] [--interactive] -- <prompt>`;

export type SpawnOptions = {
  agent: Agent;
  dir: string;
  title?: string;
  model?: string;
  prompt: string;
  /** Start the agent's full terminal UI, so a person can attach and watch it, instead of its headless mode. */
  interactive?: boolean;
};

/** Parse one spawn command; the prompt follows `--`, so a leading dash stays text. */
export function spawnOptions(args: readonly string[], cwd = process.cwd()): SpawnOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      title: { type: "string" },
      model: { type: "string" },
      interactive: { type: "boolean" },
    },
  });
  const [agent, ...prompt] = positionals;
  if (!agent || !agents.includes(agent as Agent) || !prompt.length) throw new Error(spawnUsage);
  const requested = values.dir ?? ".";
  const expanded =
    requested === "~" ? homedir() : requested.startsWith("~/") ? resolve(homedir(), requested.slice(2)) : requested;
  const dir = resolve(cwd, expanded);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  if (values.interactive && agent !== "claude") throw new Error("--interactive is supported for claude only");
  return {
    agent: agent as Agent,
    dir,
    title: values.title,
    model: values.model,
    prompt: prompt.join(" "),
    interactive: values.interactive,
  };
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
      // Print mode stops background work (workflows, monitors, shells) 10 minutes after the last turn. A spawned
      // child is meant to run to completion, and its kiln row and exit report already show one that hangs.
      return [
        "env",
        "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0",
        ...command,
        "-p",
        "--session-id",
        id,
        ...(title ? ["--name", title] : []),
        ...chosen,
        prompt,
      ];
    case "codex":
      return [...command, "exec", ...chosen, prompt];
    case "pi":
      return [...command, "-p", "--session-id", id, ...chosen, "-e", piExtensionPath(), prompt];
  }
}

/**
 * Claude's interactive command for a conversation whose id kiln already chose. It stays open after its turns, so
 * its parent hears of its exit only when the session is closed. It runs with `configDir`, the Claude config dir kiln
 * trusted its folder in, or with none (the home default) when that is undefined, whatever kiln's tmux server has.
 */
export function interactiveClaudeCommand(
  command: readonly string[],
  id: string,
  prompt: string,
  title?: string,
  model?: string,
  configDir?: string,
): string[] {
  return [
    "env",
    ...(configDir ? [`CLAUDE_CONFIG_DIR=${configDir}`] : ["-u", "CLAUDE_CONFIG_DIR"]),
    ...command,
    "--session-id",
    id,
    ...(title ? ["--name", title] : []),
    ...(model ? ["--model", model] : []),
    ...promptArguments("claude", prompt),
  ];
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

/** How long a spawn waits for Codex to start its thread. It bounds a run that hangs before then. */
const codexThreadWaitMs = 30_000;

/**
 * The thread a spawned Codex run works in. Codex chooses the id itself as it starts and holds that thread's writer
 * lock until it exits, so the lock names the thread exactly. Undefined when the process exits, or hangs, first.
 */
export async function spawnedCodexThread(pid: number, waitMs = codexThreadWaitMs): Promise<string | undefined> {
  for (const deadline = Date.now() + waitMs; ; await Bun.sleep(25)) {
    const thread = codexThreadId(pid);
    if (thread || !existsSync(`/proc/${pid}`) || Date.now() >= deadline) return thread;
  }
}

/** How long a spawn waits for an interactive Claude to start under its launcher and register its session. */
const claudeStartWaitMs = 30_000;

/** How many times a spawn starts an interactive Claude that lands on a config dir that had not trusted its folder. */
const claudeLaunches = 3;

/**
 * Make sure the interactive Claude a spawn started reads a config that trusts its folder, so it reads its prompt
 * instead of waiting at the trust dialog. Kiln trusted the folder in the config dir it passed, but a launcher such as a
 * multi-account wrapper can choose another one after it starts. When the launch reaches a config that had not trusted
 * the folder, kiln trusts it there and starts Claude again, because Claude reads trust only as it starts. Returns the
 * pane's process; throws, closing the session, when every launch lands on an untrusted config.
 */
async function settleClaudeTrust(
  name: string,
  id: string,
  options: SpawnOptions,
  argv: string[],
  title: string,
  hook: string,
): Promise<number | undefined> {
  for (let launch = 1; ; launch++) {
    const pid = await panePid(name);
    if (!pid) return pid;
    let outcome: LaunchOutcome;
    try {
      outcome = await settleLaunch(pid, id, options.dir, claudeStartWaitMs);
    } catch (error) {
      kill(name);
      throw error;
    }
    // Registered, ended or still starting: every config the launch reached trusts the folder, so the dialog is not
    // what holds it.
    if (outcome !== "untrusted") return pid;
    kill(name);
    if (launch === claudeLaunches)
      throw new Error(
        `Claude started ${launch} times under a config dir that had not trusted ${options.dir}; it is trusted in each now`,
      );
    if (!start(name, options.dir, argv, title, false, hook)) throw new Error(`could not start ${agentName("claude")}`);
  }
}

/** How often the exit watcher reads its pane. */
const watchIntervalMs = 500;

/**
 * Report a spawned child's exit without its `pane-died` hook, which a tmux built with libutempter can miss: tmux runs
 * its utmp helper with SIGCHLD reset to its default, so a command that exits then is never reaped, the pane stays dead
 * without a status and the hook never fires. Reading the pane sends tmux the SIGCHLD it may have lost, so its exit is
 * collected and reported with its real status. It stops once the session is gone, however it went, or a respawn
 * replaces the command it watched.
 */
export async function watchSpawnExit(
  name: string,
  child: string,
  parent: string,
  intervalMs = watchIntervalMs,
): Promise<void> {
  let generation: string | undefined;
  for (;;) {
    const seen = paneState(name);
    // A pane's session can be gone before its exit is read: a person closed it, tmux restarted, or a tmux without
    // remain-on-exit removed it as its command ended. The record still names the child and its parent, so the watcher
    // reports it as ended instead of returning silently (#240).
    if (seen === "gone") {
      await reportSpawnExit(name, child, parent);
      return;
    }
    // A respawn drops the pane's hook and gives it a command that belongs to whoever respawned it, so it is left alone.
    generation ??= seen.generation;
    if (seen.generation !== generation) return;
    if (!("waiting" in seen)) {
      await reportSpawnExit(name, child, parent);
      return;
    }
    await Bun.sleep(intervalMs);
  }
}

/**
 * Start that watcher as its own process, so it outlives the spawner and a person's shell. The hook stays the fast path;
 * a watcher that cannot start only loses the fallback, and the hook still reports an exit it sees.
 */
function watchInBackground(name: string, child: string, parent: string): void {
  try {
    Bun.spawn([kiln, "msg", "watch", name, child, parent], {
      // Its own session, so a hangup or a group kill that ends the spawner's shell or tool call leaves it running.
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
    // The hook still reports an exit on a tmux that fires it; nothing else is needed here.
  }
}

/** Start a headless agent in kiln's tmux server and record the calling agent, if any, as its parent. Returns its kiln id. */
export async function spawnAgent(options: SpawnOptions, parent?: string): Promise<string> {
  const command = loadSettings().agents[options.agent];
  if (!command[0] || !Bun.which(command[0]))
    throw new Error(`${command[0] ?? agentName(options.agent)} is not on PATH`);
  const title = options.title ?? `${options.agent} · ${basename(options.dir)}`;

  if (options.agent === "codex") {
    // Codex exec names its own thread only after it starts, so the pane is named before the id is known.
    const name = `codex-${crypto.randomUUID()}`;
    // The exit hook names the pane; the record made below supplies the id once the thread exists.
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
    const startedAt = processStartedAt(pid);
    // The thread id names the rollout, which stays readable after the process exits. A run that ends or hangs before
    // starting its thread has no rollout, and keeps the name of its process.
    const id = (await spawnedCodexThread(pid)) ?? `${pid}:${startedAt}`;
    recordSpawn({
      agent: "codex",
      id,
      cwd: options.dir,
      title,
      parent,
      startedAt,
      pid,
      pane: name,
    });
    watchInBackground(name, "", parent ?? "");
    if (ended(name)) await reportSpawnExit(name, "", parent ?? "");
    return `codex:${id}`;
  }

  const id = options.agent === "opencode" ? newOpencodeSessionId() : crypto.randomUUID();
  // An interactive Claude waits at its trust dialog, never reading the prompt, in a folder its config has not trusted.
  // Only the directory the spawner named is trusted, in the config dir this spawn runs Claude with. A headless Claude
  // (`-p`) never asks, so this grants an interactive child what a headless one in the same folder already has.
  const configDir = Bun.env.CLAUDE_CONFIG_DIR || undefined;
  if (options.interactive) await trustClaudeWorkspace(options.dir, claudeConfig(Bun.env).json);
  // Claude titles its own session from the prompt, and that title outranks the recorded one: name it only when asked.
  const argv = options.interactive
    ? interactiveClaudeCommand(command, id, options.prompt, options.title, options.model, configDir)
    : headlessCommand(
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
  const pid = options.interactive ? await settleClaudeTrust(name, id, options, argv, title, hook) : await panePid(name);
  recordSpawn({ agent: options.agent, id, cwd: options.dir, title, parent, startedAt, pid, pane: name });
  watchInBackground(name, `${options.agent}:${id}`, parent ?? "");
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
  const seen = paneState(name);
  // A pane whose session is gone has no exit left to read, but the child still ended: report it as ended rather than
  // dropping the notice (#240). A replaced pane belongs to another run, so it is not reported.
  const ending = seen === "gone" || "waiting" in seen ? undefined : seen;
  if (!ending && seen !== "gone") return;
  // A spawn from a shell, a timer or a detached worker records no caller, but the parent found for it later by process
  // ancestry is in the record, so an exit report still reaches the session that started the child.
  const to = parent || record.parent || "";
  let recipients: Awaited<ReturnType<typeof listSessions>> = [];
  if (to) {
    try {
      recipients = await listSessions({ kitty: false });
    } catch {
      // An unavailable discovery source must not prevent an offline mailbox report.
    }
  }
  // Claim cleanup before posting. Only the reporter that removes this exact
  // dead process owns its exit; a replacement during discovery belongs to another run.
  // A pane whose session is gone has nothing to claim, and the message id makes a second reporter's post a no-op.
  if (ending && !reapEnded(ending)) return;
  if (to && separator > 0) {
    try {
      post(
        spawnReportSender(identity),
        to,
        exitMessage(identity, record.title, ending?.status, ending?.output),
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
