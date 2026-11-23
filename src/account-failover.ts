import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultAccount } from "./accounts";
import { forgetReads, type QuotaAccount } from "./quota";
import { routeNew, startLimitedUntil } from "./routing";
import type { Session } from "./sessions";
import type { Settings } from "./settings";
import { claudeRefusedAt, headlessSpawn, moveClaude } from "./spawn";
import { recordSpent } from "./spent";

/** What became of a Claude session found stopped on its account's usage limit. */
export type Failover =
  | { kind: "moved"; session: Session; to: string }
  /** No other account could take it; `reason` says when one has allowance again. */
  | { kind: "stuck"; session: Session; reason: string }
  | { kind: "failed"; session: Session; to: string };

const stateDir = () => join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "failover");

/**
 * Take `step` of one refusal for this process alone. The list and the phone server both watch the sessions, so each
 * step is a file only one of them can create; a conversation's older refusals are dropped as a new one is first seen.
 */
function claim(dir: string, id: string, at: number, step: "seen" | "moved" | "failed"): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const own = `${id}.${at}.`;
  try {
    writeFileSync(join(dir, `${own}${step}`), "", { flag: "wx", mode: 0o600 });
  } catch {
    return false;
  }
  if (step === "seen")
    for (const entry of readdirSync(dir))
      if (entry.startsWith(`${id}.`) && !entry.startsWith(own)) rmSync(join(dir, entry), { force: true });
  return true;
}

let running = false;

/**
 * Move each interactive Claude session that stopped on its account's usage limit to the account with the most
 * headroom, in its own pane and conversation. The refusal comes from the session's transcript, with the reset time the
 * provider gave; once that time has passed its own account answers again and it is left alone. A headless spawn is
 * left to its exit report, and a session on a login kiln has no name for is not moved, since nothing says which
 * account is spent. A session no account can take, or one in a directory pinned to its account, is reported once
 * and tried again on every call.
 */
export async function failOverLimited(
  sessions: readonly Session[],
  settings: Settings,
  now = Date.now(),
  dir = stateDir(),
  route: typeof routeNew = routeNew,
  move: typeof moveClaude = moveClaude,
  refusedAt: (id: string) => number | undefined = claudeRefusedAt,
): Promise<Failover[]> {
  if (running || !settings.accounts.some((account) => account.agent === "claude")) return [];
  running = true;
  const events: Failover[] = [];
  try {
    for (const session of sessions) {
      const { limited, id, account, place } = session;
      if (session.agent !== "claude" || !limited || limited.resetsAt <= now) continue;
      if (!id || !/^[A-Za-z0-9-]+$/.test(id) || account === undefined) continue;
      if (place.kind !== "kiln" || headlessSpawn(place.name)) continue;
      // A refusal from before this process started was another run's, perhaps on another account: the conversation
      // has since been resumed and has not written a record yet.
      if (limited.at < session.startedAt) continue;
      const first = claim(dir, id, limited.at, "seen");
      if (first) {
        recordSpent("claude", account, limited.resetsAt);
        forgetReads();
      }
      let to: Awaited<ReturnType<typeof routeNew>>;
      try {
        to = await route("claude", settings, { skip: [account], now, cwd: session.cwd });
      } catch (error) {
        if (first) events.push({ kind: "stuck", session, reason: error instanceof Error ? error.message : "" });
        continue;
      }
      if (to.name === undefined || !claim(dir, id, limited.at, "moved")) continue;
      // The listing can be seconds old, and a prompt typed since has put the conversation to work again.
      if (refusedAt(id) !== limited.at) {
        rmSync(join(dir, `${id}.${limited.at}.moved`), { force: true });
        continue;
      }
      // A folder kiln never trusts for Claude, such as the home directory, cannot be restarted unattended.
      const moved = await move(place.name, id, session.cwd, to, settings).catch(() => false);
      if (moved) events.push({ kind: "moved", session, to: to.name });
      else {
        // A restart that failed is tried again on the next call, and reported once.
        rmSync(join(dir, `${id}.${limited.at}.moved`), { force: true });
        if (claim(dir, id, limited.at, "failed")) events.push({ kind: "failed", session, to: to.name });
      }
    }
  } finally {
    running = false;
  }
  return events;
}

/** One line saying what happened, for the list's footer and a desktop notification. */
export function failoverNotice(event: Failover): string {
  const title = event.session.title || "A Claude session";
  switch (event.kind) {
    case "moved":
      return `${title} reached its usage limit and moved to Claude account ${event.to}`;
    case "stuck":
      return `${title} reached its usage limit${event.reason ? `: ${event.reason}` : ""}`;
    case "failed":
      return `${title} reached its usage limit and could not be restarted on Claude account ${event.to}`;
  }
}

const limitedDir = () => join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "accounts-limited");

/**
 * The accounts that have allowance again: each was seen at its limit, and the time the provider gave for it has now
 * passed with the limit gone. A limited account leaves a file naming that time, and removing the file is what reports
 * it, so of the list and the phone server only one says so, once per limit.
 */
export function availableAgain(quota: readonly QuotaAccount[], now = Date.now(), dir = limitedDir()): string[] {
  const back: string[] = [];
  for (const account of quota) {
    if (account.disabled || account.needsLogin) continue;
    const path = join(dir, `${account.agent}.${account.name ?? defaultAccount}`);
    const until = startLimitedUntil(account, now);
    let recorded: number | undefined;
    try {
      recorded = Number(readFileSync(path, "utf8"));
    } catch {
      // Never seen at a limit, or the other watcher reported it first.
    }
    if (until !== undefined) {
      // A later read can give an earlier time than the run that hit the limit did; the latest one stands.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path, String(Math.max(until, recorded ?? 0)), { mode: 0o600 });
      continue;
    }
    // A limit recorded with no known end has ended when the provider stops reporting it.
    if (recorded === undefined || (Number.isFinite(recorded) && recorded > now)) continue;
    try {
      unlinkSync(path);
    } catch {
      continue;
    }
    back.push(account.name === undefined ? account.agent : `${account.agent} account ${account.name}`);
  }
  return back;
}
