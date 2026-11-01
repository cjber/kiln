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

/** Terminal display width: CJK, Hangul, fullwidth and emoji characters take two columns. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals and ideographs
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
      (code >= 0xfe10 && code <= 0xfe19) || // vertical forms
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
      (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) || // emoji and pictographs
      (code >= 0x20000 && code <= 0x3fffd) // CJK extension B+
        ? 2
        : 1;
  }
  return width;
}

/** Pad with spaces to a terminal column count, not a code-unit count. */
export function padToWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
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
