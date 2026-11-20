import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { claudeHome } from "./accounts";
import { claudeCloudToken } from "./claude-cloud";
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

/** One login's last read: when the provider was last asked, and its last good answer. */
type Read = { askedAt: number; usage?: ClaudeUsage };

const everyMs = 5 * 60_000;
let staleBefore = 0;

/** Ask the provider again on the next read, whatever was read before now. */
export function forgetClaudeUsage(now = Date.now()): void {
  staleBefore = now;
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

/** The access token of the login in `home`; none when it is signed out or its token has expired. */
function token(home: string, now: number): string | undefined {
  try {
    return claudeCloudToken(readFileSync(join(home, ".credentials.json"), "utf8"), now);
  } catch {
    // Claude Code renews an expired token when it next runs; kiln only reads, so it keeps the last answer until then.
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

/**
 * The usage of the Claude login in `home`. The read is kept in kiln's state directory, so every kiln process shares one
 * request per login every five minutes. A login the provider cannot be asked about now (signed out, an expired token,
 * a failed request) answers with its last good read, whose `fetchedAt` says how old it is.
 */
export async function claudeUsage(
  now: number,
  home = claudeHome(),
  dir = stateDir(),
  request: typeof fetch = fetch,
): Promise<ClaudeUsage | undefined> {
  const path = join(dir, `${new Bun.CryptoHasher("sha256").update(sameHome(home)).digest("hex").slice(0, 16)}.json`);
  const last = readFile(path);
  if (last && now - last.askedAt < everyMs && last.askedAt >= staleBefore) return last.usage;
  const access = token(home, now);
  if (!access) return last?.usage;
  let usage = last?.usage;
  try {
    const response = await request(usageUrl, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${access}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "kiln",
      },
    });
    const windows = response.ok ? parseClaudeUsage(await response.json()) : undefined;
    if (windows) usage = { windows, fetchedAt: now };
  } catch {
    // A request that failed leaves the last good read standing.
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Two reads of one login can overlap in a process, and each needs a file of its own to rename.
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({ askedAt: now, usage } satisfies Read), { mode: 0o600 });
  renameSync(temporary, path);
  return usage;
}
