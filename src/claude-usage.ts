import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { claudeHome } from "./accounts";
import { type ClaudeLogin, claudeLogin } from "./claude-cloud";
import type { QuotaWindow } from "./quota";

/**
 * A Claude subscription's usage meter, as the provider reports it. Claude Code's own `/usage` view asks
 * `GET https://api.anthropic.com/api/oauth/usage` with the signed-in login's access token; the answer carries the
 * 5-hour (`five_hour`) and weekly (`seven_day`) windows as a percent used and a reset time.
 */
const usageUrl = "https://api.anthropic.com/api/oauth/usage";

type Meter = { utilization?: unknown; resets_at?: unknown } | null | undefined;

/** The windows of a usage response, or undefined when it carries none. */
export function parseClaudeUsage(body: unknown): QuotaWindow[] | undefined {
  const usage = body as { five_hour?: Meter; seven_day?: Meter } | null;
  if (!usage || typeof usage !== "object") return undefined;
  const windows: QuotaWindow[] = [];
  for (const [label, meter] of [
    ["5h", usage.five_hour],
    ["wk", usage.seven_day],
  ] as const) {
    if (!meter || typeof meter.utilization !== "number") continue;
    const resetsAt = typeof meter.resets_at === "string" ? Date.parse(meter.resets_at) : Number.NaN;
    windows.push({ label, percent: meter.utilization, resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt });
  }
  // An account that has used nothing reports both meters empty, which is still an answer.
  return "five_hour" in usage || "seven_day" in usage ? windows : undefined;
}

export type ClaudeUsage = { windows: QuotaWindow[]; fetchedAt: number };

/**
 * One login's last read: when the provider was last asked and its last good answer, and for a login whose token was
 * rejected, when Claude Code was last asked to renew it and whether it then called the login signed out.
 */
type Read = { askedAt: number; usage?: ClaudeUsage; renewedAt?: number; loggedOut?: boolean; tokenHash?: string };

const everyMs = 5 * 60_000;
const renewEveryMs = 30 * 60_000;
let staleBefore = 0;

/** Ask the provider again on the next read, whatever was read before now. */
export function forgetClaudeUsage(now = Date.now()): void {
  staleBefore = now;
}

/** Ask again for any login last asked before `at`, keeping a later such mark. */
export function claudeUsageSince(at: number): void {
  staleBefore = Math.max(staleBefore, at);
}

const stateDir = () => join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "claude-usage");

function readFile(path: string): Read | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Read;
  } catch {
    // No read yet, or one another kiln is rewriting, which reads whole on the next call.
    return undefined;
  }
}

/**
 * Whether a Claude config dir is signed in. Claude Code keeps the login in this file, except on macOS where it is in
 * the Keychain, which kiln does not read: a config dir there counts as signed in and has no usage to show.
 */
export function claudeSignedIn(home = claudeHome()): boolean {
  return process.platform === "darwin" || existsSync(join(home, ".credentials.json"));
}

/** The login in `home`, as its credentials file has it. */
function login(home: string, now: number): ClaudeLogin {
  let source: string;
  try {
    source = readFileSync(join(home, ".credentials.json"), "utf8");
  } catch {
    return { state: "signedOut" };
  }
  return claudeLogin(source, now);
}

/**
 * Ask Claude Code about the login in `home`: `claude auth status` renews a token it can and answers whether it is
 * signed in. kiln never writes a token itself. Undefined when Claude Code is missing or gave no answer.
 */
export async function askClaude(home: string): Promise<boolean | undefined> {
  const claude = Bun.which("claude");
  if (!claude) return undefined;
  // `~/.claude` is Claude Code's home only with its variable unset. A launcher's own variable naming where the
  // credentials are kept would have Claude Code answer for that login instead, so it is not passed on.
  const { CLAUDE_CONFIG_DIR: _own, CLAUDE_SECURESTORAGE_CONFIG_DIR: _stored, ...env } = Bun.env;
  try {
    const child = Bun.spawn([claude, "auth", "status"], {
      env: sameHome(home) === sameHome(claudeHome()) ? env : { ...env, CLAUDE_CONFIG_DIR: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timeout = setTimeout(() => child.kill(), 30_000);
    try {
      const answer = JSON.parse(await new Response(child.stdout).text()) as { loggedIn?: unknown };
      return typeof answer.loggedIn === "boolean" ? answer.loggedIn : undefined;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return undefined;
  }
}

/** One name for a config dir however it is reached, so a login has one read. */
function sameHome(home: string): string {
  try {
    return realpathSync(home);
  } catch {
    return resolve(home);
  }
}

const statePath = (home: string, dir: string) =>
  join(dir, `${new Bun.CryptoHasher("sha256").update(sameHome(home)).digest("hex").slice(0, 16)}.json`);

function write(path: string, read: Read): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Two reads of one login can overlap in a process, and each needs a file of its own to rename.
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(read), { mode: 0o600 });
  renameSync(temporary, path);
}

function tokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** The access token in `home`, if its credentials file holds one. */
function currentToken(home: string): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(home, ".credentials.json"), "utf8"))?.claudeAiOauth;
    return typeof auth?.accessToken === "string" && auth.accessToken ? auth.accessToken : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A hash of the token in `home` now, or undefined when it holds none, taken before a slow check so a
 * caller can tell whether the login it checked is still the login there when the check answers.
 */
