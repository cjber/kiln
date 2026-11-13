import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const editTools = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "edit", "write"]);
const patchTools = new Set(["apply_patch", "patch"]);
const shellTools = new Set(["Bash", "bash", "shell"]);

/**
 * The path a tool call works in: a file it edits, or the directory a shell command starts with `cd`.
 * Reads are left out, since agents read other projects' files without moving to them.
 */
export function toolPath(tool: string, input: Record<string, unknown>): string | undefined {
  if (editTools.has(tool)) {
    const path = input.file_path ?? input.notebook_path ?? input.filePath ?? input.path;
    return typeof path === "string" && isAbsolute(path) ? path : undefined;
  }
  if (patchTools.has(tool) && typeof input.patchText === "string") {
    const paths = [...input.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (\S+)$/gm)].map((match) => match[1]);
    return paths.findLast((path) => path !== undefined && isAbsolute(path));
  }
  if (shellTools.has(tool) && typeof input.command === "string") {
    const match = input.command.match(/^\s*cd\s+(["']?)([^"'&;|\s]+)\1\s*(?:&&|;|$)/);
    const path = match?.[2]?.replace(/^~(?=\/|$)/, homedir());
    return path && isAbsolute(path) ? path : undefined;
  }
  return undefined;
}

/** The repository checkout holding `path`: the nearest directory with a `.git`, which a linked worktree also has. */
export function checkout(path: string): string | undefined {
  for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, ".git"))) return dir;
  return undefined;
}

/**
 * Counts a checkout's changed files, one porcelain line each. `--no-optional-locks` keeps the poll from rewriting
 * the index, whose `index.lock` would fail a commit an agent runs in that checkout at the same moment.
 */
export const changedFiles = ["git", "--no-optional-locks", "status", "--porcelain"] as const;
