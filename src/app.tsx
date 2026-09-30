import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { runSessionAction, sessionAction } from "./actions";
import { cloudSnapshot } from "./cloud";
import { focus } from "./kitty";
import { type Activity, type Agent, agents, listSessions, type Session } from "./sessions";
import { ensureSettingsFile, loadSettings, type Settings } from "./settings";
import { attach, exists, start } from "./tmux";
import { rankedDirectories, recordDirectory } from "./zoxide";

const color = {
  bg: "#121113",
  bg2: "#222222",
  fg: "#b0b0b0",
  fgBright: "#d0d0d0",
  fgDim: "#777777",
  comment: "#555555",
  orange: "#e78a53",
  teal: "#5f8787",
  peach: "#fbcb97",
  red: "#c75a5a",
  green: "#6a9955",
  purple: "#9d7cd8",
};

const agentColor: Record<Agent, string> = { claude: color.orange, codex: color.teal, pi: color.purple };

type Mode = "normal" | "filter" | "agent" | "confirm";

const refreshMs = 2_000;

function tilde(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function age(startedAt: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 60 / 24)}d`;
}

function activityColor(activity: Activity | undefined): string {
  switch (activity) {
    case "working":
      return color.green;
    case "waiting":
      return color.peach;
    case "idle":
      return color.fgDim;
    case undefined:
      return color.comment;
  }
}

function where(session: Session): string {
  switch (session.place.kind) {
    case "kiln":
      return "kiln";
    case "kitty":
      return "kitty";
    case "background":
      return "bg";
    case "cloud":
      return "cloud";
    case "elsewhere":
      return "other";
  }
}

function label(session: Session): string {
  return session.place.kind === "cloud" ? session.place.title : tilde(session.cwd);
}

/** Shorten with an ellipsis, keeping the end of a path (the repo) or the start of a branch. */
function fit(value: string, width: number, cut: "start" | "end"): string {
  if (value.length <= width) return value;
  return cut === "start" ? `…${value.slice(value.length - width + 1)}` : `${value.slice(0, width - 1)}…`;
}

function sessionName(agent: Agent, cwd: string): string {
  // tmux reserves `.` and `:` in target names.
  const repo = basename(cwd).replace(/[^A-Za-z0-9_-]/g, "-");
  return `${agent}-${repo}-${crypto.randomUUID().slice(0, 4)}`;
}

/**
 * The command a new session starts with. Claude takes remote control per
 * session; Codex has it on the shared daemon its TUI connects to, which kiln
 * starts (or finds running) first. Pi has no remote control.
 */
function launch(agent: Agent, settings: Settings): { argv: string[]; problem?: string } {
  const argv = settings.agents[agent];
  if (!settings.remoteControl) return { argv };
  switch (agent) {
    case "claude":
      return { argv: argv.includes("--remote-control") ? argv : [...argv, "--remote-control"] };
    case "codex": {
      const daemon = Bun.spawnSync(["codex", "remote-control", "start"], { stdout: "ignore", stderr: "pipe" });
      return daemon.exitCode === 0
        ? { argv }
        : { argv, problem: `codex remote control did not start: ${daemon.stderr.toString().trim()}` };
    }
    case "pi":
      return { argv };
  }
}

function untilde(path: string): string {
  return resolve(path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);
}

/**
 * Hand the terminal to fzf over zoxide's ranked directories. `--print-query` makes
 * the typed text usable when it matches no ranked directory, so any directory opens.
 * The user's FZF_DEFAULT_OPTS still apply; only the height is forced so fzf
 * owns the whole screen kiln just gave up.
 */
function pickDirectory(recent: readonly string[]): string | undefined {
  const picked = Bun.spawnSync(["fzf", "--print-query", "--tiebreak=index", "--height=100%", "--prompt=dir> "], {
    stdin: new TextEncoder().encode(recent.map(tilde).join("\n")),
    stdout: "pipe",
    stderr: "inherit",
  });
  // 1 is "no match", which still carries the typed query; anything else (130 for Esc) is a cancel.
  if (picked.exitCode !== 0 && picked.exitCode !== 1) return undefined;
  const [query = "", selection] = picked.stdout.toString().split("\n");
  const choice = selection || query.trim();
  return choice ? untilde(choice) : undefined;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** Printable input for the modes that take text; everything else is a command key. */
function typed(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta || key.name === "return" || key.name === "tab" || key.name === "escape") return undefined;
  return key.sequence.length === 1 && key.sequence >= " " ? key.sequence : undefined;
}

/**
 * State the key handler reads when a key arrives. A paste or fast typing
 * delivers several keys before React re-renders the handler, so reading render
 * state would apply `/xy` as a filter, a close and a confirm.
 */
function useLatest<T>(initial: T): [T, () => T, (next: T | ((current: T) => T)) => void] {
  const ref = useRef(initial);
  const [value, setValue] = useState(initial);
  const get = useCallback(() => ref.current, []);
  const set = useCallback((next: T | ((current: T) => T)) => {
    ref.current = typeof next === "function" ? (next as (current: T) => T)(ref.current) : next;
    setValue(ref.current);
  }, []);
  return [value, get, set];
}

function matching(sessions: readonly Session[], filter: string): Session[] {
  const needle = filter.toLowerCase();
  return sessions.filter(
    (session) =>
      !needle ||
      `${session.agent} ${label(session)} ${where(session)} ${session.branch ?? ""} ${session.activity ?? ""}`
        .toLowerCase()
        .includes(needle),
  );
}

type AppProps = {
  initialSettings: Settings;
  onQuit: () => void;
  /** Where the list comes from; scripts/screenshots.tsx passes demo sessions. */
  loadSessions?: () => Promise<Session[]>;
};

export function App({ initialSettings, onQuit, loadSessions }: AppProps) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const [sessions, getSessions, setSessions] = useLatest<Session[]>([]);
  const [selected, getSelected, setSelected] = useLatest(0);
  const [mode, getMode, setMode] = useLatest<Mode>("normal");
  const [filter, getFilter, setFilter] = useLatest("");
  const [agentIndex, getAgentIndex, setAgentIndex] = useLatest(0);
  const [pendingSession, getPendingSession, setPendingSession] = useLatest<Session | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [settings, getSettings, setSettings] = useLatest(initialSettings);
  const offered = agents.filter((agent) => settings.agents[agent].length);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setSessions(await (loadSessions ? loadSessions() : listSessions({ cloud: getSettings().cloud })));
    } finally {
      refreshing.current = false;
    }
  }, [getSettings, loadSessions, setSessions]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(interval);
  }, [refresh]);

  const visible = useMemo(() => matching(sessions, filter), [filter, sessions]);

  const current = visible[Math.min(selected, visible.length - 1)];

  const withTerminal = useCallback(
    async <T,>(action: () => T): Promise<T> => {
      renderer.suspend();
      try {
        return action();
      } finally {
        renderer.resume();
        await refresh();
      }
    },
    [refresh, renderer],
  );

  const handOver = useCallback(
    (name: string) => withTerminal(() => attach(name, getSettings())),
    [getSettings, withTerminal],
  );

  const open = useCallback(
    async (session: Session) => {
      switch (session.place.kind) {
        case "kiln":
          return handOver(session.place.name);
        case "kitty":
          if (!focus(session.place.socket, session.place.windowId)) setNotice("kitty would not focus that window");
          return;
        case "background": {
          // One kiln session per background agent, so leaving and coming back finds the same attach.
          const name = `${session.agent}-bg-${session.place.id.slice(0, 8)}`;
          if (
            !exists(name) &&
            !start(name, session.cwd, session.place.attach, `${session.agent} · ${basename(session.cwd)}`)
          ) {
            return setNotice(`could not attach to ${session.agent} in ${tilde(session.cwd)}`);
          }
          return handOver(name);
        }
        case "cloud": {
          const name = `codex-cloud-${new Bun.CryptoHasher("sha256").update(session.place.id).digest("hex").slice(0, 16)}`;
          const command = [
            "sh",
            "-c",
            'codex cloud status -- "$1"; codex cloud diff -- "$1"; printf "\\nPress Enter to return to kiln "; read -r reply',
            "sh",
            session.place.id,
          ];
          if (!exists(name) && !start(name, homedir(), command, `codex cloud · ${session.place.title}`))
            return setNotice("could not open this Codex Cloud task");
          return handOver(name);
        }
        case "elsewhere":
          return setNotice(
            `cannot open · ${session.place.source ?? `pid ${session.pid ?? "unknown"}`} · outside kiln and kitty`,
          );
      }
    },
    [handOver],
  );

  const create = useCallback(
    async (agent: Agent) => {
      if (!Bun.which("fzf")) return setNotice("choosing a directory needs fzf on PATH");
      const settings = getSettings();
      const cwd = await withTerminal(() => pickDirectory(settings.zoxide ? rankedDirectories() : []));
      if (!cwd) return;
      if (!isDirectory(cwd)) return setNotice(`${tilde(cwd)} is not a directory`);
      const name = sessionName(agent, cwd);
      const { argv, problem } = launch(agent, settings);
      if (!start(name, cwd, argv, `${agent} · ${basename(cwd)}`))
        return setNotice(`could not start ${agent} in ${tilde(cwd)}`);
      if (settings.zoxide) recordDirectory(cwd);
      await handOver(name);
      if (problem) setNotice(problem);
    },
    [getSettings, handOver, withTerminal],
  );

  /** Settings are a file: open it in $EDITOR, then re-read it, keeping the old ones if the edit does not parse. */
  const editSettings = useCallback(async () => {
    const path = ensureSettingsFile();
    const editor = Bun.env.VISUAL || Bun.env.EDITOR || "vi";
    await withTerminal(() =>
      Bun.spawnSync(["sh", "-c", `${editor} "$1"`, "sh", path], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    try {
      setSettings(loadSettings());
      await refresh();
      setNotice("settings reloaded");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [refresh, setSettings, withTerminal]);

  const close = useCallback(
    async (session: Session) => {
      const action = sessionAction(session);
      const closed = await runSessionAction(session);
      setNotice(
        closed === true && "verb" in action
          ? `${action.verb === "archive" ? "archived" : "closed"} ${session.agent} in ${tilde(session.cwd)}`
          : closed === true
            ? "session closed"
            : closed,
      );
      await refresh();
    },
    [refresh],
  );

  useKeyboard((key) => {
    // Shadow the render values with the latest ones; see useLatest.
    const mode = getMode();
    const agentIndex = getAgentIndex();
    const choices = agents.filter((agent) => getSettings().agents[agent].length);
    const visible = matching(getSessions(), getFilter());
    const current = visible[Math.min(getSelected(), visible.length - 1)];
    const move = (delta: number) => setSelected((index) => Math.max(0, Math.min(visible.length - 1, index + delta)));

    if (key.ctrl && key.name === "c") return onQuit();
    setNotice("");

    if (mode === "filter") {
      if (key.name === "escape") {
        setFilter("");
        return setMode("normal");
      }
      if (key.name === "return") return setMode("normal");
      if (key.name === "backspace") return setFilter((value) => value.slice(0, -1));
      const text = typed(key);
      if (text) {
        setFilter((value) => value + text);
        setSelected(0);
      }
      return;
    }

    if (mode === "agent") {
      if (key.name === "escape") return setMode("normal");
      if (key.name === "j" || key.name === "down" || key.name === "l")
        return setAgentIndex((index) => (index + 1) % choices.length);
      if (key.name === "k" || key.name === "up" || key.name === "h")
        return setAgentIndex((index) => (index + choices.length - 1) % choices.length);
      if (key.name === "return") {
        setMode("normal");
        const agent = choices[agentIndex % choices.length];
        return agent ? void create(agent) : undefined;
      }
      return;
    }

    if (mode === "confirm") {
      setMode("normal");
      const pending = getPendingSession();
      setPendingSession(undefined);
      if (key.name === "y" && pending) void close(pending);
      return;
    }

    if (key.name === "escape") return setFilter("");
    if (key.name === "q") return onQuit();
    if (key.name === "j" || key.name === "down") return move(1);
    if (key.name === "k" || key.name === "up") return move(-1);
    if (key.name === "g" && !key.shift) return setSelected(0);
    if (key.name === "g" && key.shift) return setSelected(Math.max(0, visible.length - 1));
    if (key.ctrl && key.name === "d") return move(10);
    if (key.ctrl && key.name === "u") return move(-10);
    if (key.name === "/") return setMode("filter");
    if (key.name === "r") return void refresh();
    if (key.name === "return" && current) return void open(current);
    if (key.name === "x" && current) {
      const action = sessionAction(current);
      if ("reason" in action) return setNotice(action.reason);
      setPendingSession(current);
      return setMode("confirm");
    }
    if (key.name === "s") return void editSettings();
    if (key.name === "n") {
      if (!choices.length) return setNotice("every agent is hidden in settings; press s to add one");
      setAgentIndex(0);
      return setMode("agent");
    }
  });

  // Columns before the path: marker, agent, status, where, age.
  const fixedWidth = 2 + 9 + 9 + 6 + 6;
  const branchWidth = Math.min(32, Math.max(0, ...visible.map((session) => session.branch?.length ?? 0)));
  const pathWidth = Math.max(
    15,
    Math.min(Math.max(0, ...visible.map((session) => label(session).length)), width - 2 - fixedWidth - branchWidth - 2),
  );

  return (
    <box flexDirection="column" backgroundColor={color.bg} paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text>
        <span fg={color.fgBright} attributes={1}>
          kiln
        </span>
        <span fg={color.comment}> {sessions.length} sessions</span>
        {filter ? <span fg={color.peach}> /{filter}</span> : null}
      </text>
      <box flexDirection="column" marginTop={1} flexGrow={1}>
        {visible.length ? (
          <text fg={color.comment}>
            {`  ${"agent".padEnd(9)}${"status".padEnd(9)}${"where".padEnd(6)}${"age".padStart(4)}  ${"directory / task".padEnd(pathWidth)}  ${branchWidth ? "branch" : ""}`}
          </text>
        ) : null}
        {visible.length ? (
          visible.map((session) => {
            const active = session === current;
            const unavailable = session.place.kind === "elsewhere";
            const nested =
              session.parentSessionPid !== undefined &&
              visible.some((parent) => parent.pid === session.parentSessionPid);
            return (
              <box
                key={
                  session.pid ??
                  (session.place.kind === "background" || session.place.kind === "cloud"
                    ? `${session.place.kind}:${session.place.id}`
                    : session.cwd)
                }
                backgroundColor={active ? color.bg2 : undefined}
              >
                <text>
                  <span fg={active ? color.peach : color.comment}>{active ? "› " : "  "}</span>
                  <span fg={unavailable ? color.comment : agentColor[session.agent]}>
                    {(nested ? `↳ ${session.agent}` : session.agent).padEnd(9)}
                  </span>
                  <span fg={unavailable ? color.comment : activityColor(session.activity)}>
                    {(session.activity ?? "·").padEnd(9)}
                  </span>
                  <span fg={unavailable ? color.comment : color.fgDim}>{where(session).padEnd(6)}</span>
                  <span fg={color.comment}>{age(session.startedAt).padStart(4)} </span>
                  <span fg={unavailable ? color.comment : active ? color.fgBright : color.fg}>
                    {fit(label(session), pathWidth, "start").padEnd(pathWidth)}{" "}
                  </span>
                  <span fg={unavailable ? color.comment : color.teal}>
                    {fit(session.branch ?? "", branchWidth, "end")}
                  </span>
                </text>
              </box>
            );
          })
        ) : (
          <text fg={color.comment}>{filter ? "no sessions match" : "no agents running · n to start one"}</text>
        )}
      </box>
      {mode === "agent" ? (
        <text>
          <span fg={color.fgDim}>new </span>
          {offered.map((agent, index) => (
            <span
              key={agent}
              fg={index === agentIndex ? agentColor[agent] : color.comment}
              attributes={index === agentIndex ? 1 : 0}
            >
              {index === agentIndex ? `[${agent}]` : ` ${agent} `}{" "}
            </span>
          ))}
        </text>
      ) : null}
      {mode === "normal" && !notice && current?.place.kind === "elsewhere" ? (
        <text fg={color.comment}>cannot open · {current.place.source ?? `pid ${current.pid}`}</text>
      ) : null}
      <text fg={notice ? color.peach : color.comment}>
        {mode === "confirm"
          ? hints(mode, pendingSession)
          : notice || (settings.cloud ? cloudSnapshot(false).problem : "") || hints(mode, current)}
      </text>
    </box>
  );
}

function hints(mode: Mode, current: Session | undefined): string {
  const action = current ? sessionAction(current) : undefined;
  switch (mode) {
    case "normal":
      return `j/k move · enter open · n new${action && "verb" in action ? ` · x ${action.verb}` : ""} · / filter · s settings · q quit`;
    case "filter":
      return "type to filter · enter keep · esc clear";
    case "agent":
      return "h/l or j/k pick agent · enter to pick a directory in fzf · esc cancel";
    case "confirm": {
      if (!current || !action) return "";
      if ("reason" in action) return action.reason;
      return `${action.verb} ${current.agent} in ${tilde(current.cwd)}? ${action.verb === "archive" ? "history kept; may archive children · " : ""}y to confirm, anything else cancels`;
    }
  }
}
