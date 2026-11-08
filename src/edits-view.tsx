import { readFileSync } from "node:fs";
import { extname } from "node:path";
import {
  type LineColorConfig,
  type LineNumberRenderable,
  type LineSign,
  RGBA,
  type ScrollBoxRenderable,
  SyntaxStyle,
} from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { blame, type Owned } from "./blame";
import { fileHistory, type Ledger, splitLines, type Turn, turnSummaries, type Writer } from "./edits";
import { reachable } from "./messages";
import { type Agent, agentName, type Session, sessionDirectory, sessionIdentity } from "./sessions";
import { color, displayWidth, tilde, typed } from "./tui";
import { useLatest } from "./use-latest";
import { checkout } from "./workdir";

export const agentColor: Record<Agent, string> = {
  claude: color.peach,
  codex: color.teal,
  opencode: color.fgBright,
  pi: color.purple,
};

/** Line backgrounds: the turn being reviewed, lines written since the view opened, the cursor and a selection. */
const shade = { turn: "#1f2a1c", fresh: "#33452a", cursor: "#2c2c2c", selected: "#2b2b45" };

/** The grammars OpenTUI bundles; any other file shows as plain text. */
const filetypes: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".md": "markdown",
  ".zig": "zig",
};

const syntax = {
  default: color.fg,
  keyword: color.orange,
  "keyword.import": color.orange,
  "keyword.operator": color.orange,
  string: color.green,
  comment: color.comment,
  number: color.yellow,
  boolean: color.yellow,
  constant: color.yellow,
  function: color.peach,
  "function.call": color.peach,
  "function.method.call": color.peach,
  type: color.teal,
  constructor: color.teal,
  property: color.fgBright,
  "variable.member": color.fgBright,
  operator: color.fgDim,
  punctuation: color.fgDim,
  "punctuation.bracket": color.fgDim,
  "markup.heading": color.orange,
};

export type EditsViewProps = {
  /** The session whose edits are reviewed. */
  session: Session;
  /** Every listed session, so lines another agent wrote are credited to it. */
  sessions: readonly Session[];
  read: (session: Session) => Ledger;
  /** Put a question in front of a session; resolves to what to tell the person. */
  ask: (to: Session, body: string) => Promise<string>;
  onBack: () => void;
  /** Open straight into following the session's newest edit. */
  follow?: boolean;
  readText?: (path: string) => string | undefined;
};

type Row = { kind: "turn"; turn: number } | { kind: "file"; turn: number; file: string };

type FileState = { file: string; turn: number; cursor: number; anchor?: number };

