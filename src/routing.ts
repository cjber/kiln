import {
  type Account,
  accountDisabled,
  accountEnv,
  defaultAccount,
  pinFor,
  prepareHome,
  type Routing,
} from "./accounts";
import { type QuotaAccount, readQuota } from "./quota";
import type { Agent } from "./sessions";

/** Which account a new run uses: the environment that pins it (`unset` is a variable it must not inherit), and its name for display. */
export type Route = { name?: string; env: Record<string, string>; unset?: string };

/** `argv` run without the variable the route takes away. tmux can only add to a pane's environment, so `env` removes it. */
export function routed(argv: string[], route: Pick<Route, "unset">): string[] {
  return route.unset ? ["env", "-u", route.unset, ...argv] : argv;
}

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

/**
 * When a new run may not start on the account. Everywhere but OpenCode that is {@link limitedUntil}. OpenCode's
 * windows are OpenCode Go's alone, one provider of the many an opencode session runs on, and Go itself keeps
 * answering past a full monthly window, so a full Go window ranks the account last but never refuses a start; only
 * a limit a run actually ended on, recorded as `spentUntil`, does.
 */
export function startLimitedUntil(account: QuotaAccount, now: number): number | undefined {
  if (account.agent !== "opencode") return limitedUntil(account, now);
  return account.spentUntil !== undefined && account.spentUntil > now ? account.spentUntil : undefined;
}

export const atLimit = (account: QuotaAccount, now: number): boolean => startLimitedUntil(account, now) !== undefined;

/** Spare allowance in the account's tightest window; an account whose provider reports no numbers ranks in the middle. */
export function headroom(account: QuotaAccount): number {
  return account.windows.length ? Math.min(...account.windows.map((window) => 100 - window.percent)) : 50;
}

function routeFor(account: QuotaAccount, configured: readonly Account[]): Route {
  if (account.name === undefined) return { env: {} };
  // Claude's default account is `~/.claude`, which Claude Code uses only with its variable unset, and a variable the
  // launch would inherit (kiln itself running inside a session of another account) would land the run there instead.
  // The other agents' default is whatever home the environment already names.
  if (account.name === defaultAccount)
    return { name: account.name, env: {}, ...(account.agent === "claude" ? { unset: "CLAUDE_CONFIG_DIR" } : {}) };
  const own = configured.find((candidate) => candidate.agent === account.agent && candidate.name === account.name);
  if (!own) return { name: account.name, env: {} };
  prepareHome(own);
  return { name: own.name, env: accountEnv(own) };
}

/** How a signed-out account is signed in again: kiln's own login for a configured one, the agent's for its default. */
function signIn(account: QuotaAccount): string {
  return account.name === undefined || account.name === defaultAccount
    ? `sign in with ${account.agent} auth login`
    : `run kiln login ${account.agent} ${account.name}`;
}

/**
 * The account a new `agent` run starts on: `requested` by name, else the one with the most headroom. An account at its
 * limit is never chosen, so a run that cannot start says when one resets instead of dying on its first request, and
 * neither is one whose login has ended or one the settings disable.
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
  const own = quota.filter((account) => account.agent === agent);
  if (requested !== undefined) {
    // An agent with one login lists it unnamed, and `default` still names it.
    const found = own.find((account) => (account.name ?? defaultAccount) === requested);
    if (!found) {
      const named = own.flatMap((account) => (account.name === undefined ? [] : [account.name]));
      if (!named.length)
        throw new Error(`${agent} has no named accounts and runs on its default login; drop --account ${requested}`);
      throw new Error(`no ${agent} account ${requested}; accounts: ${named.join(", ")}`);
    }
    if (found.disabled) throw new Error(`${agent} account ${requested} is disabled in kiln's config`);
    if (found.needsLogin) throw new Error(`${agent} account ${requested} is signed out; ${signIn(found)}`);
    if (atLimit(found, now)) throw new Error(`${agent} account ${requested} is at its limit`);
    return routeFor(found, configured);
  }
  if (!own.length) return { env: {} };
  const enabled = own.filter((account) => !account.disabled);
  if (!enabled.length) throw new Error(`every ${agent} account is disabled in kiln's config`);
  const usable = enabled.filter((account) => !account.needsLogin);
  if (!usable.length) throw new Error(`every ${agent} account is signed out; ${signIn(enabled[0] as QuotaAccount)}`);
  const open = usable.filter((account) => !atLimit(account, now) && !skip.includes(account.name ?? defaultAccount));
  const best = open.toSorted((a, b) => headroom(b) - headroom(a))[0];
  if (!best) {
    const resets = usable
      .flatMap((account) => [account.spentUntil, ...account.windows.map((w) => w.resetsAt)])
      .filter((at): at is number => at !== undefined && at > now);
    const soonest = resets.length ? ` until ${new Date(Math.min(...resets)).toISOString()}` : "";
    throw new Error(`every ${agent} account is at its limit${soonest}`);
  }
  return routeFor(best, configured);
}

/**
 * Read the quota and choose; a quota that cannot be read leaves the agent's default account in place. A run in a
 * pinned directory (`cwd`) starts on its pinned account as if that were `requested`, and never on another: a pinned
 * run whose account is spent is refused rather than moved.
 */
export async function routeNew(
  agent: Agent,
  settings: Routing,
  options: { requested?: string; skip?: readonly string[]; now?: number; cwd?: string } = {},
): Promise<Route> {
  const { skip = [], now = Date.now() } = options;
  if (agent === "pi") {
    if (options.requested !== undefined) throw new Error("pi has a single account; drop --account");
    return { env: {} };
  }
  const pin = options.requested === undefined ? pinFor(settings, agent, options.cwd) : undefined;
  if (pin && skip.includes(pin.account))
    throw new Error(`${pin.dir} is pinned to ${agent} account ${pin.account}, which is at its limit`);
  const requested = options.requested ?? pin?.account;
  let quota: QuotaAccount[];
  try {
    quota = await readQuota(now, settings.accounts);
  } catch {
    if (requested !== undefined) throw new Error(`could not read ${agent} accounts to find ${requested}`);
    return { env: {} };
  }
  const marked = quota.map((account) =>
    accountDisabled(settings, account.agent, account.name) ? { ...account, disabled: true } : account,
  );
  try {
    return chooseRoute(agent, marked, settings.accounts, now, requested, skip);
  } catch (error) {
    if (pin && error instanceof Error) throw new Error(`${error.message} (${pin.dir} is pinned to it)`);
    throw error;
  }
}
