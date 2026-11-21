import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { pinFor } from "./accounts";
import { claudeTranscript, findClaudeTranscript } from "./claude-inbox";
import { archiveCodexThread } from "./codex";
import { focus } from "./kitty";
import { afterMuseWord } from "./muse";
import { archiveOpencodeSession, newOpencodeSessionId } from "./opencode";
import { piExtensionPath } from "./pi-status";
import { type Route, routed, routeNew } from "./routing";
import { forget, restoreRow, savedRow } from "./saved-sessions";
import { sessionTitle } from "./session-list";
import { type Agent, agentName, listSessions, type Session } from "./sessions";
import type { Settings } from "./settings";
import { awaitStart, endedPane, exists, kill, reapEnded, respawn, start, survives } from "./tmux";
import { readTranscript } from "./transcript";
import { tilde } from "./tui";
import { recordDirectory } from "./zoxide";

/** Daemon conversations are archived on close; the other providers keep theirs without being asked. */
function archiveConversation(session: Session, id: string, terminalClosed = false): Promise<void> {
  return session.agent === "opencode" ? archiveOpencodeSession(id) : archiveCodexThread(id, terminalClosed);
}

/** How long a close waits for a session's process to exit after its terminal closed. */
const exitWaitMs = 5_000;

/**
 * Archive a session whose terminal has just closed. Its process holds the thread's writer lock until it exits, and the
 * provider refuses the archive while it does, so the archive waits for that process to be gone.
 */
export async function archiveClosed(
  session: Session,
  id: string,
  waitMs = exitWaitMs,
  running: (pid: number) => boolean = (pid) => existsSync(`/proc/${pid}`),
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (session.pid !== undefined && running(session.pid) && Date.now() < deadline) await Bun.sleep(50);
  await archiveConversation(session, id, true);
}

/** What the view does next: hand the terminal to a tmux session, or only say something. */
export type Outcome =
  | { kind: "attach"; name: string; notice?: string }
  | { kind: "notice"; text: string }
  | { kind: "done" };

const notice = (text: string): Outcome => ({ kind: "notice", text });

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** Give a session with no terminal one of kiln's, reusing the pane from an earlier open. */
function attachNative(session: Session, id: string, attach: string[]): Outcome {
  const name = `${session.agent}-bg-${id.slice(0, 16)}`;
  if (!exists(name)) {
    if (!attach[0] || !Bun.which(attach[0])) return notice(`${agentName(session.agent)} is not on PATH`);
    if (!isDirectory(session.cwd)) return notice(`${tilde(session.cwd)} is not a directory`);
    if (!start(name, session.cwd, attach, sessionTitle(session)))
      return notice(`could not attach to ${agentName(session.agent)}`);
  }
  return { kind: "attach", name };
}

