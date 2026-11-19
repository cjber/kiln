import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type LimitHit, museLimit } from "./muse-limit";
import type { QuotaAccount } from "./quota";
import { limitedUntil } from "./routing";
import type { Agent } from "./sessions";

/** A run that ended because its account has no allowance left, and when the provider says it has some again, ms. */

/**
 * Whether a headless Claude run stopped on a rate limit. Under mclaude the run's Claude Code `StopFailure` hook (matcher
 * `rate_limit`) writes `StopFailure-<ms>.json` into the launch's limits directory, naming the session and the account.
 */
export function claudeLimit(
  id: string,
  startedAt: number,
  limits = join(homedir(), ".mclaude", "limits"),
): LimitHit | undefined {
  if (!existsSync(limits)) return undefined;
  for (const launch of readdirSync(limits)) {
    const dir = join(limits, launch);
    try {
      if (statSync(dir).mtimeMs < startedAt) continue;
      for (const file of readdirSync(dir).filter((name) => name.startsWith("StopFailure-") && name.endsWith(".json"))) {
        const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
          payload?: { session_id?: string; error?: string };
          receivedAt?: string | number;
        };
        if (record.payload?.session_id === id && record.payload.error === "rate_limit") return {};
      }
    } catch {
      // A record mclaude is writing reads whole on the next call.
    }
  }
  return undefined;
}

/**
 * Whether `account` of `agent`, read fresh from its provider, is now out of allowance, with when it is not. This is how
 * a Codex or OpenCode run's nonzero exit is told to be a limit: neither prints a status code for it, but each
 * provider's own usage read shows the account full or rate-limited.
 */
export function providerLimit(
  agent: Agent,
  account: string | undefined,
  quota: readonly QuotaAccount[],
  now: number,
): LimitHit | undefined {
  const found = quota.find((candidate) => candidate.agent === agent && candidate.name === account);
  const until = found && limitedUntil(found, now);
  return until === undefined ? undefined : { resetsAt: Number.isFinite(until) ? until : undefined };
}

/**
 * Whether a child that exited nonzero stopped on its account's usage limit, from the provider's own signal: Muse's
 * session log, Claude's `StopFailure` record, or (for Claude, Codex and OpenCode) the account's usage, read fresh in
 * `quota`, which shows it full or rate-limited. Output text is never searched.
 */
export function detectLimit(
  record: { agent: Agent; id: string; account?: string; startedAt: number },
  now: number,
  quota: readonly QuotaAccount[],
): LimitHit | undefined {
  const reported = providerLimit(record.agent, record.account, quota, now);
  switch (record.agent) {
    case "muse":
      return museLimit(record.id);
    case "claude":
      return claudeLimit(record.id, record.startedAt) ? { resetsAt: reported?.resetsAt } : reported;
    case "codex":
    case "opencode":
      return reported;
    case "pi":
      return undefined;
  }
}
