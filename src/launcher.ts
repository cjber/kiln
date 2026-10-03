import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { archiveCodexThread } from "./codex";
import { focus } from "./kitty";
import { piExtensionPath } from "./pi-status";
import { forget } from "./saved-sessions";
import { sessionTitle } from "./session-list";
import type { Agent, Session } from "./sessions";
import type { Settings } from "./settings";
import { exists, kill, start } from "./tmux";
import { tilde } from "./tui";
import { recordDirectory } from "./zoxide";

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
    if (!attach[0] || !Bun.which(attach[0])) return notice(`${session.agent} is not on PATH`);
    if (!isDirectory(session.cwd)) return notice(`${tilde(session.cwd)} is not a directory`);
    if (!start(name, session.cwd, attach, sessionTitle(session))) return notice(`could not attach to ${session.agent}`);
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

/** The agent's configured command; `resume` continues a provider conversation instead of starting one. */
function agentCommand(agent: Agent, settings: Settings, resume?: string): string[] {
  const command = settings.agents[agent];
  switch (agent) {
    case "claude":
      return [
        ...command,
        ...(settings.remoteControl && !command.includes("--remote-control") ? ["--remote-control"] : []),
        ...(resume ? ["--resume", resume] : []),
      ];
    case "codex":
      // `resume <id>` comes first: discovery reads a resumed thread's identity from those two arguments.
      return resume ? [...command.slice(0, 1), "resume", resume, ...command.slice(1)] : command;
    case "pi":
      return [...command, "-e", piExtensionPath(), ...(resume ? ["--session", resume] : [])];
  }
}

/** Start an agent in a session on kiln's tmux server. A resumed conversation has one session, named after it, that a second open reuses. */
async function launch(agent: Agent, cwd: string, settings: Settings, title: string, resume?: string): Promise<Outcome> {
  const name = `${agent}-${resume ? new Bun.CryptoHasher("sha256").update(resume).digest("hex").slice(0, 16) : crypto.randomUUID()}`;
  if (resume && exists(name)) return { kind: "attach", name };
  if (!isDirectory(cwd)) return notice(`${tilde(cwd)} is not a directory`);
  try {
    const command = settings.agents[agent];
    if (!command[0] || !Bun.which(command[0])) throw new Error(`${command[0] ?? agent} is not on PATH`);
    const remoteProblem = agent === "codex" && settings.remoteControl ? await startCodexRemoteControl() : undefined;
    if (!start(name, cwd, agentCommand(agent, settings, resume), title)) throw new Error(`could not start ${agent}`);
    if (settings.zoxide) recordDirectory(cwd);
    return { kind: "attach", name, notice: remoteProblem };
  } catch (error) {
    return notice(error instanceof Error ? error.message : "Could not start session");
  }
}

export function createSession(agent: Agent, cwd: string, settings: Settings): Promise<Outcome> {
  return launch(agent, cwd, settings, `${agent} · ${cwd}`);
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
        break;
      case "thread":
        await archiveCodexThread(place.id);
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
        forget(session);
        break;
      case "kitty":
      case "elsewhere":
      case "cloud":
        return "this session is not managed by kiln";
      default:
        return place satisfies never;
    }
    return true;
  } catch (error) {
    return `could not ${action.verb} ${session.agent}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
