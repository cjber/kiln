import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runSessionAction, sessionAction } from "./actions";
import { claudeCloudSnapshot } from "./claude-cloud";
import { cloudSnapshot } from "./cloud";
import { focus } from "./kitty";
import { turnNotifications } from "./notifications";
import { sessionKey, sessionRows, sessionTitle } from "./session-list";
import { sessionSorts } from "./session-sort";
import { type Activity, type Agent, agents, listSessions, type Session } from "./sessions";
import { ensureSettingsFile, loadSettings, type Settings } from "./settings";
import { SkillsView } from "./skills-view";
import { attach, exists, start } from "./tmux";
import { useLatest } from "./use-latest";
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

function age(time: number | undefined, now: number): string {
  if (!time) return "unknown";
  const seconds = Math.max(0, Math.floor((now - time) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
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

type AppProps = {
  initialNotice?: string;
  initialSettings: Settings;
  onQuit: () => void;
  /** Where the list comes from; scripts/screenshots.tsx passes demo sessions. */
  loadSessions?: () => Promise<Session[]>;
};

export function App({ initialSettings, onQuit, loadSessions, initialNotice = "" }: AppProps) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [sessions, getSessions, setSessions] = useLatest<Session[]>([]);
  const [selected, getSelected, setSelected] = useLatest(0);
  const [mode, getMode, setMode] = useLatest<Mode>("normal");
  const [filter, getFilter, setFilter] = useLatest("");
  const [agentIndex, getAgentIndex, setAgentIndex] = useLatest(0);
  const [order, getOrder, setOrder] = useLatest(initialSettings.sort);
  const [expanded, getExpanded, setExpanded] = useLatest<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [pendingSession, getPendingSession, setPendingSession] = useLatest<Session | undefined>(undefined);
  const [notice, setNotice] = useState(initialNotice);
  const [settings, getSettings, setSettings] = useLatest(initialSettings);
  const [skillsProject, getSkillsProject, setSkillsProject] = useLatest<string | undefined>(undefined);
  const offered = agents.filter((agent) => settings.agents[agent].length);
  const refreshing = useRef(false);
  const notifications = useRef(turnNotifications());

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const loaded = await (loadSessions
        ? loadSessions()
        : listSessions({ cloud: getSettings().cloud, claudeCloud: getSettings().claudeCloud }));
      if (!loadSessions) notifications.current(loaded, getSettings().notifications);
      const before = sessionRows(getSessions(), getOrder(), getFilter(), getExpanded()).flatMap((row) =>
        row.kind === "session" ? [row.session] : [],
      );
      const current = before[Math.min(getSelected(), before.length - 1)];
      setSessions(loaded);
      const after = sessionRows(loaded, getOrder(), getFilter(), getExpanded()).flatMap((row) =>
        row.kind === "session" ? [row.session] : [],
      );
      const index = current ? after.findIndex((session) => sessionKey(session) === sessionKey(current)) : -1;
      setSelected(index >= 0 ? index : Math.max(0, Math.min(getSelected(), after.length - 1)));
    } catch {
      setNotice("session discovery failed; showing the last successful list");
    } finally {
      refreshing.current = false;
    }
  }, [getSettings, getSessions, getOrder, getFilter, getExpanded, getSelected, loadSessions, setSessions, setSelected]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const rows = useMemo(() => sessionRows(sessions, order, filter, expanded), [sessions, order, filter, expanded]);
  const visible = rows.flatMap((row) => (row.kind === "session" ? [row.session] : []));
  const current = visible[Math.min(selected, visible.length - 1)];
  const pageSize = Math.max(1, height - (mode === "agent" ? 5 : 4));
  const selectedRow = rows.findIndex((row) => row.kind === "session" && row.session === current);
  const firstRow = Math.max(0, selectedRow - pageSize + 1);

  const withTerminal = useCallback(
    async <T,>(action: () => T | Promise<T>): Promise<T> => {
      renderer.suspend();
      try {
        return await action();
      } finally {
        renderer.resume();
        await refresh();
      }
    },
    [refresh, renderer],
  );

  const handOver = useCallback(
    async (name: string) => {
      try {
        await withTerminal(() => attach(name, getSettings()));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "could not open this session");
      }
    },
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
          if (session.agent === "claude") {
            if (!Bun.which("xdg-open")) return setNotice("opening a Claude cloud session needs xdg-open on PATH");
            const child = Bun.spawn(["xdg-open", `https://claude.ai/code/${encodeURIComponent(session.place.id)}`], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            });
            if ((await child.exited) !== 0) setNotice("could not open this Claude cloud session in the browser");
            return;
          }
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
      const loaded = loadSettings();
      setSettings(loaded);
      setOrder(loaded.sort);
      await refresh();
      setNotice("settings reloaded");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [refresh, setSettings, setOrder, withTerminal]);

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
    if (getSkillsProject() !== undefined) return;
    // Shadow the render values with the latest ones; see useLatest.
    const mode = getMode();
    const agentIndex = getAgentIndex();
    const choices = agents.filter((agent) => getSettings().agents[agent].length);
    const visible = sessionRows(getSessions(), getOrder(), getFilter(), getExpanded()).flatMap((row) =>
      row.kind === "session" ? [row.session] : [],
    );
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
    if (key.name === "o") {
      const next = sessionSorts[(sessionSorts.indexOf(getOrder()) + 1) % sessionSorts.length];
      if (next) {
        setOrder(next);
        const reordered = sessionRows(getSessions(), next, getFilter(), getExpanded()).flatMap((row) =>
          row.kind === "session" ? [row.session] : [],
        );
        setSelected(Math.max(0, current ? reordered.indexOf(current) : 0));
      }
      return;
    }
    if ((key.name === "tab" || key.name === "right" || key.name === "left") && current) {
      const keyForCurrent = sessionKey(current);
      const next = new Set(getExpanded());
      if (key.name === "left" || next.has(keyForCurrent)) next.delete(keyForCurrent);
      else next.add(keyForCurrent);
      setExpanded(next);
      const reordered = sessionRows(getSessions(), getOrder(), getFilter(), next).flatMap((row) =>
        row.kind === "session" ? [row.session] : [],
      );
      setSelected(Math.max(0, reordered.indexOf(current)));
      return;
    }
    if (key.name === "r") return void refresh();
    if (key.name === "return" && current) return void open(current);
    if (key.name === "x" && current) {
      const action = sessionAction(current);
      if ("reason" in action) return setNotice(action.reason);
      setPendingSession(current);
      return setMode("confirm");
    }
    if (key.name === "s" && key.shift) {
      const cwd = current && current.place.kind !== "cloud" ? current.cwd : process.cwd();
      const root = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stderr: "ignore" });
      return setSkillsProject(root.exitCode === 0 ? root.stdout.toString().trim() : cwd);
    }
    if (key.name === "s") return void editSettings();
    if (key.name === "n") {
      if (!choices.length) return setNotice("every agent is hidden in settings; press s to add one");
      setAgentIndex(0);
      return setMode("agent");
    }
  });

  if (skillsProject !== undefined)
    return (
      <SkillsView
        project={skillsProject}
        onBack={() => setSkillsProject(undefined)}
        edit={async (path) => {
          const editor = Bun.env.VISUAL || Bun.env.EDITOR || "vi";
          await withTerminal(() => {
            const result = Bun.spawnSync(["sh", "-c", `${editor} "$1"`, "sh", path], {
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            });
            if (result.exitCode !== 0) throw new Error(`editor exited with status ${result.exitCode}`);
          });
        }}
      />
    );

  const titleWidth = Math.max(1, width - 26);

  return (
    <box flexDirection="column" backgroundColor={color.bg} paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text wrapMode="none">
        <span fg={color.fgBright} attributes={1}>
          kiln
        </span>
        <span fg={color.comment}>
          {" "}
          {visible.length} tasks · {order === "project" ? "directory / task" : order.replaceAll("_", " ")}
        </span>
        {filter ? <span fg={color.peach}> /{filter}</span> : null}
      </text>
      <box flexDirection="column" flexGrow={1}>
        {visible.length ? (
          <text wrapMode="none" fg={color.comment}>
            {`  ${"task".padEnd(titleWidth + 2)}${"status".padEnd(9)}${"updated".padStart(8)}`}
          </text>
        ) : null}
        {visible.length ? (
          rows.slice(firstRow, firstRow + pageSize).map((row) => {
            if (row.kind === "header")
              return (
                <text key={row.key} fg={color.fgBright} attributes={1}>
                  {fit(row.directory ? tilde(row.directory) : row.name, Math.max(1, width - 2), "end")}
                </text>
              );
            const { session, depth, children } = row;
            const active = session === current;
            const unavailable = session.place.kind === "elsewhere";
            const title = `${depth ? "↳ " : ""}${sessionTitle(session)}${children ? ` [${expanded.has(row.key) || filter ? "−" : "+"}${children}]` : ""}`;
            return (
              <box key={row.key} backgroundColor={active ? color.bg2 : undefined}>
                <text wrapMode="none">
                  <span fg={active ? color.peach : color.comment}>{active ? "› " : "  "}</span>
                  <span fg={unavailable ? color.comment : active ? color.peach : color.orange}>
                    {fit(title, titleWidth, "end").padEnd(titleWidth)}
                    {"  "}
                  </span>
                  <span fg={unavailable ? color.comment : activityColor(session.activity)}>
                    {(session.activity ?? "unknown").padEnd(9)}
                  </span>
                  <span fg={color.comment}>{age(session.lastActiveAt, now).padStart(8)}</span>
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
      {current ? (
        <text fg={color.comment}>
          {fit(
            `${current.agent}${current.branch ? ` · ${current.branch}` : ""} · ${label(current)} · updated ${current.lastActiveAt ? new Date(current.lastActiveAt).toISOString() : "unknown"}${current.place.kind === "elsewhere" ? " · cannot open this child" : ""}`,
            Math.max(1, width - 2),
            "end",
          )}
        </text>
      ) : null}
      <text wrapMode="none" fg={notice ? color.peach : color.comment}>
        {mode === "confirm"
          ? hints(mode, pendingSession)
          : notice ||
            (settings.cloud
              ? [cloudSnapshot(false).problem, settings.claudeCloud ? claudeCloudSnapshot(false).problem : ""]
                  .filter(Boolean)
                  .join(" · ")
              : "") ||
            hints(mode, current)}
      </text>
    </box>
  );
}

function hints(mode: Mode, current: Session | undefined): string {
  const action = current ? sessionAction(current) : undefined;
  switch (mode) {
    case "normal":
      return `j/k move · enter open · n new${action && "verb" in action ? ` · x ${action.verb}` : ""} · / filter · q quit`;
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
