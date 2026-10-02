import { join } from "node:path";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useReducer, useState } from "react";
import {
  createSkill,
  importSkill,
  type LinkState,
  listSkills,
  repairSkill,
  type SkillScope,
  type SkillStore,
  shareSkill,
  skillStore,
  unshareSkill,
} from "./skills";
import { color, typed, untilde } from "./tui";
import { useLatest } from "./use-latest";

type Props = {
  project: string;
  onBack: () => void;
  edit: (path: string) => Promise<void>;
  loadSkills?: (store: SkillStore) => ReturnType<typeof listSkills>;
};

export function SkillsView({ project, onBack, edit, loadSkills = listSkills }: Props) {
  const [scope, getScope, setScope] = useLatest<SkillScope>("user");
  const [selected, getSelected, setSelected] = useLatest(0);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [input, getInput, setInput] = useLatest("");
  const [mode, getMode, setMode] = useLatest<"list" | "new" | "import" | "unlink" | "repair">("list");
  const [notice, setNotice] = useState("");
  const [busy, getBusy, setBusy] = useLatest(false);
  const { width, height } = useTerminalDimensions();
  const store = skillStore(scope, project);
  let problem = "";
  let skills: ReturnType<typeof listSkills> = [];
  try {
    skills = loadSkills(store);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const index = Math.min(selected, Math.max(0, skills.length - 1));
  const current = skills[index];

  async function action(run: () => void | Promise<void>) {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  useKeyboard((key) => {
    if (getBusy()) return;
    const mode = getMode();
    const input = getInput();
    const store = skillStore(getScope(), project);
    const index = Math.min(getSelected(), Math.max(0, skills.length - 1));
    const current = skills[index];
    if (key.ctrl && key.name === "c") return onBack();
    setNotice("");
    if (mode === "repair") {
      setMode("list");
      if (key.name === "y" && current)
        void action(() => {
          const backups = repairSkill(store, current.name);
          setNotice(
            backups.length
              ? `shared; conflicts backed up under ${store.directory}/.kiln-backups`
              : "shared with Claude, Codex and Pi",
          );
        });
      return;
    }
    if (mode === "unlink") {
      setMode("list");
      if (key.name === "y" && current)
        void action(() => {
          unshareSkill(store, current.name);
          setNotice("Claude and Pi links removed; the shared files and Codex access remain");
        });
      return;
    }
    if (mode !== "list") {
      if (key.name === "escape") return setMode("list");
      if (key.name === "backspace") return setInput(input.slice(0, -1));
      if (key.name === "return") {
        setMode("list");
        void action(async () => {
          const path = mode === "new" ? createSkill(store, input) : importSkill(store, untilde(input));
          setNotice(`saved ${path}; press l to share with Claude and Pi`);
          if (mode === "new") await edit(join(path, "SKILL.md"));
        });
        return;
      }
      const text = typed(key);
      if (text) setInput(input + text);
      return;
    }
    if (key.name === "escape" || key.name === "q") return onBack();
    if (key.name === "u" || key.name === "p") {
      setScope(key.name === "u" ? "user" : "project");
      setSelected(0);
      return;
    }
    if (key.name === "j" || key.name === "down")
      return setSelected(Math.max(0, Math.min(index + 1, skills.length - 1)));
    if (key.name === "k" || key.name === "up") return setSelected(Math.max(index - 1, 0));
    if (key.name === "r") return refresh();
    if (key.name === "n" || key.name === "i") {
      setInput("");
      return setMode(key.name === "n" ? "new" : "import");
    }
    if (key.name === "return" && current) return void action(() => edit(join(current.directory, "SKILL.md")));
    if (key.name === "l" && current)
      return void action(() => {
        shareSkill(store, current.name);
        setNotice("shared with Claude, Codex and Pi; reload skills in existing sessions");
      });
    if (key.name === "f" && current) return setMode("repair");
    if (key.name === "x" && current) return setMode("unlink");
  });

  const pageSize = Math.max(1, height - 9);
  const colours: Record<LinkState, string> = { shared: color.green, missing: color.purple, conflict: color.yellow };
  const fit = (text: string) => (text.length > width - 2 ? `${text.slice(0, Math.max(0, width - 3))}…` : text);
  const start = Math.floor(index / pageSize) * pageSize;
  const nameWidth = Math.max(12, Math.min(40, width - 38));
  return (
    <box flexDirection="column" backgroundColor={color.bg} paddingLeft={1} paddingRight={1} flexGrow={1}>
      <text fg={color.fgBright} attributes={1}>
        kiln skills · {scope === "user" ? "user / this machine" : "project"}
      </text>
      <text fg={color.fgDim}>{fit(store.directory)}</text>
      <box flexDirection="column" marginTop={1} flexGrow={1}>
        <text fg={color.comment}>{`  ${"skill".padEnd(nameWidth)} Claude    Pi        source`}</text>
        {skills.slice(start, start + pageSize).map((skill, offset) => (
          <text key={skill.name} bg={start + offset === index ? color.bg2 : undefined}>
            <span
              fg={start + offset === index ? color.peach : color.fg}
            >{`${start + offset === index ? "› " : "  "}${skill.name.slice(0, nameWidth).padEnd(nameWidth)} `}</span>
            <span fg={colours[skill.claude]}>{skill.claude.padEnd(10)}</span>
            <span fg={colours[skill.pi]}>{skill.pi.padEnd(10)}</span>
            <span fg={color.fgDim}>{skill.external ? "link" : "shared dir"}</span>
          </text>
        ))}
        {!skills.length ? (
          <text fg={color.fgDim}>no shared skills · n to create one · i to copy an existing skill</text>
        ) : null}
      </box>
      <text>
        <span fg={colours.shared}>shared ready</span>
        {" · "}
        <span fg={colours.missing}>missing link</span>
        {" · "}
        <span fg={colours.conflict}>conflict needs repair</span>
      </text>
      <text fg={color.fgDim}>
        {fit(`Codex reads shared files · ${skills.length ? index + 1 : 0}/${skills.length}`)}
      </text>
      <text fg={color.peach}>
        {fit(
          problem ||
            notice ||
            (busy
              ? "editor open"
              : mode === "new"
                ? `new skill name: ${input}`
                : mode === "import"
                  ? `copy skill directory: ${input}`
                  : mode === "unlink"
                    ? `remove Claude and Pi links for ${current?.name}? y confirms`
                    : mode === "repair"
                      ? `use shared ${current?.name}; back up adapter conflicts? y confirms`
                      : "l shares missing links; f backs up conflicts and shares"),
        )}
      </text>
      <text fg={color.fgDim}>j/k move · l share · f repair · enter edit</text>
      <text fg={color.fgDim}>u user · p project · n new · i import · x unlink · q back</text>
    </box>
  );
}
