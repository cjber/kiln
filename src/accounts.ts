import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterMuseWord } from "./muse";
import type { Settings } from "./settings";

/** Agents whose subscription accounts kiln keeps as separate config homes. Pi and agy have one. */
export const accountAgents = ["claude", "codex", "muse", "opencode"] as const;
export type AccountAgent = (typeof accountAgents)[number];

/** One login of an agent: `home` is the config home its native CLI is started with. */
export type Account = { agent: AccountAgent; name: string; home: string; disabled?: boolean };

/** A directory whose sessions of `agent` always start on `account`, as do those of every directory under it. */
export type Pin = { dir: string; agent: AccountAgent; account: string };

/** What routing reads from the settings: the extra logins, the agents whose default login is not to be used, and the pins. */
export type Routing = { accounts: readonly Account[]; defaultsOff?: readonly AccountAgent[]; pins?: readonly Pin[] };

/** Whether the settings say never to start a run on this account. `name` is absent for an agent's only account. */
export function accountDisabled(settings: Routing, agent: string, name?: string): boolean {
  return name === undefined || name === defaultAccount
    ? (settings.defaultsOff ?? []).some((off) => off === agent)
    : settings.accounts.some(
        (account) => account.agent === agent && account.name === name && account.disabled === true,
      );
}

/** The pin `cwd` falls under for `agent`: the deepest pinned directory that is `cwd` or holds it. */
export function pinFor(settings: Routing, agent: string, cwd: string | undefined): Pin | undefined {
  if (cwd === undefined) return undefined;
  const at = resolve(cwd);
  return (settings.pins ?? [])
    .filter((pin) => pin.agent === agent && (at === pin.dir || at.startsWith(`${pin.dir}/`)))
    .toSorted((a, b) => b.dir.length - a.dir.length)[0];
}

/** The account an agent's own default home is. It is always a candidate, and cannot be configured. */
export const defaultAccount = "default";