const readDisk = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const ago = (time: number | undefined, now: number) => {
  if (!time) return "";
  const seconds = Math.max(0, Math.floor((now - time) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/** Cut to `width` columns with an ellipsis. */
function clip(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  for (const char of text) {
    if (displayWidth(`${out}${char}`) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

/** The file's path inside its checkout, else with `~`. */
function shortPath(file: string): string {
  const root = checkout(file);
  return root ? file.slice(root.length + 1) : tilde(file);
}

/**
 * The sessions whose edits can reach a file: the reviewed one, any working in the file's checkout, and any whose
 * directory holds it. Reading only these keeps opening a file from reading every transcript kiln lists.
 */
function candidates(sessions: readonly Session[], session: Session, file: string): Session[] {
  const root = checkout(file);
  const holds = (directory: string) =>
    file.startsWith(`${directory}/`) || (root !== undefined && checkout(directory) === root);
  const near = sessions.filter(
    (other) => other.id && other.place.kind !== "cloud" && (holds(sessionDirectory(other)) || holds(other.cwd)),
  );
  return near.some((other) => sessionIdentity(other) === sessionIdentity(session)) ? near : [session, ...near];
}

export function EditsView({
  session,
  sessions,
  read,
  ask,
  onBack,
  follow = false,
  readText = readDisk,
}: EditsViewProps) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const style = useMemo(
    () =>
      SyntaxStyle.fromStyles(
        Object.fromEntries(Object.entries(syntax).map(([name, hex]) => [name, { fg: RGBA.fromHex(hex) }])),
        renderer.nativeScene,
      ),
    [renderer],
  );
  useEffect(() => () => style.destroy(), [style]);
  const [now, setNow] = useState(Date.now());
  const [tick, setTick] = useState(0);
  const [selected, getSelected, setSelected] = useLatest(0);
  const [open, getOpen, setOpen] = useLatest<FileState | undefined>(undefined);
  const [following, getFollowing, setFollowing] = useLatest(follow);
  const [question, getQuestion, setQuestion] = useLatest<string | undefined>(undefined);
  const [notice, setNotice] = useState("");
  /** Lines written after this moment are new since the person started looking. */
  const opened = useRef(Date.now());
  const gutter = useRef<LineNumberRenderable | null>(null);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const followed = useRef<string | undefined>(undefined);

  // The list refreshes sessions every two seconds; the file on disk is read again on the same beat.
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
      setTick((value) => value + 1);
    }, 2_000);
    return () => clearInterval(interval);
  }, []);

  const ledger = read(session);
  const turns = useMemo(() => turnSummaries(ledger), [ledger, ledger.edits.length, ledger.turns.length]);
  const rows = useMemo<Row[]>(
    () =>
      turns.flatMap((turn): Row[] => [
        { kind: "turn", turn: turn.turn },
        ...turn.files.map((file) => ({ kind: "file" as const, turn: turn.turn, file: file.file })),
      ]),
    [turns],
  );

  // Follow: open the newest edit's file at its first surviving line whenever the session makes a new one.
  const newest = ledger.edits.at(-1);
  useEffect(() => {
    if (!following || !newest || followed.current === newest.id) return;
    followed.current = newest.id;
    setOpen({ file: newest.file, turn: newest.turn, cursor: -1 });
  }, [following, newest, setOpen]);

  const file = open?.file;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-reads the file on the refresh beat.
  const text = useMemo(() => (file ? readText(file) : undefined), [file, tick, readText]);
  const lines = useMemo(() => (text === undefined ? [] : splitLines(text)), [text]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a refresh adds edits to the same ledger objects, so `tick` recomputes.
  const history = useMemo(
    () => (file ? fileHistory(candidates(sessions, session, file), read, file) : []),
    [file, sessions, session, read, tick],
  );
  const owners = useMemo(() => blame(lines, history), [lines, history]);

  // A followed file opens at the newest edit's first line still on disk.
  useEffect(() => {
    if (!open || open.cursor !== -1) return;
    const target = owners.findIndex((owned) => owned?.edit.id === newest?.id);
    const first = target !== -1 ? target : owners.findIndex((owned) => owned?.owner.turn === ledger.turns[open.turn]);
    setOpen({ ...open, cursor: Math.max(0, first) });
  }, [open, owners, newest, ledger.turns, setOpen]);

  const bodyHeight = Math.max(1, height - 3);
  const cursor = Math.max(0, Math.min(open?.cursor ?? 0, lines.length - 1));

  // Keep the cursor on screen with a line of margin.
  useEffect(() => {
    const box = scroll.current;
    if (!box || !open) return;
    const top = box.scrollTop;
    if (cursor < top + 1) box.scrollTo(Math.max(0, cursor - 1));
    else if (cursor > top + bodyHeight - 2) box.scrollTo(cursor - bodyHeight + 2);
  }, [cursor, bodyHeight, open]);

  const { signs, colours } = useMemo(() => {
    const signs = new Map<number, LineSign>();
    const colours = new Map<number, LineColorConfig>();
    if (!open) return { signs, colours };
    const [low, high] =
      open.anchor === undefined ? [-1, -1] : [Math.min(open.anchor, cursor), Math.max(open.anchor, cursor)];
    owners.forEach((owned, index) => {
      if (owned) signs.set(index, { before: "▌", beforeColor: agentColor[owned.owner.session.agent] });
      const fresh = owned?.edit.at !== undefined && owned.edit.at > opened.current;
      const background =
        index >= low && index <= high
          ? shade.selected
          : index === cursor
            ? shade.cursor
            : fresh
              ? shade.fresh
              : inTurn(owned, session, ledger.turns[open.turn])
                ? shade.turn
                : undefined;
      if (background) colours.set(index, { gutter: color.bg, content: background });
      if (!owned && !signs.has(index)) signs.set(index, { before: " " });
    });
    return { signs, colours };
  }, [owners, open, cursor, session, ledger.turns]);

  // OpenTUI reads `lineSigns` and `lineColors` only when the gutter is made; later changes go through its setters.
  useEffect(() => {
    gutter.current?.setLineSigns(signs);
    gutter.current?.setLineColors(colours);
  }, [signs, colours]);

  /** Runs of lines one edit wrote, as [first, last] pairs: the changes `]` and `[` step through. */
  const runs = useMemo(() => {
    const found: [number, number][] = [];
    owners.forEach((owned, index) => {
      if (!owned) return;
      const last = found.at(-1);
      if (last && last[1] === index - 1 && owners[index - 1]?.edit === owned.edit) last[1] = index;
      else found.push([index, index]);
    });
    return found;
  }, [owners]);

  const moveFile = (delta: number) => {
    const state = getOpen();
    if (!state) return;
    const files = turns.find((turn) => turn.turn === state.turn)?.files ?? [];
    const index = files.findIndex((entry) => entry.file === state.file);
    const next = files[(index + delta + files.length) % files.length];
    if (next) setOpen({ file: next.file, turn: state.turn, cursor: -1 });
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return onBack();
    setNotice("");
    const state = getOpen();
    const draft = getQuestion();
    if (draft !== undefined) {
      if (key.name === "escape") return setQuestion(undefined);
      if (key.name === "backspace") return setQuestion(draft.slice(0, -1));
      if (key.name === "return") {
        setQuestion(undefined);
        if (!state || !draft.trim()) return;
        const [low, high] =
          state.anchor === undefined
            ? [state.cursor, state.cursor]
            : [Math.min(state.anchor, state.cursor), Math.max(state.anchor, state.cursor)];
        const to = recipient(owners.slice(low, high + 1), session);
        const excerpt = lines.slice(low, high + 1).join("\n");
        const range = low === high ? `line ${low + 1}` : `lines ${low + 1}-${high + 1}`;
        const body = `About ${state.file} ${range}, which you wrote:\n\n\`\`\`\n${excerpt}\n\`\`\`\n\n${draft.trim()}`;
        setOpen({ ...state, anchor: undefined });
        void ask(to, body).then(setNotice);
        return;
      }
      const typedText = typed(key);
      if (typedText) setQuestion(draft + typedText);
      return;
    }

    if (!state) {
      const at = Math.min(getSelected(), Math.max(0, rows.length - 1));
      const row = rows[at];
      if (key.name === "q" || key.name === "escape" || key.name === "left") return onBack();
      if (key.name === "j" || key.name === "down") return setSelected(Math.min(rows.length - 1, at + 1));
      if (key.name === "k" || key.name === "up") return setSelected(Math.max(0, at - 1));
      if (key.name === "g" && !key.shift) return setSelected(0);
      if (key.name === "g" && key.shift) return setSelected(Math.max(0, rows.length - 1));
      if (key.name === "f") {
        followed.current = undefined;
        return setFollowing(true);
      }
      if ((key.name === "return" || key.name === "right" || key.name === "l") && row) {
        const target = row.kind === "file" ? row.file : turns.find((turn) => turn.turn === row.turn)?.files[0]?.file;
        if (target) setOpen({ file: target, turn: row.turn, cursor: -1 });
      }
      return;
    }

    const last = Math.max(0, lines.length - 1);
    const go = (line: number) => {
      // Moving by hand stops following, so the view never jumps away from what the person is reading.
      if (getFollowing()) setFollowing(false);
      setOpen({ ...state, cursor: Math.max(0, Math.min(last, line)) });
    };
    const current = Math.max(0, Math.min(state.cursor, last));
    if (key.name === "q" || key.name === "escape" || key.name === "h" || key.name === "left") {
      if (state.anchor !== undefined && key.name === "escape") return setOpen({ ...state, anchor: undefined });
      setFollowing(false);
      return setOpen(undefined);
    }
    if (key.name === "j" || key.name === "down") return go(current + 1);
    if (key.name === "k" || key.name === "up") return go(current - 1);
    if (key.ctrl && key.name === "d") return go(current + Math.floor(bodyHeight / 2));
    if (key.ctrl && key.name === "u") return go(current - Math.floor(bodyHeight / 2));
    if (key.name === "g" && !key.shift) return go(0);
    if (key.name === "g" && key.shift) return go(last);
    if (key.name === "]" || key.sequence === "]") {
      const next = runs.find(([first]) => first > current);
      return next ? go(next[0]) : setNotice("no later change in this file");
    }
    if (key.name === "[" || key.sequence === "[") {
      const previous = runs.findLast(([first]) => first < current);
      return previous ? go(previous[0]) : setNotice("no earlier change in this file");
    }
    if (key.name === "n" && !key.shift) return moveFile(1);
    if (key.name === "n" && key.shift) return moveFile(-1);
    if (key.name === "v") return setOpen({ ...state, anchor: state.anchor === undefined ? current : undefined });
    if (key.name === "f") {
      followed.current = undefined;
      return setFollowing(!getFollowing());
    }
    if (key.name === "a") return setQuestion("");
  });

  if (!open) {
    const at = Math.min(selected, Math.max(0, rows.length - 1));
    const listHeight = Math.max(1, height - 3);
    const start = Math.max(0, Math.min(at - Math.floor(listHeight / 2), rows.length - listHeight));
    return (
      <box flexDirection="column" backgroundColor={color.bg} paddingLeft={1} paddingRight={1} flexGrow={1}>
        <text wrapMode="none">
          <span fg={color.fgBright} attributes={1}>
            kiln edits
          </span>
          <span fg={agentColor[session.agent]}> {agentName(session.agent)}</span>
          <span fg={color.comment}>{clip(` ${tilde(sessionDirectory(session))}`, Math.max(1, width - 20))}</span>
        </text>
        <box flexDirection="column" flexGrow={1}>
          {rows.length ? (
            rows.slice(start, start + listHeight).map((row, offset) => {
              const index = start + offset;
              const active = index === at;
              const turn = turns.find((entry) => entry.turn === row.turn);
              if (!turn) return null;
              if (row.kind === "turn") {
                const counts = `${turn.files.length} ${turn.files.length === 1 ? "file" : "files"} +${turn.added} -${turn.removed}`;
                const room = Math.max(1, width - 2 - 7 - displayWidth(counts));
                return (
                  <text key={`t${row.turn}`} wrapMode="none" bg={active ? color.bg2 : undefined}>
                    <span fg={active ? color.peach : color.comment}>{active ? "› " : "  "}</span>
                    <span fg={color.comment}>{ago(turn.at, now).padStart(3)} </span>
                    <span fg={color.fgBright}>
                      {clip(firstLine(turn.prompt) || "before the first prompt", room).padEnd(room)}
                    </span>
                    <span fg={color.comment}> {counts}</span>
                  </text>
                );
              }
              const entry = turn.files.find((item) => item.file === row.file);
              const counts = entry
                ? `${entry.created ? "new " : entry.deleted ? "deleted " : ""}+${entry.added} -${entry.removed}`
                : "";
              const room = Math.max(1, width - 2 - 8 - displayWidth(counts) - 1);
              return (
                <text key={`f${row.turn}:${row.file}`} wrapMode="none" bg={active ? color.bg2 : undefined}>
                  <span fg={active ? color.peach : color.comment}>{active ? "›       " : "        "}</span>
                  <span fg={color.fg}>{clip(shortPath(row.file), room).padEnd(room)}</span>
                  <span fg={color.green}> {counts}</span>
                </text>
              );
            })
          ) : (
            <text fg={color.comment}>no edits yet · f waits for the first one</text>
          )}
        </box>
        <text fg={notice ? color.peach : color.comment} wrapMode="none">
          {clip(notice || "j/k move · enter open · f follow newest edit · q back", Math.max(1, width - 2))}
        </text>
      </box>
    );
  }

  const owned = owners[cursor];
  const writers = [...new Set(history.map(({ owner }) => sessionIdentity(owner.session)))];
  const others = writers.filter((name) => name !== sessionIdentity(session));
  const footer = owned
    ? `${sessionIdentity(owned.owner.session).slice(0, 18)} · ${ago(owned.edit.at, now)} · ${firstLine(owned.owner.turn?.prompt ?? "before the first prompt")}`
    : lines.length
      ? `line ${cursor + 1} · no recorded edit wrote it as it is now`
      : text === undefined
        ? "this file is not on disk"
        : "empty file";
  return (
    <box flexDirection="column" backgroundColor={color.bg} paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text wrapMode="none">
        <span fg={color.fgBright} attributes={1}>
          {clip(shortPath(open.file), Math.max(1, width - 30))}
        </span>
        <span fg={following ? color.green : color.comment}>{following ? " · following" : ""}</span>
        <span fg={color.yellow}>
          {others.length ? ` · also ${others.map((name) => name.slice(0, 14)).join(", ")}` : ""}
        </span>
      </text>
      <scrollbox ref={scroll} height={bodyHeight} scrollY scrollX={false}>
        <line-number
          ref={gutter}
          fg={color.comment}
          bg={color.bg}
          minWidth={3}
          paddingRight={1}
          lineSigns={signs}
          lineColors={colours}
          width="100%"
        >
          <code
            content={lines.join("\n")}
            filetype={filetypes[extname(open.file)]}
            syntaxStyle={style}
            drawUnstyledText
            wrapMode="none"
            selectable={false}
            fg={color.fg}
            width="100%"
          />
        </line-number>
      </scrollbox>
      <text fg={owned ? agentColor[owned.owner.session.agent] : color.comment} wrapMode="none">
        {clip(footer, Math.max(1, width - 2))}
      </text>
      {question !== undefined ? (
        <text wrapMode="none">
          <span fg={color.peach}>ask {recipientName(owners, open, cursor, session)}: </span>
          <span fg={color.fgBright}>{question}</span>
          <span fg={color.peach}>▏</span>
        </text>
      ) : (
        <text fg={notice ? color.peach : color.comment} wrapMode="none">
          {clip(
            notice ||
              `${open.anchor !== undefined ? "selecting · " : ""}j/k move · ]/[ next change · n file · v select · a ask the writer · f ${following ? "stop following" : "follow"} · q back`,
            Math.max(1, width - 2),
          )}
        </text>
      )}
    </box>
  );
}

/** Whether the reviewed session wrote this line while answering `turn`. */
function inTurn(owned: Owned<Writer> | undefined, session: Session, turn: Turn | undefined): boolean {
  return (
    owned !== undefined &&
    turn !== undefined &&
    sessionIdentity(owned.owner.session) === sessionIdentity(session) &&
    owned.owner.turn === turn
  );
}

/** Who a question about these lines goes to: their one writer, else the reviewed session. */
function recipient(owners: readonly (Owned<Writer> | undefined)[], session: Session): Session {
  const writers = new Map(
    owners.flatMap((owned) => (owned ? [[sessionIdentity(owned.owner.session), owned.owner.session]] : [])),
  );
  const [only] = writers.values();
  return writers.size === 1 && only ? only : session;
}

function recipientName(
  owners: readonly (Owned<Writer> | undefined)[],
  open: FileState,
  cursor: number,
  session: Session,
): string {
  const [low, high] =
    open.anchor === undefined ? [cursor, cursor] : [Math.min(open.anchor, cursor), Math.max(open.anchor, cursor)];
  const to = recipient(owners.slice(low, high + 1), session);
  return `${sessionIdentity(to).slice(0, 18)}${reachable(to) ? "" : " (not running)"}`;
}
