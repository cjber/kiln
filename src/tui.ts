import { homedir } from "node:os";
import { resolve } from "node:path";
import type { KeyEvent } from "@opentui/core";

/** The one palette every view draws from. */
export const color = {
  bg: "#121113",
  bg2: "#222222",
  fg: "#b0b0b0",
  fgBright: "#d0d0d0",
  fgDim: "#777777",
  comment: "#555555",
  orange: "#e78a53",
  teal: "#5f8787",
  peach: "#fbcb97",
  yellow: "#e5c46b",
  red: "#c75a5a",
  green: "#6a9955",
  purple: "#9d7cd8",
};

/** Printable input for the modes that take text; everything else is a command key. */
export function typed(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta || key.name === "return" || key.name === "tab" || key.name === "escape") return undefined;
  return key.sequence.length === 1 && key.sequence >= " " ? key.sequence : undefined;
}

export function tilde(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function untilde(path: string): string {
  return resolve(path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);
}

/** Open a file in the user's editor on the terminal the TUI has given up; returns the editor's exit code. */
export function openInEditor(path: string): number {
  const editor = Bun.env.VISUAL || Bun.env.EDITOR || "vi";
  return Bun.spawnSync(["sh", "-c", `${editor} "$1"`, "sh", path], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;
}
