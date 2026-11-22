import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultAccount } from "./accounts";
import { agyConversationId } from "./agy";
import { claudeConfigDir } from "./claude-inbox";
import { claudeConfig, type LaunchOutcome, settleLaunch, trustClaudeWorkspace } from "./claude-trust";
import { agentCommand, claudeCommand, promptArguments } from "./launcher";
import { detectLimit } from "./limits";
import { isPeer, outboxPath, pending, post, posted } from "./mailbox";
import { findRecipient, flush, spawnReportSender } from "./messages";
import { afterMuseWord } from "./muse";
import { codexThreadId } from "./native-sessions";
import { newOpencodeSessionId } from "./opencode";
import { piExtensionPath } from "./pi-status";
import { forgetReads, readQuota } from "./quota";
import { type Route, routed, routeNew } from "./routing";
import { forget, recordSpawn, restoreRow, type Saved, savedRow, spawnRecord } from "./saved-sessions";
import { type Agent, agentName, agents, isFullName, listSessions, type Session, sessionIdentity } from "./sessions";
import { loadSettings, type Settings } from "./settings";
import { recordSpent } from "./spent";
import {
  ended,
  endedPane,
  exists,
  hasExited,
  kill,
  kiln,
  panePid,
  paneState,
  reapEnded,
  respawn,
  screen,
  start,
  survives,
  tmuxServer,
} from "./tmux";
import { readTranscript } from "./transcript";

export const spawnUsage = `usage: kiln msg spawn <agent> [--dir PATH | --resume ID] [--title T] [--model M] [--account NAME] [--interactive] [--as <@peer>] [--json] -- <prompt>`;

export type SpawnOptions = {
  agent: Agent;
  dir: string;
  title?: string;
  model?: string;
  prompt: string;
  /** Start the agent's full terminal UI, so a person can attach and watch it, instead of its headless mode. */
  interactive?: boolean;
  /** Run on this account of the agent instead of the one with the most headroom. */
  account?: string;
  /** Accounts a run of this brief already used up, which the pick skips; set by a failover. */
  tried?: string[];
  /** A Claude conversation to carry on, in the directory it was started in, instead of starting a new one. */
  resume?: { id: string; codeMode: boolean; title?: string };
};

/**
 * The Claude conversation `id` names: the directory Claude started it in, which `--resume` must run from, and what its
 * transcript says. Claude files it under that directory, which the id does not carry, so it is found by the id alone.
 */
function claudeConversation(
  id: string,
): { cwd: string; codeMode: boolean; title?: string; refusedAt?: number } | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return undefined;
  const root = join(claudeConfigDir(), "projects");
  let path: string | undefined;
  try {
    for (const match of new Bun.Glob(`*/${id}.jsonl`).scanSync({ cwd: root, absolute: true })) path = match;
  } catch {
    // No projects directory holds no conversations.
  }
  if (!path) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const { cwd } = JSON.parse(line);
      if (typeof cwd === "string") {
        const { codeMode, title, limited } = readTranscript(path);
        return { cwd, codeMode: codeMode === true, title, refusedAt: limited?.at };
      }
    } catch {
      // A line still being written is skipped.
    }
  }
  return undefined;
}

/** A spawn command's flags that pick its parent and its output rather than how the child runs. */
export type SpawnCommand = SpawnOptions & {
  /** The peer that hears the child's reports and exit, in place of the calling session. */
  as?: string;
  /** Print the child's name and directory as JSON. */
  json?: boolean;
};

/** Parse one spawn command; the prompt follows `--`, so a leading dash stays text. */
export function spawnOptions(args: readonly string[], cwd = process.cwd()): SpawnCommand {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      title: { type: "string" },
      model: { type: "string" },
      account: { type: "string" },
      interactive: { type: "boolean" },
      resume: { type: "string" },
      as: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const [agent, ...prompt] = positionals;
  if (!agent || !agents.includes(agent as Agent) || !prompt.length) throw new Error(spawnUsage);
  let resume: SpawnOptions["resume"];
  let requested = values.dir ?? ".";
  if (values.resume !== undefined) {
    if (agent !== "claude") throw new Error("--resume is supported for claude only");
    // Claude finds a conversation only from the directory it began in, so that directory is not the spawner's choice.
    if (values.dir !== undefined) throw new Error("--resume runs in the conversation's own directory; drop --dir");
    const id = values.resume.replace(/^claude:/, "");
    const found = claudeConversation(id);
    if (!found) throw new Error(`no Claude conversation ${id}`);
    // Claude runs Code Mode only in its interactive terminal, so a headless resume exits 1 after kiln reported success.
    // An interactive child reports its exit only when closed, so a headless caller would lose its report: refuse.
    if (found.codeMode && !values.interactive)
      throw new Error(
        `Claude conversation ${id} was started in Code Mode, which runs only in the interactive terminal; resume it with --interactive`,
      );
    resume = { id, codeMode: found.codeMode, title: found.title };
    requested = found.cwd;
  }
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
    account: values.account,
    prompt: prompt.join(" "),
    interactive: values.interactive,
    ...(resume ? { resume } : {}),
    ...(values.as === undefined ? {} : { as: values.as }),
    ...(values.json ? { json: true } : {}),
  };
}

