import { readFileSync } from "node:fs";

import { findClaudeTranscript } from "./claude-inbox";
import { type LimitHit, museLimit } from "./muse-limit";
import type { QuotaAccount } from "./quota";
import { startLimitedUntil } from "./routing";
import type { Agent } from "./sessions";
import { limitRecord } from "./transcript";

/**
 * Whether a Claude run stopped on its account's usage limit. Claude Code writes the provider's refusal into the
 * conversation's transcript as an assistant record with `error: "rate_limit"`, and `quotaLimits.resetsAt` (seconds)
 * says when the window that refused it resets. Only a record written since `startedAt` is this run's: a resumed
 * conversation still holds the one that ended its previous run.
 */
export function claudeLimit(id: string, startedAt: number, path = findClaudeTranscript(id)): LimitHit | undefined {
  if (!path) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index]?.includes('"rate_limit"')) continue;
    try {
      const record = JSON.parse(lines[index] as string);
      if (record.error !== "rate_limit" || record.isApiErrorMessage !== true) continue;
      const hit = limitRecord(record);
      return hit && hit.at >= startedAt ? { resetsAt: hit.resetsAt } : undefined;
    } catch {
      // A line Claude is still writing is not a record yet.
    }
  }
  return undefined;
}

/**
 * Whether `account` of `agent`, read fresh from its provider, is now out of allowance, with when it is not. This is how
 * a Codex run's nonzero exit is told to be a limit: it prints no status code for it, but its provider's own usage
 * read shows the account full. An OpenCode run is told only by a limit already recorded against it: a full Go
 * window is not a refusal, so it never spends the account on its own.
 */
export function providerLimit(
  agent: Agent,
  account: string | undefined,
  quota: readonly QuotaAccount[],
  now: number,
): LimitHit | undefined {
  const found = quota.find((candidate) => candidate.agent === agent && candidate.name === account);
  const until = found && startLimitedUntil(found, now);
  return until === undefined ? undefined : { resetsAt: Number.isFinite(until) ? until : undefined };
}

/**
 * Whether a child that exited nonzero stopped on its account's usage limit, from the provider's own signal: Muse's
 * session log, the refusal in Claude's transcript, or the account's usage read fresh in `quota` (a recorded limit
 * for OpenCode, whose Go windows alone are not a refusal). Output text is never searched.
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
    case "claude": {
      const refused = claudeLimit(record.id, record.startedAt);
      return refused ? { resetsAt: refused.resetsAt ?? reported?.resetsAt } : reported;
    }
    case "codex":
    case "opencode":
      return reported;
    case "pi":
      return undefined;
  }
}
