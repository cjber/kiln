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

/** The files a Claude Code process reads and writes, by its own environment, as Claude Code finds them. */
export interface ClaudeConfig {
  /** The global config file, which holds folder trust. */
  json: string;
  /** The session registry, where Claude records each running session as `<pid>.json`. */
  sessions: string;
}

/** The config a Claude Code process with `env` uses: `CLAUDE_CONFIG_DIR` when set, otherwise its home directory. */
export function claudeConfig(env: Readonly<Record<string, string | undefined>>): ClaudeConfig {
  const dir = env.CLAUDE_CONFIG_DIR || undefined;
  if (dir) return { json: join(dir, ".claude.json"), sessions: join(dir, "sessions") };
  const home = env.HOME || homedir();
  return { json: join(home, ".claude.json"), sessions: join(home, ".claude", "sessions") };
}

function git(dir: string, ...args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/**
 * The folder whose trust covers `dir`, as Claude Code keys it: the main checkout of its git repository, which a
 * worktree shares, or `dir` itself outside one. Undefined for the home directory and the filesystem root.
 */
export function claudeTrustKey(dir: string): string | undefined {
  const real = realpathSync(dir);
  // The first entry `git worktree list` prints is always the main working tree, or the bare repository.
  const [main, ...details] = git(real, "worktree", "list", "--porcelain")?.split("\n\n")[0]?.split("\n") ?? [];
  const checkout =
    main?.startsWith("worktree ") && !details.includes("bare") ? main.slice("worktree ".length) : undefined;
  const key = checkout ?? git(real, "rev-parse", "--show-toplevel")?.trim() ?? real;
  // Claude never saves trust for the home directory, and trust for the root would cover every folder on the machine.
  return key === realpathSync(homedir()) || key === "/" ? undefined : key;
}

function record(value: unknown, what: string, path: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`${path}: ${what} is not a JSON object, so kiln leaves it alone`);
}

/**
 * A lock whose mtime is older than this was left by a writer that died, and the next writer takes it over:
 * proper-lockfile's default, which Claude Code keeps for this lock.
 */
const lockStaleMs = 10_000;

/** How long kiln waits for another writer's lock on a Claude config. */
const lockWaitMs = 15_000;

function mtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Run `work` holding the lock Claude Code takes for each write of `path`: proper-lockfile's `<path>.lock` directory,
 * which mkdir creates atomically, owned by whoever set its current mtime. A writer that holds it reads the file fresh,
 * so neither side loses the other's change. `work` is synchronous and far shorter than the stale time, so the lock
 * needs no refresh while kiln holds it; a holder stalled past that time can still have been taken over, so `work`
 * asks `owned` before it commits, and kiln removes the lock only while it is still its own.
 */
export async function withConfigLock<T>(path: string, work: (owned: () => boolean) => T): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  let held: number | undefined;
  for (const deadline = Date.now() + lockWaitMs; held === undefined; await Bun.sleep(25)) {
    try {
      mkdirSync(lock);
      held = mtime(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const seen = mtime(lock);
      if (seen !== undefined && Date.now() - seen > lockStaleMs) rmSync(lock, { recursive: true, force: true });
      if (Date.now() >= deadline) throw new Error(`${lock} stayed held, so kiln did not change ${path}`);
    }
  }
  const owned = () => mtime(lock) === held;
  try {
    return work(owned);
  } finally {
    if (owned()) rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Mark the folder covering `dir` trusted in the Claude config file at `path`, keeping every other key, under
 * Claude's own config lock. Returns true when it wrote, false when it was already trusted. Throws for the home
 * directory and the filesystem root, which kiln never trusts, and for a file that does not parse, which it never
 * replaces. The write goes to a temporary file renamed over the original, so a reader sees the whole old file or the
 * whole new one, and running Claude sessions load it.
 */
export async function trustClaudeWorkspace(dir: string, path: string): Promise<boolean> {
  const key = claudeTrustKey(dir);
  if (!key)
    throw new Error(
      `kiln never marks ${dir} trusted for Claude: an interactive Claude asks there each time. Use a folder below it`,
    );
  return withConfigLock(path, (owned) => writeTrust(path, key, owned));
}

function writeTrust(path: string, key: string, owned: () => boolean): boolean {
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
    // Another writer took the lock over, so the file read above may be stale: replacing it could lose that change.
    if (!owned()) throw new Error(`kiln lost ${path}.lock while it wrote, so it left ${path} alone`);
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

function environment(pid: number): Record<string, string> {
  return Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter((entry) => entry.includes("="))
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
  );
}

/** A process of a Claude launch, with the config Claude Code would use under its environment. */
export interface LaunchProcess {
  pid: number;
  config: ClaudeConfig;
}

/**
 * The processes under `root` (itself included) that carry `sessionId`, the id kiln passed with `--session-id`: a
 * launcher hands it on down to Claude Code, which keeps it. Matching that id, not a program name, finds Claude under
 * any launcher or executable name, and leaves out anything else a launcher runs, such as a helper on another account.
 */
export function launchProcesses(root: number, sessionId: string): LaunchProcess[] {
  const tree = children();
  const found: LaunchProcess[] = [];
  for (let level = [root]; level.length; level = level.flatMap((pid) => tree.get(pid) ?? [])) {
    for (const pid of level) {
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(sessionId))
          found.push({ pid, config: claudeConfig(environment(pid)) });
      } catch {
        // Gone already.
      }
    }
  }
  return found;
}

/**
 * Whether Claude Code runs `sessionId` as `pid` past its trust dialog: it records a running session in its session
 * registry, `<pid>.json`, only once its folder is trusted.
 */
export function claudeRegistered({ pid, config }: LaunchProcess, sessionId: string): boolean {
  try {
    return JSON.parse(readFileSync(join(config.sessions, `${pid}.json`), "utf8")).sessionId === sessionId;
  } catch {
    return false;
  }
}

/** How a Claude launch settled: running past its trust dialog, ended, still unregistered at the wait's end, or found
 * reading a config that had not trusted its folder (now trusted there), so it has to start again to read it. */
export type LaunchOutcome = "registered" | "ended" | "unregistered" | "untrusted";

/**
 * Follow a Claude launch under `root` until Claude Code registers `sessionId`, trusting `dir` in the config of every
 * process the session id reaches. A launcher such as a multi-account wrapper can give Claude another config dir than
 * the one kiln trusted before it started, and Claude reads trust only as it starts, so a config that had not trusted
 * the folder means this launch waits at the dialog.
 */
export async function settleLaunch(
  root: number,
  sessionId: string,
  dir: string,
  waitMs: number,
): Promise<LaunchOutcome> {
  const trusted = new Set<string>();
  for (const deadline = Date.now() + waitMs; ; await Bun.sleep(50)) {
    const launch = launchProcesses(root, sessionId);
    if (launch.some((process) => claudeRegistered(process, sessionId))) return "registered";
    for (const { config } of launch) {
      if (trusted.has(config.json)) continue;
      if (await trustClaudeWorkspace(dir, config.json)) return "untrusted";
      trusted.add(config.json);
    }
    if (!existsSync(`/proc/${root}`)) return "ended";
    if (Date.now() >= deadline) return "unregistered";
  }
}