/** One shell word, quoted so a prompt or a path cannot split into another command. */
function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export function shellCommand(argv: readonly string[]): string {
  return argv.map(quote).join(" ");
}

/**
 * The provider's headless command for a conversation whose id kiln already chose. `writable` is granted to Codex with
 * `--add-dir`; a Claude command carries its grant already, from {@link claudeGrants}.
 */
export function headlessCommand(
  command: readonly string[],
  agent: Agent,
  id: string,
  prompt: string,
  title?: string,
  model?: string,
  resume?: SpawnOptions["resume"],
  writable: readonly string[] = [],
): string[] {
  const chosen = model ? ["--model", model] : [];
  const granted = writable.flatMap((directory) => ["--add-dir", directory]);
  switch (agent) {
    case "opencode":
      return [...command, "run", "--session", id, ...(title ? ["--title", title] : []), ...chosen, prompt];
    case "claude":
      // Print mode stops background work (workflows, monitors, shells) 10 minutes after the last turn. A spawned
      // child is meant to run to completion, and its kiln row and exit report already show one that hangs.
      return [
        "env",
        "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0",
        ...claudeCodeMode(resume),
        ...claudeCommand(command, resume?.codeMode === true),
        "-p",
        ...claudeSession(id, resume),
        ...(title ? ["--name", title] : []),
        ...chosen,
        prompt,
      ];
    case "codex": {
      // Codex refuses a directory that is neither a git repository nor one its config trusts, and the spawner chose
      // this one. The flag belongs to `exec` and may appear only once, so one the configured command passes moves there.
      const skip = "--skip-git-repo-check";
      return [...command.filter((word) => word !== skip), "exec", skip, ...chosen, ...granted, prompt];
    }
    case "pi":
      return [...command, "-p", "--session-id", id, ...chosen, "-e", piExtensionPath(), prompt];
    case "agy":
      // Print mode runs one turn and exits; its answer is what the pane prints, so the exit report carries it.
      return [...command, "-p", prompt, ...chosen];
    case "muse": {
      // `exec` directly follows the muse word, after any wrapper: root options before it never start a session.
      const at = afterMuseWord(command);
      // Muse skips an untrusted workspace's AGENTS.md, project skills and delegation, which a Claude or Codex child in
      // the same folder loads. `--trust-workspace` trusts it for this run only and saves nothing.
      return [
        ...command.slice(0, at),
        "exec",
        "--trust-workspace",
        ...command.slice(at),
        "--session-id",
        id,
        ...chosen,
        prompt,
      ];
    }
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
  resume?: SpawnOptions["resume"],
): string[] {
  return [
    "env",
    ...(configDir ? [`CLAUDE_CONFIG_DIR=${configDir}`] : ["-u", "CLAUDE_CONFIG_DIR"]),
    ...claudeCodeMode(resume),
    ...claudeCommand(command, resume?.codeMode === true),
    ...claudeSession(id, resume),
    ...(title ? ["--name", title] : []),
    ...(model ? ["--model", model] : []),
    ...promptArguments("claude", prompt),
  ];
}

/**
 * `command`, Claude's configured command, granting `writable` to the sandbox its commands run in. `--add-dir` would
 * also give the session the folder, and asks first whether to trust it whenever the folder is inside something Claude
 * takes for a repository (any parent holding a `.git`), which holds an interactive child at that prompt. The sandbox's
 * `allowWrite` asks nothing: https://code.claude.com/docs/en/sandboxing#configure-sandboxing. Claude reads only the last
 * `--settings`, so one the command already passes, inline or a file Claude would read from `dir`, carries the grant.
 */
export function claudeGrants(command: readonly string[], dir: string, writable: readonly string[]): string[] {
  if (!writable.length) return [...command];
  const at = command.findLastIndex((word) => word === "--settings" || word.startsWith("--settings="));
  const joined = at >= 0 && command[at] !== "--settings";
  const given = at < 0 ? "{}" : joined ? command[at]?.slice("--settings=".length) : command[at + 1];
  if (given === undefined) throw new Error("the Claude command in kiln's config ends with --settings and no value");
  const text = given.trimStart().startsWith("{") ? given : readFileSync(resolve(dir, given), "utf8");
  const object = (value: unknown): Record<string, unknown> => {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    if (value === undefined) return {};
    throw new Error(`the --settings given to Claude, ${given}, is not a JSON object where kiln adds its sandbox grant`);
  };
  const settings = object(JSON.parse(text));
  const sandbox = object(settings.sandbox);
  const filesystem = object(sandbox.filesystem);
  const allowed = Array.isArray(filesystem.allowWrite) ? filesystem.allowWrite : [];
  const granted = {
    ...settings,
    sandbox: { ...sandbox, filesystem: { ...filesystem, allowWrite: [...allowed, ...writable] } },
  };
  const rest = at < 0 ? command.length : at + (joined ? 1 : 2);
  return [
    ...command.slice(0, at < 0 ? command.length : at),
    "--settings",
    JSON.stringify(granted),
    ...command.slice(rest),
  ];
}

/** Claude starts a conversation under the id kiln chose, or carries one on under its own id. */
function claudeSession(id: string, resume: SpawnOptions["resume"]): string[] {
  return [resume ? "--resume" : "--session-id", id];
}

/** Claude resumes a conversation started in Code Mode only with Code Mode on. */
function claudeCodeMode(resume: SpawnOptions["resume"]): string[] {
  return resume?.codeMode ? ["CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1"] : [];
}

/**
 * The git metadata of the linked worktree `dir` is in, which lies outside it: the worktree's own git directory and the
 * main repository's objects, refs and logs, which a commit writes. The rest of the shared directory, its `hooks/` and
 * `config`, stays out, since a write there runs code in every checkout of the repository. The refs and objects are
 * shared, so the child can move or delete any branch, as Claude's sandbox lets a child in a worktree do already, and as
 * a commit from a worktree needs: git writes a branch through a lock file beside its siblings. The worktree's own directory
 * holds `commondir`, so a child could point git in that worktree at a config it wrote; that reaches only git run in the
 * worktree, where the child already writes the files a person or a gate will run. A plain checkout has none.
 */
function worktreeMetadata(dir: string): string[] {
  const found = Bun.spawnSync(
    ["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  if (found.exitCode !== 0) return [];
  const [own, common] = found.stdout.toString().trim().split("\n");
  if (!own || !common || own === common) return [];
  return [own, ...["objects", "refs", "logs"].map((part) => join(common, part)).filter((path) => existsSync(path))];
}

/**
 * The directories a child's agent sandbox must let it write besides its own: the outbox it sends
 * from, and for Codex the worktree's git metadata, which Codex otherwise keeps read-only so `git commit` fails. Claude's
 * sandbox already opens a worktree's shared `.git` for a session started in the worktree. The other agents run their
 * commands unsandboxed.
 */
export function spawnGrants(agent: Agent, dir: string, outbox: string): string[] {
  switch (agent) {
    case "claude":
      return [outbox];
    case "codex":
      return [outbox, ...worktreeMetadata(dir)];
    case "opencode":
    case "pi":
    case "muse":
    case "agy":
      return [];
  }
}

/** The messages a child left in its outbox, oldest first. */
function outboxFiles(box: string): string[] {
  try {
    return readdirSync(outboxPath(box))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Post what a sandboxed child left in its outbox as from that child. Its sandbox hid the sessions, so the name it gave
 * is resolved here, against `sessions`; one that finds no session now waits under the name as given. Each file posts
 * under its own id, so the watcher and the exit hook relaying it together post it once.
 */
function drainOutbox(box: string, from: string, sessions: readonly Session[] | undefined): number {
  let posted = 0;
  for (const file of outboxFiles(box)) {
    const path = join(outboxPath(box), file);
    let message: { to?: unknown; body?: unknown } = {};
    try {
      message = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Only a finished write is renamed to .json, so one that does not parse is not a message.
    }
    if (typeof message.to === "string" && typeof message.body === "string") {
      let [sender, to, body] = [from, message.to, message.body];
      // Without discovery only a full name or a peer can be addressed; any other waits in the outbox for a pass that has
      // it. A peer is a mailbox, never a session, so its name is posted as given.
      if (!sessions) {
        if (!isFullName(message.to) && !isPeer(message.to)) continue;
      } else if (!isPeer(message.to))
        try {
          to = sessionIdentity(findRecipient(sessions, message.to));
        } catch (error) {
          // A full name waits in the mailbox for a session that is not running now. Any other name finds no one, and the
          // child was told only that it was queued, so it hears back why the message went nowhere.
          if (!isFullName(message.to))
            [sender, to, body] = notice(
              from,
              message.to,
              error instanceof Error ? error.message : String(error),
              message.body,
            );
        }
      // Its sandbox hid the child's own name from it, so it is checked here.
      if (sender === from && to === from) [sender, to, body] = notice(from, to, "you cannot message yourself", body);
      try {
        post(sender, to, body, undefined, undefined, `outbox:${box}:${file}`);
      } catch {
        // A send limit or a locked mailbox leaves it, and the rest after it, for the next pass.
        return posted;
      }
      posted++;
    }
    rmSync(path, { force: true });
  }
  return posted;
}

/** What a child that sent from its outbox hears back when its message reached no one: the reason, then what it sent. */
function notice(child: string, to: string, reason: string, body: string): [string, string, string] {
  return [spawnReportSender(child), child, `Your message to ${to} was not delivered: ${reason}\n\n${body}`];
}

/**
 * Relay a child's outbox and deliver what it sent. Returns whether anything still waits: a message the mailbox refused,
 * or one to a parent that is answering a question, so the watcher tries again later.
 */
async function relayOutbox(boxes: readonly string[], from: string): Promise<boolean> {
  let sessions: Session[] | undefined;
  try {
    // Only a whole list: a name that a failed listing left out would be called unknown to the child that sent to it.
    sessions = await listSessions({ kitty: false }, false, true);
  } catch {
    // The messages stay in the outbox for the next pass.
  }
  for (const box of boxes) drainOutbox(box, from, sessions);
  for (const box of boxes.slice(1)) releaseOutbox(box);
  // Only what these outboxes posted: an earlier run's exit report to a parent that is gone is not this watcher's to retry.
  const ours = (message: { id: string }) => boxes.some((box) => message.id.startsWith(`outbox:${box}:`));
  const waiting = pending().filter(ours);
  const left = () => boxes.some((box) => outboxFiles(box).length > 0);
  if (!sessions || !waiting.length) return left() || waiting.length > 0;
  try {
    const outcomes = await flush(sessions, { recipients: new Set(waiting.map((message) => message.to)) });
    return left() || outcomes.some((outcome) => !outcome.delivered && ours(outcome.message));
  } catch {
    return true;
  }
}

/** Remove an outbox once it holds no message, with the mount points Codex's sandbox left in it. */
function releaseOutbox(box: string): void {
  clearMountPoints([outboxPath(box)]);
  try {
    rmdirSync(outboxPath(box));
  } catch {
    // Gone already, or holding a message kiln could not relay yet, which a resumed run relays.
  }
}

/**
 * Codex's sandbox makes an empty directory in each root it grants for every name it protects there (`.codex`,
 * `.agents`, `.git`), as a mount point, and leaves it behind. Git never gives an entry of its own a leading dot in a
 * granted git directory, and an outbox holds only messages, so an empty one there is Codex's, and goes once the child
 * has exited. Another Codex child of the same repository may still mount over one; removing it only lets that child
 * write a name git never reads.
 */
function clearMountPoints(dirs: readonly string[]): void {
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.filter((entry) => entry.startsWith(".")))
      try {
        rmdirSync(join(dir, entry));
      } catch {
        // Not empty, or not a directory: not a mount point.
      }
  }
}

/**
 * The outbox a run sends from. A resumed child keeps its pane name, so the outbox is named for the run too: the
 * previous run's reporter, clearing its own, must not remove the one the new run's sandbox was granted.
 */
const outboxKey = (pane: string, run: string) => (run ? `${pane}.${run}` : pane);

/**
 * The outboxes a run relays: its own, then any an earlier run in the pane left holding a message it could not relay.
 * A resumed child is the same conversation, so it relays those as the same sender. A pane name has no dot.
 */
function paneOutboxes(pane: string, run: string): string[] {
  const box = outboxKey(pane, run);
  try {
    return [
      box,
      ...readdirSync(dirname(outboxPath(box))).filter((entry) => entry !== box && entry.startsWith(`${pane}.`)),
    ];
  } catch {
    return [box];
  }
}

/** How long the exit watcher waits before trying again to deliver a message its child sent that could not go yet. */
const relayRetryMs = 5_000;

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

/**
 * The mailbox id of one run's exit report. A resumed child keeps its conversation id, so the start time its spawn
 * recorded tells one run's exit from the next, while the hook and the watcher reporting the same run share one id and
 * so post one message.
 */
export function exitReportId(record: Pick<Saved, "agent" | "id" | "startedAt">): string {
  return `exit:${record.agent}:${record.id}:${record.startedAt}`;
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
  return spawnedConversation(pid, codexThreadId, waitMs);
}

/** The conversation a spawned run holds open once it starts one; an Antigravity run names its own, as Codex does. */
export async function spawnedConversation(
  pid: number,
  find: (pid: number) => string | undefined,
  waitMs = codexThreadWaitMs,
): Promise<string | undefined> {
  for (const deadline = Date.now() + waitMs; ; await Bun.sleep(25)) {
    const thread = find(pid);
    // An exited run that tmux has not reaped yet is gone too, so a lost SIGCHLD does not hold the wait to its deadline.
    if (thread || hasExited(pid) !== false || Date.now() >= deadline) return thread;
  }
}

/** How long a spawn waits for tmux to read the status of a command that has exited. */
const exitReadWaitMs = 1_000;

/**
 * The exit of a pane whose command has ended, or undefined while it runs or once its session is gone. A command that has
 * exited before tmux read its status (`exiting`, see {@link paneState}) has it on a later read, so that is waited for.
 */
async function settledExit(name: string): Promise<{ status: number; output: string } | undefined> {
  for (const deadline = Date.now() + exitReadWaitMs; ; await Bun.sleep(25)) {
    const seen = paneState(name);
    if (seen === "gone") return undefined;
    if (!("waiting" in seen)) return seen;
    if (seen.waiting !== "exiting" || Date.now() >= deadline) return undefined;
  }
}

/**
 * An interactive Claude in a home whose `.claude.json` exists without `hasCompletedOnboarding` opens its first-run
 * theme picker and never reads the prompt, so the spawn is refused up front with the way out. A missing or unreadable
 * file says nothing about the home and is left to the start deadline.
 */
export function assertOnboarded(json: string, configDir: string | undefined): void {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(json, "utf8"));
  } catch {
    return;
  }
  if (
    typeof config !== "object" ||
    config === null ||
    (config as Record<string, unknown>).hasCompletedOnboarding === true
  )
    return;
  throw new Error(
    `Claude's first-run setup is not finished in ${json}, so an interactive spawn would stop at its theme picker. ` +
      `Run \`${configDir ? `CLAUDE_CONFIG_DIR=${configDir} ` : ""}claude\` once and finish setup (or wait if the home is being migrated), then spawn again`,
  );
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
 * pane's process; throws, closing the session, when every launch lands on an untrusted config or Claude has not
 * registered its session by the deadline, which is how a startup dialog kiln does not answer holds it.
 */
export async function settleClaudeTrust(
  name: string,
  id: string,
  options: Pick<SpawnOptions, "dir">,
  argv: string[],
  title: string,
  hook: string,
  waitMs = claudeStartWaitMs,
  env: Record<string, string> = {},
): Promise<number | undefined> {
  for (let launch = 1; ; launch++) {
    const pid = await panePid(name);
    if (!pid) return pid;
    let outcome: LaunchOutcome;
    try {
      outcome = await settleLaunch(pid, id, options.dir, waitMs);
    } catch (error) {
      kill(name);
      throw error;
    }
    if (outcome === "unregistered") {
      const shown = (screen(name)?.text ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
      kill(name);
      throw new Error(
        `Claude had not started its session after ${waitMs / 1000} s, so kiln closed it. If its screen below shows a prompt kiln does not answer, run \`claude\` once in this account's home, answer it, then spawn again. Its screen showed:\n${shown}`,
      );
    }
    // Registered or ended: every config the launch reached trusts the folder, so the dialog is not what holds it.
    if (outcome !== "untrusted") return pid;
    kill(name);
    if (launch === claudeLaunches)
      throw new Error(
        `Claude started ${launch} times under a config dir that had not trusted ${options.dir}; it is trusted in each now`,
      );
    if (!start(name, options.dir, argv, title, false, hook, env))
      throw new Error(`could not start ${agentName("claude")}`);
  }
}

/**
 * The command a pane's exit hook or its exit watcher runs. Neither runs in the spawner's process: the hook runs in the
 * tmux server's environment and the watcher in its own, so each is told the server that holds the pane: its name and,
 * when tmux was pointed at one, the directory its socket is in. A reporter that read another server would find no such
 * pane, and report a child it cannot see as ended without its status.
 */
export function exitReporter(...args: string[]): string[] {
  const directory = Bun.env.TMUX_TMPDIR ? [`TMUX_TMPDIR=${Bun.env.TMUX_TMPDIR}`] : [];
  return ["env", `KILN_TMUX_SERVER=${tmuxServer()}`, ...directory, kiln, "msg", ...args];
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
  run = "",
  intervalMs = watchIntervalMs,
): Promise<void> {
  let generation: string | undefined;
  // A Codex child's hooks name no child, since its thread did not exist yet; its record does.
  const record = runRecord(name, run);
  const from = child || (record ? `${record.agent}:${record.id}` : "");
  const boxes = paneOutboxes(name, run);
  let retryAt: number | undefined;
  for (;;) {
    const seen = paneState(name);
    // A pane's session can be gone before its exit is read: a person closed it, tmux restarted, or a tmux without
    // remain-on-exit removed it as its command ended. The record still names the child and its parent, so the watcher
    // reports it as ended instead of returning silently (#240).
    if (seen === "gone") {
      await reportSpawnExit(name, child, parent, run);
      return;
    }
    // A respawn drops the pane's hook and gives it a command that belongs to whoever respawned it, so it is left alone.
    generation ??= seen.generation;
    if (seen.generation !== generation) return;
    if (!("waiting" in seen)) {
      await reportSpawnExit(name, child, parent, run);
      return;
    }
    // The child runs in its agent's sandbox, which hides the sessions, so this watcher, outside it, delivers for it.
    // A failed pass waits out its retry delay rather than running discovery on every tick.
    if (from && (retryAt === undefined ? boxes.some((box) => outboxFiles(box).length > 0) : Date.now() >= retryAt))
      retryAt = (await relayOutbox(boxes, from)) ? Date.now() + relayRetryMs : undefined;
    await Bun.sleep(intervalMs);
  }
}

/**
 * Start that watcher as its own process, so it outlives the spawner and a person's shell. The hook stays the fast path;
 * a watcher that cannot start only loses the fallback, and the hook still reports an exit it sees.
 */
function watchInBackground(name: string, child: string, parent: string, run = ""): void {
  try {
    Bun.spawn(exitReporter("watch", name, child, parent, run), {
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
  const title = options.title ?? options.resume?.title ?? `${options.agent} · ${basename(options.dir)}`;
  // The account is chosen before anything starts: one at its limit is never picked, so a spawn can refuse here.
  const route = await routeNew(options.agent, loadSettings(), {
    requested: options.account,
    skip: options.tried,
    cwd: options.dir,
  });
  const account = {
    account: route.name,
    brief: options.prompt,
    tried: options.tried?.length ? options.tried.join(",") : undefined,
  };
  // A child in its agent's sandbox cannot see the sessions, so what it sends waits in an outbox its spawn relays.
  const outbox = (box: string) => {
    // A box this spawn did not make is another run's, which a failed start must leave alone.
    const made = mkdirSync(outboxPath(box), { recursive: true, mode: 0o700 }) !== undefined;
    return {
      release: () => made && releaseOutbox(box),
      env: { ...route.env, KILN_OUTBOX: outboxPath(box) },
      writable: spawnGrants(options.agent, options.dir, outboxPath(box)),
    };
  };

  if (options.agent === "codex" || options.agent === "agy") {
    const agent = options.agent;
    // These agents name their own conversation only after they start, so the pane is named before the id is known.
    const name = `${agent}-${crypto.randomUUID()}`;
    const { env, writable, release } = outbox(name);
    // The exit hook names the pane; the record made below supplies the id once the thread exists.
    const hook = exitHook(exitReporter("exit", name, "", parent ?? ""));
    if (
      !start(
        name,
        options.dir,
        headlessCommand(command, agent, "", options.prompt, undefined, options.model, undefined, writable),
        title,
        false,
        hook,
        env,
      )
    ) {
      release();
      throw new Error(`could not start ${agentName(agent)}`);
    }
    const pid = await panePid(name);
    const thread = pid
      ? await spawnedConversation(pid, agent === "codex" ? codexThreadId : agyConversationId)
      : undefined;
    // A run that failed before starting its thread never read the prompt, so the spawn fails with its reason rather than
    // printing an id for a child that is already gone. Nothing is recorded yet, so its exit hook reports nothing.
    const failed = thread ? undefined : await settledExit(name);
    // A finished agy run that exited cleanly before its conversation was seen still answered; its exit report says so.
    if (failed && (agent === "codex" || failed.status !== 0)) {
      kill(name);
      release();
      if (agent === "codex") clearMountPoints(worktreeMetadata(options.dir));
      const reason = failed.output.trim();
      throw new Error(
        `${agentName(agent)} exited with status ${failed.status} before it started${reason ? `:\n${reason}` : ""}`,
      );
    }
    if (!pid) {
      release();
      throw new Error(`could not find the ${agentName(agent)} process kiln started`);
    }
    const startedAt = processStartedAt(pid);
    // The thread id names the rollout, which stays readable after the process exits. A run that hangs before starting
    // its thread has no rollout, and keeps the name of its process.
    const id = thread ?? `${pid}:${startedAt}`;
    recordSpawn({
      agent,
      id,
      cwd: options.dir,
      title,
      parent,
      startedAt,
      pid,
      pane: name,
      ...account,
    });
    watchInBackground(name, "", parent ?? "");
    if (ended(name)) await reportSpawnExit(name, "", parent ?? "");
    return `${agent}:${id}`;
  }

  const id = options.resume?.id ?? (options.agent === "opencode" ? newOpencodeSessionId() : crypto.randomUUID());
  // An interactive Claude waits at its trust dialog, never reading the prompt, in a folder its config has not trusted.
  // Only the directory the spawner named is trusted, in the config dir this spawn runs Claude with. A headless Claude
  // (`-p`) never asks, so this grants an interactive child what a headless one in the same folder already has.
  // That is the routed account's, which the command names itself, so the pane's environment cannot put it elsewhere.
  const configDir =
    route.env.CLAUDE_CONFIG_DIR ||
    (route.unset === "CLAUDE_CONFIG_DIR" ? undefined : Bun.env.CLAUDE_CONFIG_DIR) ||
    undefined;
  if (options.interactive) {
    const { json } = claudeConfig({ ...Bun.env, CLAUDE_CONFIG_DIR: configDir });
    assertOnboarded(json, configDir);
    await trustClaudeWorkspace(options.dir, json);
  }
  const name = `${options.agent}-${id.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
  // A pane whose agent has exited, as one an OOM killer took stays when nothing reaped it, holds nothing to resume
  // beside: its run is reported, as its own reporters would have, and the pane closed so this run can take the name.
  // Reporting closes the pane only once its exit is posted, and only the pane it read, so a run another resume started
  // meanwhile stays.
  const left = endedPane(name);
  if (left) {
    const previousRun = spawnRecord(name);
    if (previousRun) await reportSpawnExit(name, "", "", previousRun.runBound ? String(previousRun.startedAt) : "");
    else reapEnded(left);
  }
  const unreported = endedPane(name);
  if (unreported)
    throw new Error(
      `${options.agent}:${id}'s previous run in ${name} exited with status ${unreported.status} and kiln could not report it to its parent; run the spawn again to retry`,
    );
  // A conversation still running in its pane is not resumed a second time beside it.
  if (exists(name)) throw new Error(`${options.agent}:${id} is already running in ${name}`);
  const startedAt = Date.now();
  const { env, writable, release } = outbox(outboxKey(name, String(startedAt)));
  const launch = options.agent === "claude" ? claudeGrants(command, options.dir, writable) : command;
  // Claude titles its own session from the prompt, and that title outranks the recorded one: name it only when asked.
  const argv = options.interactive
    ? interactiveClaudeCommand(launch, id, options.prompt, options.title, options.model, configDir, options.resume)
    : routed(
        headlessCommand(
          launch,
          options.agent,
          id,
          options.prompt,
          options.agent === "claude" ? options.title : title,
          options.model,
          options.resume,
        ),
        route,
      );
  const run = {
    agent: options.agent,
    id,
    cwd: options.dir,
    title,
    parent,
    startedAt,
    pane: name,
    runBound: true,
    interactive: options.interactive || undefined,
    ...account,
  };
  // A resumed child keeps its pane name, so its hook and watcher carry this run's start time and report only while the
  // record is still this run's: a previous run's late hook must not reap this pane or report it to that run's parent.
  const token = String(run.startedAt);
  const hook = exitHook(exitReporter("exit", name, `${options.agent}:${id}`, parent ?? "", token));
  // Record this run before its pane can exit: an exit hook that fired first would read the previous run's record and
  // so, bound to this run, report nothing. A spawn that fails puts the previous record back.
  const previous = savedRow(run);
  recordSpawn(run);
  let pid: number | undefined;
  try {
    if (!start(name, options.dir, argv, title, false, hook, env))
      throw new Error(`could not start ${agentName(options.agent)}`);
    pid = options.interactive
      ? await settleClaudeTrust(name, id, options, argv, title, hook, undefined, env)
      : await panePid(name);
  } catch (error) {
    if (previous) restoreRow(previous);
    else forget(run);
    // Nothing ran there long enough to leave a message, so the outbox would only be left behind.
    release();
    throw error;
  }
  recordSpawn({ ...run, pid });
  watchInBackground(name, `${options.agent}:${id}`, parent ?? "", token);
  if (ended(name)) await reportSpawnExit(name, `${options.agent}:${id}`, parent ?? "", token);
  return `${options.agent}:${id}`;
}

/**
 * The record of the run a reporter was made for, or nothing when the pane has none or a later run owns it now: that
 * reporter's run was reported, or failed to start. A reporter naming no run acts only on a record whose hooks name none
 * either, from a Codex spawn or an older kiln.
 */
function runRecord(name: string, run: string): Saved | undefined {
  const record = spawnRecord(name);
  // The hook can beat registration. The spawner checks for an already-ended pane after saving its record.
  if (!record) return undefined;
  return (run ? Number(run) === record.startedAt : !record.runBound) ? record : undefined;
}

/**
 * A spawned child's process has exited: tell its parent why, so a child that stops on a usage limit is not lost, then
 * close the pane kept for this report. The parent may be gone too; the message then waits in the mailbox. `run` is the
 * start time of the run the hook or watcher was made for; a Codex pane is named per run, so its reporters carry none.
 */
export async function reportSpawnExit(name: string, _child: string, parent: string, run = ""): Promise<void> {
  const reported = runRecord(name, run);
  if (!reported) return;
  // A spawn from a shell, a timer or a detached worker records no caller, but the parent found for it later by process
  // ancestry is in the record, so an exit report still reaches the session that started the child.
  let recipients: Session[] | undefined = [];
  const boxes = paneOutboxes(name, run);
  if (parent || reported.parent || boxes.some((box) => outboxFiles(box).length > 0)) {
    try {
      recipients = await listSessions({ kitty: false });
    } catch {
      // An unavailable discovery source must not prevent an offline mailbox report.
      recipients = undefined;
    }
  }
  // Discovery can pause long enough for another reporter to reap this run and a resumed run to exit in the same pane,
  // so the run is checked again, and the record read now names who is told. From here to the post nothing is awaited.
  const record = runRecord(name, run);
  if (!record) return;
  const identity = `${record.agent}:${record.id}`;
  const to = parent || record.parent || "";
  // The pane is read after discovery, so a respawn while discovery ran is read as the new command it is, not reported.
  const seen = paneState(name);
  if (seen !== "gone" && "waiting" in seen) return;
  // What the child sent before it exited goes ahead of its exit report.
  let relayed = 0;
  for (const box of boxes) relayed += drainOutbox(box, identity, recipients);
  // A pane whose session is gone has no exit left to read: a person closed it, tmux restarted, or a tmux without
  // remain-on-exit removed it (#240). Reporters close a pane only once its report is posted, or when it has nobody to
  // report to, so a pane they closed had its status reported already, and this report, under the same id, is not posted.
  const ending = seen === "gone" ? undefined : seen;
  // The hook, the watcher and the spawner can each reach here; only the one that posts the exit report restarts the child.
  const firstReport = !posted(exitReportId(record));
  if (to) {
    // The message id makes the post idempotent: the hook, the watcher and the spawner can each report one exit, and the
    // first to post decides its text. A reporter that stops before posting leaves the pane, and its status, to the next.
    try {
      post(
        spawnReportSender(identity),
        to,
        exitMessage(identity, record.title, ending?.status, ending?.output),
        undefined,
        undefined,
        exitReportId(record),
      );
    } catch {
      // The pane keeps the status for a reporter that can post it.
      return;
    }
  }
  if (ending) reapEnded(ending);
  if (record.agent === "codex") clearMountPoints(worktreeMetadata(record.cwd));
  for (const box of boxes) releaseOutbox(box);
  if (to || relayed) {
    try {
      await flush(recipients ?? []);
    } catch {
      // A parent kiln cannot reach right now can still read the message from its mailbox.
    }
  }
  if (firstReport && ending?.status !== undefined && ending.status !== 0 && record.brief !== undefined)
    await failOver(record, ending.output, to);
  // Provider conversations can be resumed independently of this pane. Exit hooks cannot
  // bind a remote interrupt/archive to its generation, so only explicit close does that.
}

/** Whether the kiln pane `name` holds a headless `kiln msg spawn` run, whose exit is what reports its usage limit. */
export function headlessSpawn(name: string): boolean {
  const record = spawnRecord(name);
  return record !== undefined && !record.interactive;
}

/**
 * Restart the Claude conversation `id` in the kiln pane `name` on the account `route` names. tmux replaces the old
 * process with the new one, so the conversation never runs twice, and the pane keeps its scrollback and whoever is
 * attached to it. A spawned child keeps its sandbox grant and its outbox, and its exit hook and watcher are set again
 * for the same run, so its parent still hears of its exit. Answers whether the new process is running.
 */
export async function moveClaude(
  name: string,
  id: string,
  cwd: string,
  route: Pick<Route, "name" | "env">,
  settings: Settings,
  graceMs = 5_000,
): Promise<boolean> {
  const configDir = route.env.CLAUDE_CONFIG_DIR || undefined;
  // Claude asks about a folder its config has not trusted, and the new account's config is another file.
  await trustClaudeWorkspace(cwd, claudeConfig({ ...Bun.env, CLAUDE_CONFIG_DIR: configDir }).json);
  const conversation = claudeConversation(id);
  const resume = { id, codeMode: conversation?.codeMode === true, title: conversation?.title };
  const record = spawnRecord(name);
  const spawned = record?.agent === "claude" && record.id === id && record.runBound ? record : undefined;
  const token = spawned ? String(spawned.startedAt) : "";
  const child = `claude:${id}`;
  // The pane's first command was given the outbox in its environment, which a replaced command does not inherit.
  const outbox = outboxPath(outboxKey(name, token));
  const command = spawned
    ? claudeGrants(settings.agents.claude, cwd, spawnGrants("claude", cwd, outbox))
    : agentCommand("claude", settings, undefined, undefined, resume.codeMode);
  const argv = interactiveClaudeCommand(command, id, resumedOnAccount, undefined, undefined, configDir, resume);
  const hook = spawned ? exitHook(exitReporter("exit", name, child, spawned.parent ?? "", token)) : undefined;
  if (!respawn(name, cwd, argv, hook, spawned ? { KILN_OUTBOX: outbox } : {})) return false;
  if (!spawned) return (await survives(name, graceMs)) === true;
  const tried = [...(spawned.tried?.split(",").filter(Boolean) ?? []), spawned.account ?? defaultAccount];
  recordSpawn({ ...spawned, account: route.name, tried: tried.join(","), pid: await panePid(name) });
  watchInBackground(name, child, spawned.parent ?? "", token);
  return true;
}

/** When the Claude conversation `id` was refused on its usage limit, if nothing has been said to it since. */
export const claudeRefusedAt = (id: string): number | undefined => claudeConversation(id)?.refusedAt;

/** What a Claude conversation resumed on another account is told; it already holds its own history. */
export const resumedOnAccount =
  "Your previous run stopped because its account reached its usage limit. Continue the task where you left off.";

/** What a restarted child is told. */
function handoffPrompt(record: Saved, output: string | undefined, resumed: boolean): string {
  if (resumed) return resumedOnAccount;
  const last = output?.trim();
  return [
    record.brief,
    `A previous run of this task stopped because its ${record.agent} account${record.account ? ` ${record.account}` : ""} reached its usage limit. Continue from where it stopped, without redoing finished work.`,
    last ? `Its last output:\n\n${last}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A child that exited on its account's usage limit is started again on the next account with headroom, and its parent is
 * told which way it went. The limit is read from the provider's signal ({@link detectLimit}), never from the child's
 * output. Claude resumes the same conversation, since its accounts share one transcript store; Codex, Muse and
 * OpenCode keep conversations per account, so they start fresh with the original brief and the child's last output.
 */
async function failOver(record: Saved, output: string | undefined, to: string): Promise<void> {
  const settings = loadSettings();
  forgetReads();
  const now = Date.now();
  const quota = await readQuota(now, settings.accounts).catch(() => []);
  const hit = detectLimit(record, now, quota);
  if (!hit) return;
  if (hit.resetsAt !== undefined) recordSpent(record.agent, record.account, hit.resetsAt);
  const identity = `${record.agent}:${record.id}`;
  const tried = [...(record.tried?.split(",").filter(Boolean) ?? []), record.account ?? defaultAccount];
  const reset = hit.resetsAt === undefined ? "" : `, which resets ${new Date(hit.resetsAt).toISOString()}`;
  const stopped = `Child ${identity} stopped on the usage limit of its ${record.agent} account${record.account ? ` ${record.account}` : ""}${reset}.`;
  let report: string;
  try {
    const route = await routeNew(record.agent, settings, { skip: tried, now, cwd: record.cwd });
    const conversation = record.agent === "claude" ? claudeConversation(record.id) : undefined;
    const resume = conversation
      ? { id: record.id, codeMode: conversation.codeMode, title: conversation.title }
      : undefined;
    const child = await spawnAgent(
      {
        agent: record.agent,
        dir: record.cwd,
        title: record.title,
        prompt: handoffPrompt(record, output, resume !== undefined),
        account: route.name,
        tried,
        resume,
        // A child a person may be watching comes back the way it was started.
        interactive: record.interactive,
      },
      to || undefined,
    );
    report = `${stopped} Restarted on ${route.name ?? "its next account"} as ${child}: ${
      resume
        ? "the same conversation resumed, since Claude accounts share their transcripts"
        : "a fresh run given the original brief and the child's last output, since this agent keeps conversations per account"
    }.`;
  } catch (error) {
    report = `${stopped} It was not restarted: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!to) return;
  try {
    post(spawnReportSender(identity), to, report, undefined, undefined, `failover:${exitReportId(record)}`);
    await flush([]);
  } catch {
    // The report stays in the mailbox for the parent to read.
  }
}
