import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { acpRequest } from "./acp-host";
import { archiveCodexThread } from "./codex";
import { focus } from "./kitty";
import { closeNativeRecovery, releaseForNative } from "./native-resume";
import { sessionTitle } from "./session-list";
import type { Agent, Session } from "./sessions";
import type { Settings } from "./settings";
import { exists, kill, start } from "./tmux";
import { tilde } from "./tui";
import { recordDirectory } from "./zoxide";

/** What the view does next: show a conversation, hand the terminal to a tmux session, or only say something. */
export type Outcome =
  | { kind: "conversation"; id: string }
  | { kind: "attach"; name: string; notice?: string }
  | { kind: "notice"; text: string }
  | { kind: "done" };

const notice = (text: string): Outcome => ({ kind: "notice", text });

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** Give a session with no terminal one of kiln's, reusing the pane from an earlier open. */
async function attachNative(session: Session, id: string, attach: string[]): Promise<Outcome> {
  const name = `${session.agent}-bg-${id.slice(0, 16)}`;
  if (!exists(name)) {
    if (!attach[0] || !Bun.which(attach[0])) return notice(`${session.agent} is not on PATH`);
    if (!isDirectory(session.cwd)) return notice(`${tilde(session.cwd)} is not a directory`);
    try {
      await releaseForNative(session);
    } catch (error) {
      return notice(error instanceof Error ? error.message : "Could not resume the saved session");
    }
    if (!start(name, session.cwd, attach, sessionTitle(session))) return notice(`could not attach to ${session.agent}`);
  }
  return { kind: "attach", name };
}

export async function openSession(session: Session): Promise<Outcome> {
  const place = session.place;
  switch (place.kind) {
    case "acp":
      return session.agent === "pi"
        ? { kind: "conversation", id: place.id }
        : notice("This saved session has no native provider identity; open it in the provider's resume picker");
    case "kiln":
      return { kind: "attach", name: place.name };
    case "kitty":
      return focus(place.socket, place.windowId) ? { kind: "done" } : notice("kitty could not focus this session");
    case "job":
    case "thread":
    case "saved":
      return attachNative(session, place.id, place.attach);
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

export async function createSession(agent: Agent, cwd: string, settings: Settings): Promise<Outcome> {
  if (!isDirectory(cwd)) return notice(`${tilde(cwd)} is not a directory`);
  try {
    if (agent === "pi") {
      const session = await acpRequest<Session>("/sessions", { agent, cwd });
      if (settings.zoxide) recordDirectory(cwd);
      return session.id ? { kind: "conversation", id: session.id } : { kind: "done" };
    }
    const command = settings.agents[agent];
    if (!command[0] || !Bun.which(command[0])) throw new Error(`${command[0] ?? agent} is not on PATH`);
    const remoteProblem = agent === "codex" && settings.remoteControl ? await startCodexRemoteControl() : undefined;
    const name = `${agent}-${crypto.randomUUID()}`;
    const argv =
      agent === "claude" && settings.remoteControl && !command.includes("--remote-control")
        ? [...command, "--remote-control"]
        : command;
    if (!start(name, cwd, argv, `${agent} · ${cwd}`)) throw new Error(`could not start ${agent}`);
    if (settings.zoxide) recordDirectory(cwd);
    return { kind: "attach", name, notice: remoteProblem };
  } catch (error) {
    return notice(error instanceof Error ? error.message : "Could not start session");
  }
}

export type SessionAction = { verb: "close" | "archive" | "delete" } | { reason: string };

export function sessionAction(session: Session): SessionAction {
  const place = session.place;
  switch (place.kind) {
    case "acp":
    case "kiln":
    case "saved":
      return { verb: "close" };
    case "thread":
      return { verb: "archive" };
    case "job":
      // `claude rm` removes the job and its worktree, and refuses while that worktree has unpushed work.
      return session.lifecycle || place.stop
        ? { verb: "delete" }
        : { reason: "Close this session in its native terminal" };
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
      case "acp":
        await acpRequest(`/sessions/${place.id}/close`, {});
        break;
      case "kiln":
        if (!kill(place.name)) throw new Error("tmux could not close this session");
        break;
      case "saved":
        // A recovery record has no live adapter; closing it only retires the record below.
        if (place.acpId) await acpRequest(`/sessions/${place.acpId}/close`, {});
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
      case "kitty":
      case "elsewhere":
      case "cloud":
        return "this session is not managed by kiln";
      default:
        return place satisfies never;
    }
    closeNativeRecovery(session);
    return true;
  } catch (error) {
    return `could not ${action.verb} ${session.agent}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
