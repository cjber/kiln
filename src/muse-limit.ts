import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LimitScope } from "./limit-scope";

/** A run that ended because its account has no allowance left, and when the provider says it has some again, ms. */
export type LimitHit = {
  resetsAt?: number;
  observedAt?: number;
  /** The limit the provider named, when it named one; absent refuses the whole account, as every agent's own limits do. */
  limit?: LimitScope;
};

const museSessions = () => join(Bun.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "muse", "sessions");

/**
 * The one sentence Muse puts its reset time in: its `run.terminal` reason is the vendor's prose, and no other field of
 * the session log carries when the window resets. It is matched whole, after the structured signal, never as a keyword.
 */
const museResetSentence = /Subscription quota exhausted\. Your usage window resets at (\S+Z)\. \(rate_limit_error\)/;

/**
 * Whether a Muse run ended on its tier limit. Muse's session log (written for `exec` runs too) records every failed
 * model attempt as a structured facet, `error_kind: "tier_limit"` with `http_status: 429`; that is the signal. The
 * reset time exists only inside the vendor sentence of the terminal event, so it is read from there when present.
 */
export function museLimit(id: string, root = museSessions()): LimitHit | undefined {
  let path: string | undefined;
  try {
    for (const match of new Bun.Glob(`*/*/*/${id}/session.jsonl`).scanSync({ cwd: root, absolute: true })) path = match;
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  let limited = false;
  let observedAt: number | undefined;
  let resetsAt: number | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("tier_limit") && !line.includes("resets at")) continue;
    try {
      const event = JSON.parse(line) as {
        recorded_at?: number;
        payload?: {
          event?: { details?: { facets?: { error_kind?: string; http_status?: number }[] }; reason?: string };
        };
      };
      const body = event.payload?.event;
      if (body?.details?.facets?.some((facet) => facet.error_kind === "tier_limit" && facet.http_status === 429)) {
        limited = true;
        observedAt = typeof event.recorded_at === "number" ? event.recorded_at / 1_000 : undefined;
      }
      const reset = body?.reason ? museResetSentence.exec(body.reason)?.[1] : undefined;
      if (reset) resetsAt = Date.parse(reset);
    } catch {
      // A line still being written is skipped.
    }
  }
  return limited
    ? { resetsAt: resetsAt !== undefined && !Number.isNaN(resetsAt) ? resetsAt : undefined, observedAt }
    : undefined;
}

/**
 * An unexpired refusal in Muse's newest shared session logs. Use only when the log can be attributed to a single login.
 */
export function museRecentLimit(now: number, root = museSessions()): LimitHit | undefined {
  try {
    const newest = (dir: string) => readdirSync(dir).sort().reverse();
    const files: { id: string; at: number }[] = [];
    for (const year of newest(root).slice(0, 1))
      for (const month of newest(join(root, year)).slice(0, 1))
        for (const day of newest(join(root, year, month)).slice(0, 2))
          for (const id of readdirSync(join(root, year, month, day)))
            files.push({ id, at: statSync(join(root, year, month, day, id, "session.jsonl")).mtimeMs });
    for (const { id } of files.sort((a, b) => b.at - a.at).slice(0, 5)) {
      const hit = museLimit(id, root);
      if (hit?.resetsAt !== undefined && hit.resetsAt > now) return hit;
    }
  } catch {
    // No sessions directory, or one being written: Muse shows no limit.
  }
  return undefined;
}
