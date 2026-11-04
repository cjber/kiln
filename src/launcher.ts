import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { archiveCodexThread } from "./codex";
import { focus } from "./kitty";
import { archiveOpencodeSession, newOpencodeSessionId } from "./opencode";
import { piExtensionPath } from "./pi-status";
import { forget } from "./saved-sessions";
import { sessionTitle } from "./session-list";
import { type Agent, agentName, type Session } from "./sessions";
import type { Settings } from "./settings";
import { exists, kill, start } from "./tmux";
import { tilde } from "./tui";
import { recordDirectory } from "./zoxide";

/** Daemon conversations are archived on close; the other providers keep theirs without being asked. */
function archiveConversation(session: Session, id: string, terminalClosed = false): Promise<void> {
  return session.agent === "opencode" ? archiveOpencodeSession(id) : archiveCodexThread(id, terminalClosed);
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
      return launch(session.agent, session.cwd, settings, sessionTitle(session), session.id);
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
function promptArguments(agent: Agent, prompt: string | undefined): string[] {
  if (!prompt) return [];
  switch (agent) {
    case "claude":
      return ["--", /\s/.test(prompt) ? prompt : `${prompt}\n`];
    case "codex":
    case "pi":
      return ["--", prompt];
    case "opencode":
      return [`--prompt=${prompt}`];
  }
}

/** The agent's configured command; `resume` continues a provider conversation instead of starting one. */
export function agentCommand(agent: Agent, settings: Settings, resume?: string, prompt?: string): string[] {
  const command = settings.agents[agent];
  const first = promptArguments(agent, prompt);
  switch (agent) {
    case "claude":
      return [
        ...command,
        ...(settings.remoteControl && !command.includes("--remote-control") ? ["--remote-control"] : []),
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
  }
}

/** Start an agent in a session on kiln's tmux server. A resumed conversation has one session, named after it, that a second open reuses. */
async function launch(
  agent: Agent,
  cwd: string,
  settings: Settings,
  title: string,
  resume?: string,
  prompt?: string,
): Promise<Outcome> {
  const name = `${agent}-${resume ? new Bun.CryptoHasher("sha256").update(resume).digest("hex").slice(0, 16) : crypto.randomUUID()}`;
  if (resume && exists(name)) return { kind: "attach", name };
  if (!isDirectory(cwd)) return notice(`${tilde(cwd)} is not a directory`);
  try {
    const command = settings.agents[agent];
    if (!command[0] || !Bun.which(command[0])) throw new Error(`${command[0] ?? agentName(agent)} is not on PATH`);
    const remoteProblem = agent === "codex" && settings.remoteControl ? await startCodexRemoteControl() : undefined;
    if (!start(name, cwd, agentCommand(agent, settings, resume, prompt), title))
      throw new Error(`could not start ${agentName(agent)}`);
    if (settings.zoxide) recordDirectory(cwd);
    return { kind: "attach", name, notice: remoteProblem };
  } catch (error) {
    return notice(error instanceof Error ? error.message : "Could not start session");
  }
}

export function createSession(agent: Agent, cwd: string, settings: Settings): Promise<Outcome> {
  return launch(agent, cwd, settings, `${agent} · ${cwd}`);
}

/**
 * A session a phone asked for, with its first prompt. It always has the provider's remote control on, since the
 * phone follows it there rather than showing a transcript of its own.
 */
export function startFromPhone(agent: Agent, cwd: string, prompt: string, settings: Settings): Promise<Outcome> {
  return launch(agent, cwd, { ...settings, remoteControl: true }, `${agent} · ${cwd}`, undefined, prompt);
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
            await archiveConversation(session, session.id, true);
          } catch (error) {
            throw new Error(
              `terminal closed, but archiving failed: ${error instanceof Error ? error.message : String(error)}`,
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
