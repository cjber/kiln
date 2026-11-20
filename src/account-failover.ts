import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { forgetReads } from "./quota";
import { routeNew } from "./routing";
import type { Session } from "./sessions";
import type { Settings } from "./settings";
import { headlessSpawn, moveClaude } from "./spawn";
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
function claim(dir: string, id: string, at: number, step: "seen" | "moved"): boolean {
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
 * account is spent. A session no account can take is reported once and tried again on every call.
 */
export async function failOverLimited(
  sessions: readonly Session[],
  settings: Settings,
  now = Date.now(),
  dir = stateDir(),
  route: typeof routeNew = routeNew,
  move: typeof moveClaude = moveClaude,
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
      const first = claim(dir, id, limited.at, "seen");
      if (first) {
        recordSpent("claude", account, limited.resetsAt);
        forgetReads();
      }
      let to: Awaited<ReturnType<typeof routeNew>>;
      try {
        to = await route("claude", settings.accounts, undefined, [account], now);
      } catch (error) {
        if (first) events.push({ kind: "stuck", session, reason: error instanceof Error ? error.message : "" });
        continue;
      }
      if (to.name === undefined || !claim(dir, id, limited.at, "moved")) continue;
      // A folder kiln never trusts for Claude, such as the home directory, cannot be restarted unattended.
      const moved = await move(place.name, id, session.cwd, to, settings).catch(() => false);
      events.push({ kind: moved ? "moved" : "failed", session, to: to.name });
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
