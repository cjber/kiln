import { type Account, accountEnv, defaultAccount, prepareHome } from "./accounts";
import { type QuotaAccount, readQuota } from "./quota";
import type { Agent } from "./sessions";

/** Which account a new run uses: the environment that pins it, and its name for display. */
export type Route = { name?: string; env: Record<string, string> };

/** When the account has allowance again, if the provider says it has none now: a run found it spent, or a window is full. */
export function limitedUntil(account: QuotaAccount, now: number): number | undefined {
  const ends = [
    account.spentUntil,
    ...account.windows.filter((window) => window.percent >= 100).map((window) => window.resetsAt),
  ].filter((at): at is number => at !== undefined && at > now);
  if (ends.length) return Math.max(...ends);
  // A full window with no reset time is not known to end.
  return account.windows.some((window) => window.percent >= 100 && window.resetsAt === undefined)
    ? Infinity
    : undefined;
}

export const atLimit = (account: QuotaAccount, now: number): boolean => limitedUntil(account, now) !== undefined;

/** Spare allowance in the account's tightest window; an account whose provider reports no numbers ranks in the middle. */
export function headroom(account: QuotaAccount): number {
  return account.windows.length ? Math.min(...account.windows.map((window) => 100 - window.percent)) : 50;
}

function routeFor(account: QuotaAccount, configured: readonly Account[]): Route {
  if (account.agent === "claude")
    return account.id ? { name: account.name, env: { MCLAUDE_USE_ACCOUNT: account.id } } : { env: {} };
  if (account.name === undefined || account.name === defaultAccount) return { name: account.name, env: {} };
  const own = configured.find((candidate) => candidate.agent === account.agent && candidate.name === account.name);
  if (!own) return { name: account.name, env: {} };
  prepareHome(own);
  return { name: own.name, env: accountEnv(own) };
}

/**
 * The account a new `agent` run starts on: `requested` by name, else the one with the most headroom. An account at its
 * limit is never chosen, so a run that cannot start says when one resets instead of dying on its first request.
 * `skip` names accounts a failed run already hit its limit on. An agent with a single account needs no pin.
 */
export function chooseRoute(
  agent: Agent,
  quota: readonly QuotaAccount[],
  configured: readonly Account[],
  now: number,
  requested?: string,
  skip: readonly string[] = [],
): Route {
  const own = quota.filter((account) => account.agent === agent && !account.disabled);
  if (requested !== undefined) {
    const found = own.find((account) => account.name === requested || account.id === requested);
    if (!found) {
      if (!own.length) throw new Error(`${agent} has no accounts to pick --account ${requested} from`);
      throw new Error(`no ${agent} account ${requested}; accounts: ${own.map((account) => account.name).join(", ")}`);
    }
    if (atLimit(found, now)) throw new Error(`${agent} account ${found.name} is at its limit`);
    return routeFor(found, configured);
  }
  if (!own.length) return { env: {} };
  const open = own.filter((account) => !atLimit(account, now) && !skip.includes(account.name ?? defaultAccount));
  const best = open.toSorted((a, b) => headroom(b) - headroom(a))[0];
  if (!best) {
    const resets = own
      .flatMap((account) => [account.spentUntil, ...account.windows.map((w) => w.resetsAt)])
      .filter((at): at is number => at !== undefined && at > now);
    const soonest = resets.length ? ` until ${new Date(Math.min(...resets)).toISOString()}` : "";
    throw new Error(`every ${agent} account is at its limit${soonest}`);
  }
  return routeFor(best, configured);
}

/** Read the quota and choose; a quota that cannot be read leaves the agent's default account in place. */
export async function routeNew(
  agent: Agent,
  configured: readonly Account[],
  requested?: string,
  skip: readonly string[] = [],
  now = Date.now(),
): Promise<Route> {
  if (agent === "pi") {
    if (requested !== undefined) throw new Error("pi has a single account; drop --account");
    return { env: {} };
  }
  let quota: QuotaAccount[];
  try {
    quota = await readQuota(now, configured);
  } catch {
    if (requested !== undefined) throw new Error(`could not read ${agent} accounts to find ${requested}`);
    return { env: {} };
  }
  return chooseRoute(agent, quota, configured, now, requested, skip);
}