export async function openSession(session: Session, settings: Settings): Promise<Outcome> {
  const place = session.place;
  switch (place.kind) {
    case "kiln":
      return { kind: "attach", name: place.name };
    case "kitty":
      return focus(place.socket, place.windowId) ? { kind: "done" } : notice("kitty could not focus this session");
    case "job":
    case "thread":
      return attachNative(session, place.id, place.attach);
    case "saved": {
      if (!session.id) return notice("this session has no conversation to resume");
      // The row stays until the resumed conversation is seen running, so a resume that fails can be tried again.
      let route: Awaited<ReturnType<typeof resumeRoute>>;
      try {
        route = await resumeRoute(session.agent, session.cwd, settings);
      } catch (error) {
        return notice(error instanceof Error ? error.message : "could not choose an account");
      }
      return launch(session.agent, session.cwd, settings, sessionTitle(session), session.id, undefined, false, route);
    }
    case "elsewhere":
      return notice(`Open this session in its terminal · ${place.source ?? session.id ?? "unknown"}`);
    case "cloud": {
      if (session.agent === "claude") {
        if (!place.url) return notice("this Claude cloud session has no verified link");
        if (!Bun.which("xdg-open")) return notice("opening a Claude cloud session needs xdg-open on PATH");
        const child = Bun.spawn(["xdg-open", place.url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        return (await child.exited) === 0
          ? { kind: "done" }
          : notice("could not open this Claude cloud session in the browser");
      }
      const name = `codex-cloud-${new Bun.CryptoHasher("sha256").update(place.id).digest("hex").slice(0, 16)}`;
      const command = [
        "sh",
        "-c",
        'codex cloud status -- "$1"; codex cloud diff -- "$1"; printf "\\nPress Enter to return to kiln "; read -r reply',
        "sh",
        place.id,
      ];
      if (!exists(name) && !start(name, homedir(), command, `codex cloud · ${place.title}`))
        return notice("could not open this Codex Cloud task");
      return { kind: "attach", name };
    }
  }
}

/** Codex Remote Control is a daemon feature; a failure to start it is reported but does not block the session. */
async function startCodexRemoteControl(): Promise<string | undefined> {
  const child = Bun.spawn(["codex", "remote-control", "start"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [problem, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    return code ? problem.trim() || "Codex Remote Control did not start" : undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first prompt as the agent's own argument. `--` keeps a prompt that starts with a dash from reading as an option.
 * Claude still runs a subcommand named by a lone word after `--`, so a one-word prompt gets a trailing newline, which
 * no subcommand name has and the prompt box ignores.
 */
export function promptArguments(agent: Agent, prompt: string | undefined): string[] {
  if (!prompt) return [];
  switch (agent) {
    case "claude":
      return ["--", /\s/.test(prompt) ? prompt : `${prompt}\n`];
    case "codex":
    case "pi":
    case "muse":
      return ["--", prompt];
    case "opencode":
      return [`--prompt=${prompt}`];
    case "agy":
      return [`--prompt-interactive=${prompt}`];
  }
}

/**
 * The configured Claude command for a run in or out of Code Mode. Claude refuses to resume a Code Mode conversation with
 * Remote Control on, so `codeMode` leaves it off, configured or not.
 */
export function claudeCommand(command: readonly string[], codeMode: boolean): string[] {
  return codeMode ? command.filter((word) => word !== "--remote-control") : [...command];
}

/**
 * The agent's configured command; `resume` continues a provider conversation instead of starting one, and `codeMode`
 * runs Claude as {@link claudeCommand} does.
 */
export function agentCommand(
  agent: Agent,
  settings: Settings,
  resume?: string,
  prompt?: string,
  codeMode = false,
): string[] {
  const command = settings.agents[agent];
  const first = promptArguments(agent, prompt);
  switch (agent) {
    case "claude":
      return [
        ...claudeCommand(command, codeMode),
        ...(!codeMode && settings.remoteControl && !command.includes("--remote-control") ? ["--remote-control"] : []),
        ...(resume ? ["--resume", resume] : []),
        ...first,
      ];
    case "codex": {
      if (!resume) return [...command, ...first];
      // `resume <id>` directly follows codex, after any wrapper: discovery reads a resumed thread's identity from there.
      const at = command.findIndex((word) => basename(word) === "codex") + 1 || 1;
      return [...command.slice(0, at), "resume", resume, ...command.slice(at), ...first];
    }
    // The id kiln chooses is what discovery reads back from argv; OpenCode creates it on the first prompt.
    case "opencode":
      return [...command, "--session", resume ?? newOpencodeSessionId(), ...first];
    case "pi":
      return [...command, "-e", piExtensionPath(), ...(resume ? ["--session", resume] : []), ...first];
    case "muse": {
      if (!resume) return [...command, ...first];
      // `resume <id>` directly follows the muse word, after any wrapper: root options before it would start a new run.
      // Muse's resume takes no prompt at all; `resumeStopped` refuses one rather than dropping it here.
      const at = afterMuseWord(command);
      return [...command.slice(0, at), "resume", resume, ...command.slice(at)];
    }
    case "agy":
      return [...command, ...(resume ? ["--conversation", resume] : []), ...first];
  }
}

/** kiln's tmux name for a session: a resumed conversation always gets the same one. */
function sessionName(agent: Agent, resume?: string): string {
  return `${agent}-${resume ? new Bun.CryptoHasher("sha256").update(resume).digest("hex").slice(0, 16) : crypto.randomUUID()}`;
}

/** Start an agent in a session on kiln's tmux server. A resumed conversation has one session, named after it, that a second open reuses. */
async function launch(
  agent: Agent,
  cwd: string,
  settings: Settings,
  title: string,
  resume?: string,
  prompt?: string,
  keep = false,
  route: Pick<Route, "env" | "unset"> = { env: {} },
): Promise<Outcome> {
  const name = sessionName(agent, resume);
  if (resume && exists(name)) {
    const left = endedPane(name);
    // A kept pane whose agent exited holds only its exit status, and attaching to it would show a dead screen. Only the
    // pane read is closed, so one another resume started meanwhile is attached to.
    if (!left || (!reapEnded(left) && exists(name))) return { kind: "attach", name };
  }
  if (!isDirectory(cwd)) return notice(`${tilde(cwd)} is not a directory`);
  try {
    const command = settings.agents[agent];
    if (!command[0] || !Bun.which(command[0])) throw new Error(`${command[0] ?? agentName(agent)} is not on PATH`);
    const remoteProblem = agent === "codex" && settings.remoteControl ? await startCodexRemoteControl() : undefined;
    const codeMode = agent === "claude" && resume !== undefined && claudeCodeMode(cwd, resume);
    const env = { ...route.env, ...(codeMode ? { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" } : {}) };
    const argv = routed(agentCommand(agent, settings, resume, prompt, codeMode), route);
    if (!start(name, cwd, argv, title, keep, undefined, env)) throw new Error(`could not start ${agentName(agent)}`);
    if (settings.zoxide) recordDirectory(cwd);
    return { kind: "attach", name, notice: remoteProblem };
  } catch (error) {
    return notice(error instanceof Error ? error.message : "Could not start session");
  }
}

/** Whether Claude recorded the conversation as started in Code Mode, which it resumes only with Code Mode on. */
function claudeCodeMode(cwd: string, id: string): boolean {
  const path = claudeTranscript(cwd, id);
  return path !== undefined && readTranscript(path).codeMode === true;
}

/** Whether kiln's discovery lists the conversation running in the tmux session `name`, which is what makes it resumed. */
async function runsIn(session: Session, name: string): Promise<boolean> {
  try {
    return (await listSessions({ kitty: false })).some(
      (found) =>
        found.agent === session.agent &&
        found.id === session.id &&
        found.place.kind === "kiln" &&
        found.place.name === name,
    );
  } catch {
    // A stale listing says nothing either way; the next poll asks again.
    return false;
  }
}

/** How a resume tells that its agent started: `started` defaults to discovery listing it in its pane. */
export type StartWatch = { started?: (name: string) => Promise<boolean>; timeoutMs?: number; pollMs?: number };

/**
 * Resume a `stopped` session without attaching, as `Enter` would, with an optional first prompt. It counts as resumed
 * once discovery lists the conversation running in its pane; the pane is kept until then, so an agent that quits first,
 * however late, is caught with its exit status. One that quits is started once more, since agents started at the
 * same moment can race over their shared login and config, and then reported with what it printed. `timeoutMs` only
 * bounds a launch that hangs. A failed resume leaves the session stopped, even if a refresh saw it run for a moment.
 */
export async function resumeStopped(
  session: Session,
  settings: Settings,
  prompt?: string,
  { started = (name) => runsIn(session, name), timeoutMs = 120_000, pollMs = 1_000 }: StartWatch = {},
): Promise<{ name: string } | { problem: string }> {
  if (session.place.kind !== "saved" || !session.id) return { problem: "this session is not stopped" };
  // Muse's resume command takes no prompt; sending it afterwards reaches the session instead.
  if (session.agent === "muse" && prompt)
    return { problem: "Muse cannot take a prompt on resume; resume it, then send the prompt with kiln msg send" };
  const name = sessionName(session.agent, session.id);
  if (exists(name) && !endedPane(name)) return { name };
  // Claude would exit at once with no reason given; there is no conversation to carry on.
  if (session.agent === "claude" && !findClaudeTranscript(session.id, session.cwd))
    return { problem: `Claude has no conversation ${session.id} to resume` };
  const row = savedRow(session);
  const failed = (problem: string) => {
    if (row) restoreRow(row);
    return { problem };
  };
  let problem = "";
  let route: Awaited<ReturnType<typeof resumeRoute>>;
  try {
    route = await resumeRoute(session.agent, session.cwd, settings);
  } catch (error) {
    return failed(error instanceof Error ? error.message : "could not choose an account");
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await launch(
      session.agent,
      session.cwd,
      settings,
      sessionTitle(session),
      session.id,
      prompt,
      true,
      route,
    );
    if (outcome.kind !== "attach") return failed(outcome.kind === "notice" ? outcome.text : "not started");
    const result = await awaitStart(name, () => started(name), timeoutMs, pollMs);
    if (result === true) {
      // A session cut off in this boot was listed by the dead spawn pane nothing reaped; the conversation runs here now.
      const left = row?.pane === undefined || row.pane === name ? undefined : endedPane(row.pane);
      if (left) reapEnded(left);
      return { name };
    }
    if ("hung" in result)
      return failed(`${agentName(session.agent)} did not start${result.hung ? `: ${result.hung}` : ""}`);
    problem = `${agentName(session.agent)} exited with status ${result.status}${result.output ? `: ${result.output}` : ""}`;
  }
  return failed(problem);
}

/** Reconnect a Codex pane whose daemon status is unavailable, reusing its thread id and tmux session. */
export async function reconnectCodex(
  session: Session,
  _settings: Settings,
  graceMs = 5_000,
): Promise<{ name: string } | { problem: string }> {
  if (session.agent !== "codex" || !session.id) return { problem: "only a Codex thread can be reconnected" };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session.id))
    return { problem: "the Codex session has no authoritative thread id" };
  if (session.activity !== undefined) return { problem: "the Codex status is available; reconnect is refused" };
  if (session.place.kind !== "kiln") return { problem: "the Codex thread has no live Kiln pane" };
  const command = codexReconnectCommand(_settings, session.id);
  if (!respawn(session.place.name, session.cwd, command)) return { problem: "could not restart the Codex pane" };
  const result = await survives(session.place.name, graceMs);
  if (result !== true)
    return { problem: `Codex exited with status ${result.status}${result.output ? `: ${result.output}` : ""}` };
  return { name: session.place.name };
}

/** Exact provider argv used by reconnect, kept separate so callers and tests can verify thread preservation. */
export function codexReconnectCommand(settings: Settings, threadId: string): string[] {
  return [...agentCommand("codex", settings, threadId), "--remote", "unix://"];
}

/**
 * The account a conversation is resumed on. Claude's accounts share one transcript store, so a conversation carries on
 * on whichever has the most headroom, and on kiln's own when none can be chosen. Another agent's conversation lives in
 * the home it began in, which only its own environment names.
 */
async function resumeRoute(agent: Agent, cwd: string, settings: Settings): Promise<Pick<Route, "env" | "unset">> {
  if (agent !== "claude") return { env: {} };
  try {
    return await routeNew(agent, settings, { cwd });
  } catch (error) {
    // A pinned directory's sessions run on its account or not at all.
    if (pinFor(settings, agent, cwd)) throw error;
    return { env: {} };
  }
}

/** A new session on the account with the most headroom; one whose every account is at its limit is not started. */
export async function createSession(agent: Agent, cwd: string, settings: Settings): Promise<Outcome> {
  try {
    const route = await routeNew(agent, settings, { cwd });
    return launch(agent, cwd, settings, `${agent} · ${cwd}`, undefined, undefined, false, route);
  } catch (error) {
    return notice(error instanceof Error ? error.message : "Could not choose an account");
  }
}

/**
 * A session a phone asked for, with its first prompt. It always has the provider's remote control on, since the
 * phone follows it there rather than showing a transcript of its own.
 */
export async function startFromPhone(
  agent: Agent,
  cwd: string,
  prompt: string,
  settings: Settings,
  account?: string,
): Promise<Outcome> {
  try {
    const route = await routeNew(agent, settings, { cwd, requested: account });
    return launch(
      agent,
      cwd,
      { ...settings, remoteControl: true },
      `${agent} · ${cwd}`,
      undefined,
      prompt,
      false,
      route,
    );
  } catch (error) {
    return notice(error instanceof Error ? error.message : "Could not choose an account");
  }
}

export type SessionAction = { verb: "close" | "archive" | "delete" | "forget" } | { reason: string };

export function sessionAction(session: Session): SessionAction {
  const place = session.place;
  switch (place.kind) {
    case "kiln":
      return { verb: "close" };
    case "thread":
      return { verb: "archive" };
    case "job":
      // `claude rm` removes the job and its worktree, and refuses while that worktree has unpushed work.
      return session.lifecycle || place.stop
        ? { verb: "delete" }
        : { reason: "Close this session in its native terminal" };
    case "saved":
      // Only kiln's row goes; the provider keeps the conversation.
      return { verb: "forget" };
    case "kitty":
    case "elsewhere":
      return { reason: "Close this session in its native terminal" };
    case "cloud":
      return { reason: "cloud tasks are read-only and cannot be closed here" };
  }
}

export async function closeSession(session: Session): Promise<true | string> {
  const action = sessionAction(session);
  if ("reason" in action) return action.reason;
  const place = session.place;
  try {
    switch (place.kind) {
      case "kiln":
        if (!kill(place.name)) throw new Error("tmux could not close this session");
        if ((session.agent === "codex" || session.agent === "opencode") && session.id) {
          try {
            await archiveClosed(session, session.id);
          } catch (error) {
            throw new Error(
              `the session stopped; only archiving failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        break;
      case "thread":
        await archiveConversation(session, place.id);
        break;
      case "job":
        if (!session.lifecycle && place.stop) {
          const child = Bun.spawn(place.stop, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
          if (await child.exited) throw new Error("provider could not stop this session");
        }
        {
          const child = Bun.spawn(["claude", "rm", place.id], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
          const [output, problem, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          if (code) throw new Error((problem || output).trim().split("\n")[0] || "claude rm failed");
        }
        break;
      case "saved":
        break;
      case "kitty":
      case "elsewhere":
      case "cloud":
        return "this session is not managed by kiln";
      default:
        return place satisfies never;
    }
    // A session closed on purpose is not one for a restart to bring back.
    forget(session);
    return true;
  } catch (error) {
    return `could not ${action.verb} ${agentName(session.agent)}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
