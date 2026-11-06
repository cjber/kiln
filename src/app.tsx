import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PullRequest, pullRequests, type Stage, stageOf } from "./dashboard";
import { closeSession, createSession, type Outcome, openSession, sessionAction } from "./launcher";
import { flushInBackground } from "./messages";
import { nativeNotifications } from "./notifications";
import { sessionDetail } from "./session-detail";
import {
  resolveSelection,
  type Selection,
  selectionAt,
  sessionRows,
  sessionStatus,
  sessionTitle,
  type Tone,
  viewport,
  visibleSessions,
} from "./session-list";
import { sessionSorts } from "./session-sort";
import {
  type Agent,
  agentName,
  agents,
  discovery,
  keepLast,
  type Session,
  sessionDirectory,
  sessionIdentity,
} from "./sessions";
import { ensureSettingsFile, loadSettings, type Settings } from "./settings";
import { SkillsView } from "./skills-view";
import { attach } from "./tmux";
import { color, displayWidth, openInEditor, tilde, typed, untilde } from "./tui";
import { useLatest } from "./use-latest";
import { checkout } from "./workdir";
import { rankedDirectories } from "./zoxide";

const agentColor: Record<Agent, string> = {
  claude: color.orange,
  codex: color.teal,
  opencode: color.fgBright,
  pi: color.purple,
};

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

/** Fades the time since latest activity from green while fresh to the comment grey once stale. */
export function ageColor(time: number | undefined, now: number): string {
  if (!time) return color.comment;
  const seconds = (now - time) / 1_000;
  if (seconds < 60) return color.green;
  if (seconds < 600) return color.teal;
  if (seconds < 3600) return color.fgDim;
  return color.comment;
}

const stageColor: Record<Stage, string> = {
  working: color.comment,
  failing: color.red,
  checks: color.yellow,
  green: color.green,
  done: color.comment,
};
const stageMark: Record<Stage, string> = { working: "", failing: "✗", checks: "●", green: "✓", done: "merged" };

/** A pull request in the details line: its number, stage and check counts. */
function pullRequestLine(pr: PullRequest): string {
  const { passed, failed, running } = pr.checks;
  const checks = [passed && `${passed} passed`, failed && `${failed} failed`, running && `${running} running`]
    .filter(Boolean)
    .join(", ");
  const stage = { working: "closed", failing: "failing", checks: "checks running", green: "green", done: "merged" }[
    stageOf(pr)
  ];
  return `PR #${pr.number} ${pr.draft ? "draft · " : ""}${stage}${checks ? ` (${checks})` : ""}${pr.queued ? " · queued" : ""}`;
}

const toneColor: Record<Tone, string> = {
  active: color.fgDim,
  attention: color.yellow,
  done: color.green,
  muted: color.comment,
};

function label(session: Session): string {
  return session.place.kind === "cloud" ? session.place.title : tilde(sessionDirectory(session));
}

const graphemes = new Intl.Segmenter();

/** Shorten with an ellipsis by terminal columns, keeping the end of a path or the start of a title. */
function fit(value: string, width: number, cut: "start" | "end"): string {
  if (displayWidth(value) <= width) return value;
  const parts = Array.from(graphemes.segment(value), (part) => part.segment);
  if (cut === "start") parts.reverse();
  const kept: string[] = [];
  let used = 1; // one column for the ellipsis
  for (const part of parts) {
    if (used + displayWidth(part) > width) break;
    used += displayWidth(part);
    kept.push(part);
  }
  return cut === "start" ? `…${kept.reverse().join("")}` : `${kept.join("")}…`;
}

/** Join hints in their written order, dropping the lowest priority ones (latest in `byPriority`) until they fit. */
function fitHints(hints: readonly string[], byPriority: readonly string[], width: number): string {
  const kept = new Set(hints);
  for (const hint of [...byPriority].reverse()) {
    if (displayWidth([...kept].join(" · ")) <= width || kept.size === 1) break;
    kept.delete(hint);
  }
  return fit([...kept].join(" · "), width, "end");
}

