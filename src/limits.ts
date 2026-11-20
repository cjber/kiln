import { readFileSync } from "node:fs";

import { findClaudeTranscript } from "./claude-inbox";
import { type LimitHit, museLimit } from "./muse-limit";
import type { QuotaAccount } from "./quota";
import { limitedUntil } from "./routing";
import type { Agent } from "./sessions";

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
      const record = JSON.parse(lines[index] as string) as {
        error?: unknown;
        isApiErrorMessage?: unknown;
        timestamp?: unknown;
        quotaLimits?: { resetsAt?: unknown };
      };
      if (record.error !== "rate_limit" || record.isApiErrorMessage !== true) continue;
      if (typeof record.timestamp !== "string" || !(Date.parse(record.timestamp) >= startedAt)) return undefined;
      const resetsAt = record.quotaLimits?.resetsAt;
      return typeof resetsAt === "number" ? { resetsAt: resetsAt * 1000 } : {};
    } catch {
      // A line Claude is still writing is not a record yet.
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
 * session log, the refusal in Claude's transcript, or (for Claude, Codex and OpenCode) the account's usage, read fresh
 * in `quota`, which shows it full or rate-limited. Output text is never searched.
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
