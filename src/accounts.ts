import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterMuseWord } from "./muse";
import type { Settings } from "./settings";

/** Agents whose subscription accounts kiln keeps as separate config homes. Claude's come from mclaude, Pi and agy have one. */
export const accountAgents = ["codex", "muse", "opencode"] as const;
export type AccountAgent = (typeof accountAgents)[number];

/** One login of an agent: `home` is the config home its native CLI is started with. */
export type Account = { agent: AccountAgent; name: string; home: string };

/** The account an agent's own default home is. It is always a candidate, and cannot be configured. */
export const defaultAccount = "default";

export function isAccountAgent(agent: string): agent is AccountAgent {
  return (accountAgents as readonly string[]).includes(agent);
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/**
 * Where each agent keeps the login its account separates, found in its installed source:
 * Codex reads `CODEX_HOME`; Muse reads its credentials from `$XDG_CONFIG_HOME/muse/auth.json`; OpenCode stores
 * its credentials in the database under `$XDG_DATA_HOME/opencode`. Muse and OpenCode have no variable of their own,
 * so the home is an XDG root and {@link prepareHome} links every other tool's entry back to the real one.
 */
export function accountEnv(account: Account): Record<string, string> {
  switch (account.agent) {
    case "codex":
      return { CODEX_HOME: account.home };
    case "muse":
      return { XDG_CONFIG_HOME: account.home };
    case "opencode":
      return { XDG_DATA_HOME: account.home };
  }
}

/** The directory an agent's default home is, which an account's shared entries are linked from. */
function realRoot(agent: AccountAgent): string {
  switch (agent) {
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
 * linked so an account behaves as the default does. Idempotent: it only adds what is missing.
 */
export function prepareHome(account: Account, root = realRoot(account.agent)): void {
  mkdirSync(account.home, { recursive: true, mode: 0o700 });
  switch (account.agent) {
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
  if (agent === "claude") throw new Error("Claude accounts are mclaude's: run `mclaude account add`");
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