export function isAccountAgent(agent: string): agent is AccountAgent {
  return (accountAgents as readonly string[]).includes(agent);
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/**
 * Where each agent keeps the login its account separates, found in its installed source: Claude Code reads
 * `CLAUDE_CONFIG_DIR`; Codex reads `CODEX_HOME`; Muse reads its credentials from `$XDG_CONFIG_HOME/muse/auth.json`; OpenCode stores
 * its credentials in the database under `$XDG_DATA_HOME/opencode`. Muse and OpenCode have no variable of their own,
 * so the home is an XDG root and {@link prepareHome} links every other tool's entry back to the real one.
 */
export function accountEnv(account: Account): Record<string, string> {
  switch (account.agent) {
    case "claude":
      return { CLAUDE_CONFIG_DIR: account.home };
    case "codex":
      return { CODEX_HOME: account.home };
    case "muse":
      return { XDG_CONFIG_HOME: account.home };
    case "opencode":
      return { XDG_DATA_HOME: account.home };
  }
}

/** Claude Code's own config dir, which is the `default` Claude account and what every other account shares. */
export const claudeHome = () => join(homedir(), ".claude");

/** The two files a Claude config dir keeps its login in: the token, and the account it belongs to. */
const claudeLogin = [".credentials.json", ".claude.json"];

/**
 * The directory an agent's default home is, which an account's shared entries are linked from. Claude's is fixed:
 * kiln may itself run inside a Claude session on one of the accounts, whose `CLAUDE_CONFIG_DIR` is not the shared one.
 */
function realRoot(agent: AccountAgent): string {
  switch (agent) {
    case "claude":
      return claudeHome();
    case "codex":
      return Bun.env.CODEX_HOME ?? join(homedir(), ".codex");
    case "muse":
      return Bun.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    case "opencode":
      return Bun.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  }
}

function link(target: string, path: string): void {
  try {
    lstatSync(path);
  } catch {
    if (existsSync(target)) symlinkSync(target, path);
  }
}

/**
 * Make `account.home` usable: the login is the one thing an account owns. Muse and OpenCode change an XDG root, which
 * every other tool the agent runs also reads, so each of the real root's other entries is linked in (`gh`, `git`,
 * `zoxide` keep working inside the session). Muse's settings and trust, and Codex's config and instructions, are
 * linked so an account behaves as the default does. A Claude account links everything but its login, so every account
 * has the same settings, skills, memory and transcripts, and a conversation begun on one resumes on another.
 * Idempotent: it only adds what is missing.
 */
export function prepareHome(account: Account, root = realRoot(account.agent)): void {
  mkdirSync(account.home, { recursive: true, mode: 0o700 });
  switch (account.agent) {
    case "claude":
      // The conversations and the session registry must exist to be linked: created inside an account instead, they
      // would be that account's alone, and its conversations could not be found or resumed from another.
      for (const shared of ["projects", "sessions"]) mkdirSync(join(root, shared), { recursive: true, mode: 0o700 });
      for (const entry of readdirSync(root))
        if (!claudeLogin.includes(entry)) link(join(root, entry), join(account.home, entry));
      return;
    case "codex":
      for (const entry of ["config.toml", "AGENTS.md", "skills"]) link(join(root, entry), join(account.home, entry));
      return;
    case "muse": {
      for (const entry of existsSync(root) ? readdirSync(root) : [])
        if (entry !== "muse") link(join(root, entry), join(account.home, entry));
      mkdirSync(join(account.home, "muse"), { recursive: true, mode: 0o700 });
      for (const entry of ["settings.json", "trust.json"])
        link(join(root, "muse", entry), join(account.home, "muse", entry));
      return;
    }
    case "opencode":
      for (const entry of existsSync(root) ? readdirSync(root) : [])
        if (entry !== "opencode") link(join(root, entry), join(account.home, entry));
      mkdirSync(join(account.home, "opencode"), { recursive: true, mode: 0o700 });
      return;
  }
}

/** The agent's native login command, after its configured command. */
export function loginCommand(agent: AccountAgent, settings: Settings): string[] {
  const command = settings.agents[agent];
  if (!command[0]) throw new Error(`${agent} is hidden in [agents]; give it a command to log in`);
  switch (agent) {
    case "claude": {
      // Only Claude Code itself signs in to a config dir; a wrapper that picks accounts of its own cannot be asked to.
      const at = command.findIndex((word) => basename(word) === "claude");
      if (at < 0) throw new Error(`[agents] claude is ${command[0]}, not claude; set it to claude to log in`);
      return [...command.slice(0, at + 1), "auth", "login"];
    }
    case "codex":
      return [...command.slice(0, command.findIndex((word) => basename(word) === "codex") + 1 || 1), "login"];
    case "muse": {
      const at = afterMuseWord(command);
      return [...command.slice(0, at), "login"];
    }
    case "opencode":
      return [...command, "auth", "login"];
  }
}

/** `kiln login <agent> <name>`: the configured account's home, prepared, with the native login run inside it. */
export async function runLoginCli(args: readonly string[], settings: Settings): Promise<number> {
  const [agent, name, ...extra] = args;
  if (!agent || !name || extra.length) throw new Error("usage: kiln login <agent> <name>");
  if (!isAccountAgent(agent)) throw new Error(`${agent} has no accounts; accounts are for ${accountAgents.join(", ")}`);
  const account = settings.accounts.find((item) => item.agent === agent && item.name === name);
  if (!account) throw new Error(`no [[accounts]] entry for ${agent} "${name}" in kiln's config`);
  const argv = loginCommand(agent, settings);
  if (!Bun.which(argv[0] ?? "")) throw new Error(`${argv[0]} is not on PATH`);
  prepareHome(account);
  const child = Bun.spawn(argv, {
    env: { ...Bun.env, ...accountEnv(account) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

/**
 * The account a running agent process was started on, read from the environment it inherited: the config home of a
 * configured account, else the default. An agent with no configured accounts has no account to show, nor has a
 * Claude run in a config dir that is neither a configured account nor the default.
 */
export function accountOf(
  agent: string,
  environment: Readonly<Record<string, string | undefined>>,
  accounts: readonly Account[],
): string | undefined {
  if (!isAccountAgent(agent)) return undefined;
  const own = accounts.filter((account) => account.agent === agent);
  if (!own.length) return undefined;
  const home = environment[Object.keys(accountEnv(own[0] as Account))[0] as string];
  const found = own.find((account) => home !== undefined && resolve(expandHome(account.home)) === resolve(home));
  if (found) return found.name;
  // Claude's default is one known dir, so a run in some other dir is on a login kiln has no name for.
  if (agent === "claude" && home && resolve(home) !== claudeHome()) return undefined;
  return defaultAccount;
}
