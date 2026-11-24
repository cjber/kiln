import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

function update(path: string, edit: (state: Record<string, number>) => boolean): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The list, the phone server and each child's exit reporter all record here, and two that read the file before
  // either wrote it would drop one account. Only the process that acquired the lock can replace the file.
  const lock = `${path}.lock`;
  let locked = false;
  for (let waited = 0; waited < 1_000; waited += 5) {
    try {
      mkdirSync(lock);
      locked = true;
      break;
    } catch {
      Bun.sleepSync(5);
    }
  }
  if (!locked) throw new Error("kiln account limit state is locked");
  try {
    const next = read(path);
    if (!edit(next)) return false;
    const temporary = `${path}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Remember that `account` of `agent` is spent until `resetsAt` (ms). */
export function recordSpent(agent: Agent, account: string | undefined, resetsAt: number, path = spentPath()): void {
  update(path, (state) => {
    state[key(agent, account)] = resetsAt;
    return true;
  });
}

/** Forget a run refusal after the provider resets the account. */
export function clearSpent(agent: Agent, account: string | undefined, path = spentPath()): boolean {
  return update(path, (state) => {
    const name = key(agent, account);
    if (!Object.hasOwn(state, name)) return false;
    delete state[name];
    return true;
  });
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
