import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { closeSession, createSession, type Outcome, openSession, sessionAction } from "./launcher";
import { nativeNotifications } from "./notifications";
import {
  resolveSelection,
  type Selection,
  selectionAt,
  sessionRows,
  sessionStatus,
  sessionTitle,
  type Tone,
  visibleSessions,
} from "./session-list";
import { sessionSorts } from "./session-sort";
import { type Agent, agents, discovery, keepLast, type Session, sessionIdentity } from "./sessions";
import { ensureSettingsFile, loadSettings, type Settings } from "./settings";
import { SkillsView } from "./skills-view";
import { attach } from "./tmux";
import { color, openInEditor, tilde, typed, untilde } from "./tui";
import { useLatest } from "./use-latest";
import { rankedDirectories } from "./zoxide";

const agentColor: Record<Agent, string> = { claude: color.orange, codex: color.teal, pi: color.purple };

type Mode = "normal" | "filter" | "agent" | "confirm";

const refreshMs = 2_000;

function age(time: number | undefined, now: number): string {
  if (!time) return "unknown";
  const seconds = Math.max(0, Math.floor((now - time) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const toneColor: Record<Tone, string> = {
  active: color.fgDim,
  attention: color.yellow,
  done: color.green,
  muted: color.comment,
};

function label(session: Session): string {
  return session.place.kind === "cloud" ? session.place.title : tilde(session.cwd);
}

/** Shorten with an ellipsis, keeping the end of a path (the repo) or the start of a branch. */
function fit(value: string, width: number, cut: "start" | "end"): string {
  if (value.length <= width) return value;
  return cut === "start" ? `…${value.slice(value.length - width + 1)}` : `${value.slice(0, width - 1)}…`;
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
  const [selection, getSelection, setSelection] = useLatest<Selection>({ index: 0 });
  const [mode, getMode, setMode] = useLatest<Mode>("normal");
  const [filter, getFilter, setFilter] = useLatest("");
  const [agentIndex, getAgentIndex, setAgentIndex] = useLatest(0);
  const [order, getOrder, setOrder] = useLatest(initialSettings.sort);
  const [expanded, getExpanded, setExpanded] = useLatest<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [pendingSession, getPendingSession, setPendingSession] = useLatest<Session | undefined>(undefined);
  const [notice, setNotice] = useState(initialNotice);
  const [problem, setProblem] = useState("");
  const [settings, getSettings, setSettings] = useLatest(initialSettings);
  const [skillsProject, getSkillsProject, setSkillsProject] = useLatest<string | undefined>(undefined);
  const offered = agents.filter((agent) => settings.agents[agent].length);
  const refreshing = useRef(false);
  const notifyNative = useMemo(() => nativeNotifications(), []);
  const discover = useMemo(() => {
    if (loadSessions) return keepLast(loadSessions, "Session discovery");
    const find = discovery();
    return () => find({ cloud: getSettings().cloud, claudeCloud: getSettings().claudeCloud });
  }, [loadSessions, getSettings]);
  const view = useCallback(
    (sessions: readonly Session[] = getSessions()) =>
      visibleSessions(sessionRows(sessions, getOrder(), getFilter(), getExpanded())),
    [getSessions, getOrder, getFilter, getExpanded],
  );

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const found = await discover();
      setSessions(found.sessions);
      setProblem(found.problem);
      if (!found.stale) notifyNative(found.sessions, getSettings().notifications);
      // Re-anchor the cursor so it rests beside its session if that session later goes away.
      setSelection(resolveSelection(view(found.sessions), getSelection()));
    } finally {
      refreshing.current = false;
    }
  }, [discover, view, getSettings, getSelection, setSessions, setSelection, notifyNative]);

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
  const visible = visibleSessions(rows);
  const current = visible[resolveSelection(visible, selection).index];
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

  const follow = useCallback(
    async (outcome: Outcome) => {
      switch (outcome.kind) {
        case "attach":
          await handOver(outcome.name);
          if (outcome.notice) setNotice(outcome.notice);
          return;
        case "notice":
          return setNotice(outcome.text);
        case "done":
          return;
      }
    },
    [handOver],
  );

  const create = useCallback(
    async (agent: Agent) => {
      if (!Bun.which("fzf")) return setNotice("choosing a directory needs fzf on PATH");
      const settings = getSettings();
      const cwd = await withTerminal(() => pickDirectory(settings.zoxide ? rankedDirectories() : []));
      if (cwd) await follow(await createSession(agent, cwd, settings));
    },
    [getSettings, withTerminal, follow],
  );

  /** Settings are a file: open it in $EDITOR, then re-read it, keeping the old ones if the edit does not parse. */
  const editSettings = useCallback(async () => {
    const path = ensureSettingsFile();
    await withTerminal(() => openInEditor(path));
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
      const closed = await closeSession(session);
      setNotice(
        closed === true && "verb" in action
          ? `${{ close: "closed", archive: "archived", delete: "deleted", forget: "forgot" }[action.verb]} ${session.agent} in ${tilde(session.cwd)}`
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
    const visible = view();
    const at = resolveSelection(visible, getSelection()).index;
    const current = visible[at];
    const move = (delta: number) => setSelection(selectionAt(visible, at + delta));

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
        setSelection({ index: 0 });
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
    if (key.name === "g" && !key.shift) return setSelection(selectionAt(visible, 0));
    if (key.name === "g" && key.shift) return setSelection(selectionAt(visible, visible.length - 1));
    if (key.ctrl && key.name === "d") return move(10);
    if (key.ctrl && key.name === "u") return move(-10);
    if (key.name === "/") return setMode("filter");
    if (key.name === "o") {
      const next = sessionSorts[(sessionSorts.indexOf(getOrder()) + 1) % sessionSorts.length];
      if (next) setOrder(next);
      return;
    }
    if ((key.name === "tab" || key.name === "right" || key.name === "left") && current) {
      const identity = sessionIdentity(current);
      const next = new Set(getExpanded());
      if (key.name === "left" || next.has(identity)) next.delete(identity);
      else next.add(identity);
      return setExpanded(next);
    }
    if (key.name === "r") return void refresh();
    if (key.name === "return" && current) return void openSession(current, getSettings()).then(follow);
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
          const code = await withTerminal(() => openInEditor(path));
          if (code !== 0) throw new Error(`editor exited with status ${code}`);
        }}
      />
    );

  const titleWidth = Math.max(1, width - 37);
  const needsInput = sessions.filter((session) => session.activity === "waiting").length;

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
        {needsInput ? <span fg={color.yellow}> · {needsInput} need input</span> : null}
        {filter ? <span fg={color.peach}> /{filter}</span> : null}
      </text>
      <box flexDirection="column" flexGrow={1}>
        {visible.length ? (
          <text wrapMode="none" fg={color.comment}>
            {`  ${"harness".padEnd(8)}${"task".padEnd(titleWidth + 2)}${"status".padEnd(12)}${"updated".padStart(8)}`}
          </text>
        ) : null}
        {visible.length ? (
          rows.slice(firstRow, firstRow + pageSize).map((row) => {
            if (row.kind === "header")
              return (
                <text key={row.key} fg={color.orange} attributes={1}>
                  {fit(row.directory ? tilde(row.directory) : row.name, Math.max(1, width - 2), "end")}
                </text>
              );
            const { session, depth, children } = row;
            const active = session === current;
            const title = `${depth ? "↳ " : ""}${sessionTitle(session)}${children ? ` [${expanded.has(row.key) || filter ? "−" : "+"}${children}]` : ""}`;
            return (
              <box key={row.key} backgroundColor={active ? color.bg2 : undefined}>
                <text wrapMode="none">
                  <span fg={active ? color.peach : color.comment}>{active ? "› " : "  "}</span>
                  <span fg={agentColor[session.agent]}>{session.agent.padEnd(8)}</span>
                  <span fg={toneColor[sessionStatus(session).tone]}>
                    {fit(title, titleWidth, "end").padEnd(titleWidth)}
                    {"  "}
                  </span>
                  <span fg={toneColor[sessionStatus(session).tone]}>{sessionStatus(session).label.padEnd(12)}</span>
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
            `${current.agent}${current.branch ? ` · ${current.branch}` : ""} · ${label(current)} · ${sessionStatus(current).hint} · updated ${current.lastActiveAt ? new Date(current.lastActiveAt).toISOString() : "unknown"}`,
            Math.max(1, width - 2),
            "end",
          )}
        </text>
      ) : null}
      <text wrapMode="none" fg={notice || problem ? color.peach : color.comment}>
        {mode === "confirm" ? hints(mode, pendingSession, width) : notice || problem || hints(mode, current, width)}
      </text>
    </box>
  );
}

function hints(mode: Mode, current: Session | undefined, width: number): string {
  const action = current ? sessionAction(current) : undefined;
  switch (mode) {
    case "normal":
      if (width < 45) return "enter open · q quit";
      if (width < 80) return "enter open · / filter · n new · q quit";
      return `j/k move · enter open · n new${action && "verb" in action ? ` · x ${action.verb}` : ""} · / filter · q quit`;
    case "filter":
      return "type to filter · enter keep · esc clear";
    case "agent":
      return "h/l or j/k pick agent · enter to pick a directory in fzf · esc cancel";
    case "confirm": {
      if (!current || !action) return "";
      if ("reason" in action) return action.reason;
      return `${action.verb} ${current.agent} in ${tilde(current.cwd)}? y to confirm, anything else cancels`;
    }
  }
}
