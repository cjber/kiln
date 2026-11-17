import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Claude Code asks whether to trust a folder before an interactive session reads its prompt, and has no flag to skip
 * that question. It records the answer as `projects[<key>].hasTrustDialogAccepted` in `.claude.json`, the documented
 * way to trust a folder without the dialog: https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust
 */

/** The global config file of a Claude config dir: inside it when one is set, otherwise beside the home directory. */
export function claudeJsonPath(configDir: string | undefined): string {
  return configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
}

function git(dir: string, ...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/**
 * The folder whose trust covers `dir`, as Claude Code keys it: the main checkout of its git repository, which a
 * worktree shares, or `dir` itself outside one. Undefined for the home directory, whose trust Claude never saves.
 */
export function claudeTrustKey(dir: string): string | undefined {
  const real = realpathSync(dir);
  // The first entry `git worktree list` prints is always the main working tree, or the bare repository.
  const [main, ...details] = git(real, "worktree", "list", "--porcelain")?.split("\n\n")[0]?.split("\n") ?? [];
  const checkout =
    main?.startsWith("worktree ") && !details.includes("bare") ? main.slice("worktree ".length) : undefined;
  const key = checkout ?? git(real, "rev-parse", "--show-toplevel")?.trim() ?? real;
  return key === realpathSync(homedir()) ? undefined : key;
}

function record(value: unknown, what: string, path: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`${path}: ${what} is not a JSON object, so kiln leaves it alone`);
}

/**
 * Mark the folder covering `dir` trusted in one Claude config dir's `.claude.json`, keeping every other key. Returns
 * true when it wrote, false when it was already trusted or is the home directory. A file that does not parse is never
 * replaced: that throws. The write goes to a temporary file renamed over the original, so a reader sees the whole old
 * file or the whole new one; running Claude sessions watch the file and load what another process wrote.
 */
export function trustClaudeWorkspace(dir: string, configDir: string | undefined): boolean {
  const key = claudeTrustKey(dir);
  if (!key) return false;
  const path = claudeJsonPath(configDir);
  // A symlinked config is updated where it points, so the link stays.
  const target = existsSync(path) ? realpathSync(path) : path;
  let config: Record<string, unknown> = {};
  let mode = 0o600;
  if (existsSync(target)) {
    const text = readFileSync(target, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path} is not valid JSON, so kiln leaves it alone: ${(error as Error).message}`);
    }
    config = record(parsed, "the file", path);
    mode = statSync(target).mode & 0o777;
  }
  const projects = record(config.projects ?? {}, "projects", path);
  const project = record(projects[key] ?? {}, `projects["${key}"]`, path);
  if (project.hasTrustDialogAccepted === true) return false;
  projects[key] = { ...project, hasTrustDialogAccepted: true };
  config.projects = projects;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.kiln-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

function children(): Map<number, number[]> {
  const tree = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // The command name is parenthesised and may contain spaces; ppid is the second field after it.
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      tree.set(parent, [...(tree.get(parent) ?? []), Number(entry)]);
    } catch {
      // A process can exit while the tree is read.
    }
  }
  return tree;
}

/**
 * The config dir the Claude Code process under `root` runs with, from its own environment, or undefined (the home
 * default) when it has none. A launcher such as a multi-account wrapper can choose it after kiln starts the command, so
 * only the running process says which `.claude.json` it reads. Claude Code's native executable names its process
 * `claude`; the deepest one is the program itself rather than a wrapper of the same name. Undefined when none runs.
 */
export function runningClaude(root: number): { configDir?: string } | undefined {
  const tree = children();
  let found: number | undefined;
  for (let level = [root]; level.length; level = level.flatMap((pid) => tree.get(pid) ?? [])) {
    for (const pid of level) {
      try {
        if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "claude") found = pid;
      } catch {
        // Gone already.
      }
    }
  }
  if (found === undefined) return undefined;
  try {
    const variable = readFileSync(`/proc/${found}/environ`, "utf8")
      .split("\0")
      .find((entry) => entry.startsWith("CLAUDE_CONFIG_DIR="));
    return { configDir: variable?.slice("CLAUDE_CONFIG_DIR=".length) || undefined };
  } catch {
    return undefined;
  }
}

/** Wait for the Claude Code process under `root` to start, while `root` runs and for at most `waitMs`. */
export async function startedClaude(root: number, waitMs: number): Promise<{ configDir?: string } | undefined> {
  for (const deadline = Date.now() + waitMs; ; await Bun.sleep(50)) {
    const claude = runningClaude(root);
    if (claude || !existsSync(`/proc/${root}`) || Date.now() >= deadline) return claude;
  }
}