export function claudeTokenHash(home = claudeHome()): string | undefined {
  const token = currentToken(home);
  return token ? tokenHash(token) : undefined;
}

/**
 * Whether the login in `home` has to be signed in again before a run can start on it: its credentials hold nothing
 * Claude Code can renew, or Claude Code was asked to renew them and called the login signed out.
 */
export function claudeNeedsLogin(now: number, home = claudeHome(), dir = stateDir()): boolean {
  const current = login(home, now);
  const read = readFile(statePath(home, dir));
  return (
    current.state === "needsLogin" ||
    (current.state === "expired" && read?.loggedOut === true && read.tokenHash === claudeTokenHash(home)) ||
    (current.state === "ok" && read?.loggedOut === true && read.tokenHash === tokenHash(current.token))
  );
}

/**
 * Record that a run on the login in `home` failed to authenticate, so it is treated as signed out until a different
 * token is written there. No usage read is needed: an account with no quota windows is marked the same way.
 * `snapshot` is the {@link claudeTokenHash} taken before the check that found the failure (`null` when
 * the home then held no token): when the token there now is a different one, a login completed while
 * the check ran, so nothing is marked and this returns false. Without a snapshot it always marks.
 * Returns whether it marked.
 */
export function recordClaudeLoginFailure(
  home = claudeHome(),
  dir: string = stateDir(),
  snapshot?: string | null,
): boolean {
  const current = claudeTokenHash(home);
  if (snapshot !== undefined && current !== (snapshot ?? undefined)) return false;
  const path = statePath(home, dir);
  const prior = readFile(path);
  const mark = { loggedOut: true, ...(current ? { tokenHash: current } : {}) };
  write(path, prior ? { ...prior, ...mark } : { askedAt: 0, ...mark });
  return true;
}

/**
 * Take the renewal of one login for this process: the list and the phone server read usage at the same moments, and
 * only the one that creates this file asks Claude Code. A file left by a process that died is replaced after a minute.
 */
function renewing(path: string, now: number): boolean {
  const lock = `${path}.renewing`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (now - statSync(lock).mtimeMs > 60_000) rmSync(lock, { force: true });
  } catch {
    // No renewal is under way.
  }
  try {
    writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The usage of the Claude login in `home`. The read is kept in kiln's state directory, so every kiln process shares one
 * request per login every five minutes. A login the provider cannot be asked about now (signed out, an expired token,
 * a failed request) answers with its last good read, whose `fetchedAt` says how old it is. An expired token is one
 * Claude Code renews: it is asked to, at most every half hour and without holding this read up, and the next read
 * finds what it did.
 */
export async function claudeUsage(
  now: number,
  home = claudeHome(),
  dir = stateDir(),
  request: typeof fetch = fetch,
  renew: (home: string) => Promise<boolean | undefined> = askClaude,
): Promise<ClaudeUsage | undefined> {
  const path = statePath(home, dir);
  const last = readFile(path);
  if (last && now - last.askedAt < everyMs && last.askedAt >= staleBefore) return last.usage;
  const current = login(home, now);
  const beginRenewal = (snapshot: string | undefined): void => {
    if (now - (last?.renewedAt ?? 0) < renewEveryMs || !renewing(path, now)) return;
    write(path, {
      ...last,
      askedAt: last?.askedAt ?? 0,
      renewedAt: now,
      tokenHash: snapshot,
      loggedOut: last?.tokenHash === snapshot ? last?.loggedOut : undefined,
    });
    void renew(home)
      .then((loggedIn) => {
        if (loggedIn === undefined || (!loggedIn && claudeTokenHash(home) !== snapshot)) return;
        const state = readFile(path);
        if (state?.renewedAt !== now || state.tokenHash !== snapshot) return;
        // A successful renewal can replace the token. Refresh usage on the next read.
        write(path, { ...state, askedAt: 0, loggedOut: !loggedIn });
      })
      .finally(() => rmSync(`${path}.renewing`, { force: true }));
  };
  if (current.state !== "ok") {
    if (current.state === "expired") beginRenewal(claudeTokenHash(home));
    return last?.usage;
  }
  if (last?.loggedOut === true && last.tokenHash === tokenHash(current.token)) return last.usage;
  let usage = last?.usage;
  try {
    const response = await request(usageUrl, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${current.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "kiln",
      },
    });
    if (response.status === 401) {
      const snapshot = tokenHash(current.token);
      if (claudeTokenHash(home) !== snapshot) return readFile(path)?.usage;
      beginRenewal(snapshot);
      const state = readFile(path);
      write(path, { ...state, askedAt: now, usage });
      return usage;
    }
    const windows = response.ok ? parseClaudeUsage(await response.json()) : undefined;
    if (windows) usage = { windows, fetchedAt: now };
  } catch {
    // A request that failed leaves the last good read standing.
  }
  write(path, { askedAt: now, usage });
  return usage;
}
