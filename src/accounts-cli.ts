import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { type Account, accountDisabled, claudeHome, defaultAccount } from "./accounts";
import { type QuotaAccount, readQuota } from "./quota";
import { startLimitedUntil } from "./routing";
import { ensureSettingsFile, parseSettings, type Settings } from "./settings";
import { clearSpent } from "./spent";

const usage = `usage: kiln accounts [--json]            every agent account: its usage, whether a run can start on it, its pins
       kiln accounts adopt [--dry-run]  add each mclaude Claude account to [[accounts]], with no new login
       kiln accounts reset-limit NAME  forget a recorded Claude refusal after a provider reset`;

/** Whether a run can start on the account now, and why not. */
export type AccountState = "ok" | "spent" | "login" | "disabled";

export type AccountRow = {
  agent: QuotaAccount["agent"];
  name?: string;
  state: AccountState;
  windows: QuotaAccount["windows"];
  /** When a spent account has allowance again, ms. */
  until?: number;
  spentSource?: "run" | "usage";
  usageFetchedAt?: number;
  usageSource: QuotaAccount["source"];
  /** Directories pinned to it. */
  pins: string[];
};

export function accountRows(quota: readonly QuotaAccount[], settings: Settings, now: number): AccountRow[] {
  return quota.map((account) => {
    const until = startLimitedUntil(account, now);
    const state: AccountState = accountDisabled(settings, account.agent, account.name)
      ? "disabled"
      : account.needsLogin
        ? "login"
        : until !== undefined
          ? "spent"
          : "ok";
    return {
      agent: account.agent,
      name: account.name,
      state,
      windows: account.windows,
      usageSource: account.source,
      ...(state === "spent" ? { spentSource: until === account.spentUntil ? "run" : "usage" } : {}),
      ...(account.fetchedAt !== undefined ? { usageFetchedAt: account.fetchedAt } : {}),
      // A full window the provider gave no reset time for is spent with no known end.
      ...(state === "spent" && until !== undefined && Number.isFinite(until) ? { until } : {}),
      pins: settings.pins
        .filter((pin) => pin.agent === account.agent && pin.account === (account.name ?? defaultAccount))
        .map((pin) => pin.dir),
    };
  });
}

const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16)}Z`;

/** One line per account: `claude  jenny  ok  2%·5h 57%·wk  pinned /srv/job`. */
export function formatAccounts(rows: readonly AccountRow[]): string {
  const cells = rows.map((row) => [
    row.agent,
    row.name ?? "",
    row.until === undefined ? row.state : `${row.state} until ${minute(row.until)}`,
    row.windows.length
      ? row.windows.map((window) => `${Math.round(window.percent)}%·${window.label}`).join(" ")
      : "usage unknown",
    [
      row.spentSource === "run"
        ? `recorded run limit${row.usageFetchedAt === undefined ? "" : ` (usage read ${minute(row.usageFetchedAt)})`}`
        : row.spentSource === "usage"
          ? "usage window full"
          : "",
      row.usageSource === "codex-rollout" ? "session history" : "",
      row.usageSource === "opencode-go" ? "OpenCode Go" : "",
      row.pins.length ? `pinned ${row.pins.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("  "),
  ]);
  const widths = [0, 1, 2, 3].map((column) => Math.max(...cells.map((row) => (row[column] as string).length)));
  return cells
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const same = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * The mclaude accounts under `root` that are not accounts yet. An mclaude account directory is already a Claude config
 * dir of the shape kiln keeps, so adopting one is an `[[accounts]]` entry whose home it is. Each is named after the
 * login its `.claude.json` records, and after its directory when that is missing or taken.
 */
export function adoptable(root: string, settings: Settings): Account[] {
  if (!existsSync(root)) return [];
  const known = new Set([same(claudeHome()), ...settings.accounts.map((account) => same(account.home))]);
  const taken = new Set([
    defaultAccount,
    ...settings.accounts.filter((account) => account.agent === "claude").map((account) => account.name),
  ]);
  const found: Account[] = [];
  for (const entry of readdirSync(root).sort()) {
    const home = join(root, entry);
    if (known.has(same(home)) || !existsSync(join(home, ".credentials.json"))) continue;
    let login: unknown;
    try {
      login = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))?.oauthAccount?.emailAddress;
    } catch {
      // A directory with no readable account file is named after itself.
    }
    const local = typeof login === "string" ? (login.split("@")[0] ?? "").replace(/[^\w.-]/g, "-") : "";
    const name = local && !taken.has(local) ? local : entry.replace(/[^\w.-]/g, "-");
    if (taken.has(name)) continue;
    taken.add(name);
    found.push({ agent: "claude", name, home });
  }
  return found;
}

function block(account: Account): string {
  const home = account.home.startsWith(`${homedir()}/`) ? `~${account.home.slice(homedir().length)}` : account.home;
  return `[[accounts]]\nagent = ${JSON.stringify(account.agent)}\nname = ${JSON.stringify(account.name)}\nhome = ${JSON.stringify(home)}\n`;
}

/** `kiln accounts`: what routing sees, and adopting mclaude's accounts. */
export async function runAccountsCli(
  args: readonly string[],
  settings: Settings,
  root = join(homedir(), ".mclaude", "accounts"),
): Promise<void> {
  const [first, ...rest] = args;
  if (first === "reset-limit") {
    const [name] = rest;
    if (rest.length !== 1 || name === undefined) throw new Error(usage);
    if (
      name !== defaultAccount &&
      !settings.accounts.some((account) => account.agent === "claude" && account.name === name)
    )
      throw new Error(`no claude account ${name}`);
    console.log(
      clearSpent("claude", name)
        ? `cleared recorded run limit for claude ${name}`
        : `no recorded run limit for claude ${name}`,
    );
    return;
  }
  if (first === "adopt") {
    if (rest.some((arg) => arg !== "--dry-run")) throw new Error(usage);
    const blocks = adoptable(root, settings).map(block);
    if (!blocks.length) {
      console.log(`no mclaude account in ${root} to adopt`);
      return;
    }
    const added = `\n${blocks.join("\n")}`;
    if (rest.includes("--dry-run")) {
      console.log(added.trim());
      return;
    }
    const path = ensureSettingsFile();
    const next = `${readFileSync(path, "utf8").trimEnd()}\n${added}`;
    parseSettings(next, path);
    writeFileSync(path, next);
    console.log(`added ${blocks.length} Claude account${blocks.length === 1 ? "" : "s"} to ${path}`);
    return;
  }
  if (args.some((arg) => arg !== "--json")) throw new Error(usage);
  const now = Date.now();
  const rows = accountRows(await readQuota(now, settings.accounts), settings, now);
  console.log(first === "--json" ? JSON.stringify(rows, null, 2) : formatAccounts(rows));
}