/** The first wording that fits, longest first; the last one is cut with an ellipsis when even it does not. */
function firstFit(options: readonly string[], width: number): string {
  const line = options.find((option) => displayWidth(option) <= width) ?? options.at(-1) ?? "";
  return fit(line, width, "end");
}

/** When a session was last active, or when it started if it never reported activity. */
function updated(session: Session, now: number): string {
  return session.lastActiveAt || !session.startedAt
    ? `updated ${age(session.lastActiveAt, now)}`
    : `started ${age(session.startedAt, now)}`;
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
  /** Pull requests for session branches; demo and test lists look none up unless given one. */
  prs?: ReturnType<typeof pullRequests>;
};

export function App({ initialSettings, onQuit, loadSessions, initialNotice = "", prs: givenPrs }: AppProps) {
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
  const prs = useMemo(() => givenPrs ?? pullRequests(loadSessions ? { gh: false } : {}), [givenPrs, loadSessions]);
  const [pulls, setPulls] = useState<ReadonlyMap<string, PullRequest[]>>(new Map());
  const [changes, setChanges] = useState<ReadonlyMap<string, number>>(new Map());
  const changeCache = useRef(new Map<string, { count?: number; checkedAt: number; pending: boolean }>());
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

  /** Count uncommitted files per checkout off the render path, at most once per list refresh. */
  const countChanges = useCallback((sessions: readonly Session[]) => {
    const roots = new Set<string>();
    for (const session of sessions) {
      const root = checkout(sessionDirectory(session));
      if (root) roots.add(root);
    }
    for (const [root, entry] of changeCache.current)
      if (!roots.has(root) && !entry.pending) changeCache.current.delete(root);
    const publish = () =>
      setChanges(
        new Map(
          [...changeCache.current].flatMap(([root, entry]) =>
            entry.count === undefined ? [] : [[root, entry.count] as [string, number]],
          ),
        ),
      );
    for (const root of roots) {
      const cached = changeCache.current.get(root);
      if (cached?.pending || (cached && Date.now() - cached.checkedAt < refreshMs)) continue;
      changeCache.current.set(root, { count: cached?.count, checkedAt: Date.now(), pending: true });
      const child = Bun.spawn(["git", "-C", root, "status", "--porcelain"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      void (async () => {
        try {
          const output = await new Response(child.stdout).text();
          const code = await child.exited;
          const entry = changeCache.current.get(root);
          changeCache.current.set(root, {
            count: code === 0 ? output.split("\n").filter(Boolean).length : entry?.count,
            checkedAt: Date.now(),
            pending: false,
          });
        } catch {
          const entry = changeCache.current.get(root);
          changeCache.current.set(root, { count: entry?.count, checkedAt: Date.now(), pending: false });
        }
        publish();
      })();
    }
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const found = await discover();
      setSessions(found.sessions);
      setProblem(found.problem);
      countChanges(found.sessions);
      const foundPrs = new Map<string, PullRequest[]>();
      for (const session of found.sessions) {
        const list = prs.of(session);
        if (list.length) foundPrs.set(sessionIdentity(session), list);
      }
      if (!found.stale) prs.sweep();
      setPulls(foundPrs);
      if (!found.stale) {
        notifyNative(found.sessions, getSettings().notifications);
        // Fixture sessions in tests are not real recipients.
        if (!loadSessions) flushInBackground(found.sessions);
      }
      // Re-anchor the cursor so it rests beside its session if that session later goes away.
      setSelection(resolveSelection(view(found.sessions), getSelection()));
    } finally {
      refreshing.current = false;
    }
  }, [
    discover,
    view,
    getSettings,
    getSelection,
    setSessions,
    setSelection,
    notifyNative,
    loadSessions,
    prs,
    countChanges,
  ]);

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
  const shown = viewport(rows, Math.max(0, selectedRow), pageSize);

  const withTerminal = useCallback(
    async <T,>(action: () => T | Promise<T>): Promise<T> => {
      // OpenTUI hands the terminal back asynchronously; tmux must not start until it has.
      await renderer.suspend();
      try {
        return await action();
      } finally {
        await renderer.resume();
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
          ? `${{ close: "closed", archive: "archived", delete: "deleted", forget: "forgot" }[action.verb]} ${agentName(session.agent)} in ${tilde(sessionDirectory(session))}`
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
    if ((key.name === "space" || key.name === "tab" || key.name === "right" || key.name === "left") && current) {
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

  // Drop the updated and status columns before the title on narrow terminals, so the columns never collide.
  const showUpdated = width >= 48;
  const showStatus = width >= 30;
  // The pull request column only appears once something has one, and only where the title keeps its room.
  const showPr = width >= 72 && pulls.size > 0;
  const titleWidth = Math.max(1, width - 38 + (showUpdated ? 0 : 8) + (showStatus ? 0 : 12) - (showPr ? 10 : 0));
  const currentPr = current && pulls.get(sessionIdentity(current));
  const needsInput = sessions.filter((session) => session.activity === "waiting").length;
  const header = headerLine(width - 2, sessions.length, order, needsInput, filter);
  const detailLine = (session: Session, key: string) => {
    const root = checkout(sessionDirectory(session));
    return sessionDetail(session, {
      prs: pulls.get(key),
      changes: root ? changes.get(root) : undefined,
    });
  };

  return (
    <box flexDirection="column" backgroundColor={color.bg} paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text wrapMode="none">
        <span fg={color.fgBright} attributes={1}>
          kiln
        </span>
        <span fg={color.comment}>{header.summary}</span>
        <span fg={color.yellow}>{header.waiting}</span>
        <span fg={color.peach}>{header.query}</span>
      </text>
      <box flexDirection="column" flexGrow={1}>
        {visible.length ? (
          <text wrapMode="none" fg={color.comment}>
            {`  ${"harness".padEnd(9)}${"task".padEnd(titleWidth + 2)}${showStatus ? "status".padEnd(12) : ""}${showPr ? "pr".padEnd(10) : ""}${showUpdated ? "updated".padStart(8) : ""}`}
          </text>
        ) : null}
        {visible.length ? (
          (shown.pinned ? [shown.pinned, ...shown.rows] : shown.rows).map((row) => {
            if (row.kind === "header")
              return (
                <text key={row.key} fg={color.orange} attributes={1}>
                  {fit(row.directory ? tilde(row.directory) : row.name, Math.max(1, width - 2), "end")}
                </text>
              );
            const { session, depth, children } = row;
            const active = session === current;
            const title = `${depth ? "↳ " : ""}${sessionTitle(session)}`;
            const open = children > 0 && (expanded.has(row.key) || filter !== "");
            const count = children ? ` ${children}` : "";
            const titleRoom = Math.max(1, titleWidth - displayWidth(count));
            const fitted = fit(title, titleRoom, "end");
            const padding = " ".repeat(Math.max(0, titleWidth - displayWidth(fitted) - displayWidth(count)));
            const indent = "  ".repeat(depth + 2);
            return (
              <box key={row.key} flexDirection="column" backgroundColor={active ? color.bg2 : undefined}>
                <text wrapMode="none">
                  <span fg={active ? color.peach : color.comment}>{active ? (open ? "⌄ " : "› ") : "  "}</span>
                  <span fg={agentColor[session.agent]}>{agentName(session.agent).padEnd(9)}</span>
                  <span fg={toneColor[sessionStatus(session).tone]}>{fitted}</span>
                  {count ? <span fg={color.comment}>{count}</span> : null}
                  <span fg={toneColor[sessionStatus(session).tone]}>
                    {padding}
                    {"  "}
                  </span>
                  {showStatus ? (
                    <span fg={toneColor[sessionStatus(session).tone]}>{sessionStatus(session).label.padEnd(12)}</span>
                  ) : null}
                  {showPr ? <PrCell prs={pulls.get(row.key)} /> : null}
                  {showUpdated ? (
                    <span fg={ageColor(session.lastActiveAt, now)}>{age(session.lastActiveAt, now).padStart(8)}</span>
                  ) : null}
                </text>
                <text wrapMode="none" fg={color.comment}>
                  {`${indent}${fit(detailLine(session, row.key), Math.max(1, width - 2 - displayWidth(indent)), "end")}`}
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
              {index === agentIndex ? `[${agentName(agent)}]` : ` ${agentName(agent)} `}{" "}
            </span>
          ))}
        </text>
      ) : null}
      {current ? (
        <text fg={color.comment}>
          {fit(
            `${agentName(current.agent)}${current.branch ? ` · ${current.branch}` : ""}${currentPr ? ` · ${currentPr.map(pullRequestLine).join(" · ")}` : ""} · ${label(current)} · ${sessionStatus(current).hint} · ${updated(current, now)}`,
            Math.max(1, width - 2),
            "end",
          )}
        </text>
      ) : null}
      <text wrapMode="none" fg={notice || problem ? color.peach : color.comment}>
        {mode === "confirm"
          ? hints(mode, pendingSession, width - 2, filter)
          : notice || problem
            ? fit(notice || problem, width - 2, "end")
            : hints(mode, current, width - 2, filter)}
      </text>
    </box>
  );
}

/**
 * The title line by priority: the waiting count and the filter query stay, the sort label and then the task count go
 * first, and a long query keeps its end, where the typing happens.
 */
function headerLine(
  width: number,
  tasks: number,
  order: Settings["sort"],
  waiting: number,
  filter: string,
): { summary: string; waiting: string; query: string } {
  const sort = order === "project" ? "repository / task" : order.replaceAll("_", " ");
  // No count at zero: the list already shows whether anything waits.
  const waitingText = waiting ? ` · ${waiting} need input` : "";
  // Columns left after the summary for ` /query`, keeping at least one character of the query.
  const room = (summary: string) => width - displayWidth(`kiln${summary}${waitingText}`) - (filter ? 3 : 0);
  const summary = [` ${tasks} tasks · ${sort}`, ` ${tasks} tasks`, ""].find((option) => room(option) >= 0) ?? "";
  const query = filter && room(summary) >= 0 ? ` /${fit(filter, room(summary) + 1, "start")}` : "";
  return { summary, waiting: waitingText, query };
}

function hints(mode: Mode, current: Session | undefined, width: number, filter: string): string {
  const action = current ? sessionAction(current) : undefined;
  switch (mode) {
    case "normal": {
      const close = action && "verb" in action ? `x ${action.verb}` : undefined;
      const shown = [
        current && "j/k move",
        current && "enter open",
        current && "space expand",
        filter && "esc clear",
        "n new",
        close,
        "/ filter",
        "q quit",
      ].filter((hint): hint is string => Boolean(hint));
      return fitHints(
        shown,
        ["q quit", "enter open", "space expand", "esc clear", "/ filter", "n new", "j/k move", close ?? ""],
        width,
      );
    }
    case "filter":
      return fitHints(
        ["type to filter", "enter keep", "esc clear"],
        ["esc clear", "enter keep", "type to filter"],
        width,
      );
    case "agent":
      return firstFit(
        [
          "h/l or j/k pick agent · enter to pick a directory in fzf · esc cancel",
          "h/l pick · enter pick directory · esc cancel",
          "h/l pick · enter dir · esc cancel",
          "enter dir · esc cancel",
        ],
        width,
      );
    case "confirm": {
      if (!current || !action) return "";
      if ("reason" in action) return fit(action.reason, width, "end");
      const question = `${action.verb} ${agentName(current.agent)}`;
      return firstFit(
        [
          `${question} in ${tilde(sessionDirectory(current))}? y to confirm, anything else cancels`,
          `${question}? y to confirm, anything else cancels`,
          `${question}? y confirms, else cancels`,
          `${question}? y confirms`,
        ],
        width,
      );
    }
  }
}

/** `#212 ✗`, or `#212+3 ✗` with three more, ten columns wide, coloured by the most urgent pull request. */
function PrCell({ prs }: { prs: readonly PullRequest[] | undefined }) {
  const pr = prs?.[0];
  if (!pr) return <span>{" ".repeat(10)}</span>;
  const stage = stageOf(pr);
  const more = prs.length > 1 ? `+${prs.length - 1}` : "";
  return (
    <span fg={stageColor[stage]}>{fit(`#${pr.number}${more} ${stageMark[stage]}`.trim(), 9, "end").padEnd(10)}</span>
  );
}
