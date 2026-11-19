import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defaultAccount } from "./accounts";
import type { Agent } from "./sessions";

/**
 * Accounts a provider has told kiln are out of allowance, until when. Muse and OpenCode publish no usage numbers, so
 * a run that ended on the provider's limit is the only evidence there is; the record also covers a number-less gap
 * for Codex and Claude between their usage reads. It lives in kiln's state directory and expires by itself.
 */
const spentPath = () => join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "spent.json");

const key = (agent: Agent, account: string | undefined) => `${agent}:${account ?? defaultAccount}`;

function read(path: string): Record<string, number> {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, number>) : {};
  } catch {
    // A file kiln is rewriting reads whole on the next call.
    return {};
  }
}

/** Remember that `account` of `agent` is spent until `resetsAt` (ms). */
export function recordSpent(agent: Agent, account: string | undefined, resetsAt: number, path = spentPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next = { ...read(path), [key(agent, account)]: resetsAt };
  const temporary = `${path}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  renameSync(temporary, path);
}

/** When `account` of `agent` is spent until, if it still is at `now`. */
export function spentUntil(
  agent: Agent,
  account: string | undefined,
  now: number,
  path = spentPath(),
): number | undefined {
  const until = read(path)[key(agent, account)];
  return until !== undefined && until > now ? until : undefined;
}
