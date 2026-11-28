import { readFileSync } from "node:fs";

import { findClaudeTranscript } from "./claude-inbox";
import { type LimitHit, museLimit } from "./muse-limit";
import { type QuotaAccount, startLimitedUntil } from "./quota";
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
      return hit && hit.at >= startedAt
        ? { resetsAt: hit.resetsAt, ...(hit.limit ? { limit: hit.limit } : {}) }
        : undefined;
    } catch {
      // A line Claude is still writing is not a record yet.
    }
  }
  return undefined;
}

/**
 * Whether an Antigravity run stopped on its quota. `agy` exits 3 and writes one `AGY_ERROR: {json}` line to stderr, which
 * a pane's output keeps; the refusal is its `status` of `RESOURCE_EXHAUSTED` (code 429). The reset time is only in
 * `short_error`'s closing `Resets in 1h2m3s.`; a refusal without one is a throttle and is not a limit.
 */
export function agyLimit(output: string | undefined, now: number): LimitHit | undefined {
  for (const line of (output ?? "").split("\n").reverse()) {
    const at = line.indexOf("AGY_ERROR: ");
    if (at < 0) continue;
    let error: { status?: unknown; error_code?: unknown; short_error?: unknown };
    try {
      error = JSON.parse(line.slice(at + "AGY_ERROR: ".length));
    } catch {
      continue;
    }
    if (error.status !== "RESOURCE_EXHAUSTED" || error.error_code !== 429) return undefined;
    const reset = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\.?$/.exec(String(error.short_error ?? ""));
    const seconds = reset ? Number(reset[1] ?? 0) * 3600 + Number(reset[2] ?? 0) * 60 + Number(reset[3] ?? 0) : 0;
    // A 429 that names no reset is a throttle, not an exhausted quota, and spends nothing.
    return seconds > 0 ? { resetsAt: now + seconds * 1000 } : undefined;
  }
  return undefined;
}

/**
 * Whether `account` of `agent`, read fresh from its provider, is now out of allowance, with when it is not. This is how
 * a Codex run's nonzero exit is told to be a limit: it prints no status code for it, but its provider's own usage
 * read shows the account full.
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
 * for OpenCode, whose Go windows alone are not a refusal), or Antigravity's structured `AGY_ERROR` line in the
 * child's `output`.
 */
export function detectLimit(
  record: { agent: Agent; id: string; account?: string; startedAt: number },
  now: number,
  quota: readonly QuotaAccount[],
  output?: string,
): LimitHit | undefined {
  const reported = providerLimit(record.agent, record.account, quota, now);
  switch (record.agent) {
    case "muse":
      return museLimit(record.id);
    case "claude": {
      const refused = claudeLimit(record.id, record.startedAt);
      return refused
        ? { resetsAt: refused.resetsAt ?? reported?.resetsAt, ...(refused.limit ? { limit: refused.limit } : {}) }
        : undefined;
    }
    case "codex":
      return reported;
    case "agy": {
      const refused = agyLimit(output, now);
      return refused;
    }
    case "opencode":
    case "pi":
      return undefined;
  }
}
