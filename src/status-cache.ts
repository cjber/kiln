import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long one status line serves every tmux client: a refresh lists sessions, which spawns `claude agents`. */
export const STATUS_TTL_MS = 15_000;
/** A refresh that holds the lock longer than this crashed, so the next caller takes over. */
const LOCK_STALE_MS = 10_000;

export function statusCacheDir(): string {
  return join(Bun.env.XDG_RUNTIME_DIR || tmpdir(), `kiln-${process.getuid?.() ?? "user"}`);
}

function age(path: string, now: number): number | undefined {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A concurrent caller removed it first.
  }
}

/**
 * Every tmux client asks for the status line every few seconds, so all of them share one cached line.
 * Only the caller that wins the lock refreshes it; the others print the line they have, even a stale one.
 */
export async function cachedStatus(
  refresh: () => Promise<string>,
  dir = statusCacheDir(),
  now = Date.now(),
): Promise<string> {
  const cache = join(dir, "status");
  const lock = join(dir, "status.lock");
  const cacheAge = age(cache, now);
  const cached = read(cache);
  if (cached !== undefined && cacheAge !== undefined && cacheAge < STATUS_TTL_MS) return cached;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockAge = age(lock, now);
  if (lockAge !== undefined && lockAge >= LOCK_STALE_MS) removeIfPresent(lock);
  let held: number;
  try {
    held = openSync(lock, "wx");
  } catch {
    // Another client is refreshing: its line lands within a refresh, so print what there is.
    return cached ?? "";
  }
  try {
    const line = await refresh();
    const partial = `${cache}.${process.pid}`;
    writeFileSync(partial, line);
    renameSync(partial, cache);
    return line;
  } finally {
    closeSync(held);
    removeIfPresent(lock);
  }
}
