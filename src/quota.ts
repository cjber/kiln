import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Account, defaultAccount } from "./accounts";
import { claudeNeedsLogin, claudeSignedIn, claudeUsage, forgetClaudeUsage } from "./claude-usage";
import { codexHome, codexRateLimits } from "./codex";
import { museRecentLimit } from "./muse-limit";
import { forgetAllowances, opencodeAllowance } from "./opencode-usage";
import { spentUntil } from "./spent";
import { color } from "./tui";

/** One rate-limit window an agent's provider reports: how much of it is used and when it resets. */
export type QuotaWindow = { label: string; percent: number; resetsAt?: number };

/** One account of one agent. `windows` is empty for an agent whose provider reports nothing kiln can read. */
export type QuotaAccount = {
  agent: "claude" | "codex" | "muse" | "opencode";
  /** Which of the agent's accounts; absent for an agent with one. */
  name?: string;
  windows: QuotaWindow[];
  /** The provider ended a run on its limit, or reports a window rate-limited: out of allowance until then, ms. */
  spentUntil?: number;
  /** The settings say never to start a run on it. */
  disabled?: boolean;
  /** Its login has ended and nothing but signing in again brings it back, so no run can start on it. */
  needsLogin?: boolean;
  /** When the provider's numbers were read, ms; absent when they are live. */
  fetchedAt?: number;
  /** Where the numbers came from, for diagnosing a wrong one. */
  source: "claude-usage" | "codex-daemon" | "codex-rollout" | "opencode-go" | "none";
};

const staleMs = 30 * 60_000;

function windowLabel(minutes: number | null | undefined): string {
  if (!minutes) return "limit";
  if (minutes % 10080 === 0) return minutes === 10080 ? "wk" : `${minutes / 10080}wk`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** A window whose reset time has passed describes a window that no longer exists, so it is not shown. */
function current(windows: QuotaWindow[], now: number): QuotaWindow[] {
  return windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now);
}

type RolloutLimit = { used_percent: number; window_minutes: number | null; resets_at: number | null } | null;

/** The newest `rate_limits` a Codex session recorded, for when no daemon is running to ask. */
export function codexRollout(now: number, home = codexHome()): QuotaAccount | undefined {
  const sessions = join(home, "sessions");
  const newest = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort().reverse() : []);
  for (const year of newest(sessions).slice(0, 1))
    for (const month of newest(join(sessions, year)).slice(0, 2))
      for (const day of newest(join(sessions, year, month)).slice(0, 3)) {
        const folder = join(sessions, year, month, day);
        const files = readdirSync(folder)
          .filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))
          .map((name) => ({ path: join(folder, name), at: statSync(join(folder, name)).mtimeMs }))
          .sort((a, b) => b.at - a.at);
        for (const file of files.slice(0, 5)) {
          const text = readFileSync(file.path, "utf8");
          const lines = text.split("\n");
          for (let index = lines.length - 1; index >= 0; index--) {
            if (!lines[index]?.includes('"rate_limits"')) continue;
            try {
              const event = JSON.parse(lines[index] as string) as {
                payload?: { rate_limits?: { primary: RolloutLimit; secondary: RolloutLimit } | null };
              };
              const limits = event.payload?.rate_limits;
              if (!limits) continue;
              const windows = [limits.primary, limits.secondary].flatMap((limit) =>
                limit
                  ? [
                      {
                        label: windowLabel(limit.window_minutes),
                        percent: limit.used_percent,
                        resetsAt: limit.resets_at ? limit.resets_at * 1000 : undefined,
                      },
                    ]
                  : [],
              );
              return {
                agent: "codex",
                windows: current(windows, now),
                fetchedAt: file.at,
                source: "codex-rollout",
              };
            } catch {}
          }
        }
      }
  return undefined;
}

const codexEveryMs = 30_000;
const codexReads = new Map<string, { at: number; account: QuotaAccount | undefined }>();

/** One Codex home's plan limits: the running daemon's answer, else the last session's record. Asked at most every 30 s. */
export async function codexAccount(now: number, home?: string): Promise<QuotaAccount | undefined> {
  const key = codexHome(home);
  const read = codexReads.get(key);
  if (read && now - read.at < codexEveryMs) return read.account;
  const live = await codexRateLimits(home);
  const account: QuotaAccount | undefined = live
    ? {
        agent: "codex",
        windows: current(
          [live.primary, live.secondary].flatMap((limit) =>
            limit
              ? [
                  {
                    label: windowLabel(limit.windowDurationMins),
                    percent: limit.usedPercent,
                    resetsAt: limit.resetsAt ? limit.resetsAt * 1000 : undefined,
                  },
                ]
              : [],
          ),
          now,
        ),
        source: "codex-daemon",
      }
    : codexRollout(now, key);
  codexReads.set(key, { at: now, account });
  return account;
}

/**
 * Every agent account's plan usage, as its provider reports it. Claude's comes from the usage meter Claude Code's own
 * `/usage` view reads, for each config dir that is signed in. OpenCode Go's allowance comes from the usage
 * endpoint OpenCode's own Console view reads. Muse publishes none kiln can read (`muse usage` answers
 * `server_sent_no_usage`), so it is listed without numbers rather than guessed.
 */
export async function readQuota(now = Date.now(), accounts: readonly Account[] = []): Promise<QuotaAccount[]> {
  const named = (agent: Account["agent"]) => accounts.filter((account) => account.agent === agent);
  // An agent with configured accounts names its own home too, so every row says which login it is.
  const codex = await Promise.all([
    codexAccount(now),
    ...named("codex").map((account) => codexAccount(now, account.home)),
  ]);
  const codexNames = named("codex").length ? [defaultAccount, ...named("codex").map((account) => account.name)] : [];
  // Muse's sessions stay in its default data home whatever account ran them, so its recent limit is the default's.
  const museLimit = museRecentLimit(now);
  const withoutNumbers = (agent: "muse"): QuotaAccount[] =>
    (named(agent).length ? [defaultAccount, ...named(agent).map((account) => account.name)] : [undefined]).map(
      (name) => ({
        agent,
        name,
        windows: [],
        ...(museLimit?.resetsAt !== undefined && (name === undefined || name === defaultAccount)
          ? { spentUntil: museLimit.resetsAt }
          : {}),
        source: "none" as const,
      }),
    );
  const opencodeHomes = [
    { name: named("opencode").length ? defaultAccount : undefined, home: undefined },
    ...named("opencode").map((account) => ({ name: account.name, home: account.home })),
  ];
  const opencode = await Promise.all(
    opencodeHomes.map(async ({ name, home }): Promise<QuotaAccount> => {
      const allowance = await opencodeAllowance(now, home);
      return {
        agent: "opencode",
        name,
        windows: current(allowance?.windows ?? [], now),
        ...(allowance?.limitedUntil !== undefined && allowance.limitedUntil > now
          ? { spentUntil: allowance.limitedUntil }
          : {}),
        source: allowance ? "opencode-go" : "none",
      };
    }),
  );
  const claudeHomes = [
    // With no Claude accounts configured the one login is whichever config dir kiln's own environment names.
    named("claude").length
      ? { name: defaultAccount, home: undefined }
      : { name: undefined, home: Bun.env.CLAUDE_CONFIG_DIR || undefined },
    ...named("claude").map((account) => ({ name: account.name, home: account.home })),
  ];
  const claude = await Promise.all(
    claudeHomes.map(async ({ name, home }): Promise<QuotaAccount | undefined> => {
      // A config dir nobody signed in to is not an account a run could start on.
      if (!claudeSignedIn(home)) return undefined;
      const usage = await claudeUsage(now, home);
      return {
        agent: "claude",
        name,
        windows: current(usage?.windows ?? [], now),
        ...(usage ? { fetchedAt: usage.fetchedAt } : {}),
        ...(claudeNeedsLogin(now, home) ? { needsLogin: true } : {}),
        source: usage ? "claude-usage" : "none",
      };
    }),
  );
  const listed = [
    ...claude.filter((account) => account !== undefined),
    ...codex.flatMap((account, index) => (account ? [{ ...account, name: codexNames[index] }] : [])),
    ...withoutNumbers("muse"),
    ...opencode,
  ];
  return listed.map((account) => {
    const until = Math.max(spentUntil(account.agent, account.name, now) ?? 0, account.spentUntil ?? 0);
    return until > now ? { ...account, spentUntil: until } : account;
  });
}

/** Drop the cached provider reads, so the next one is fresh: a run just ended on a limit and the footer must say so. */
export function forgetReads(): void {
  forgetClaudeUsage();
  codexReads.clear();
  forgetAllowances();
}

export type FooterSegment = { text: string; fg: string };

function headroomColor(percent: number): string {
  return percent >= 85 ? color.red : percent >= 60 ? color.yellow : color.green;
}

function untilReset(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
  return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
}

function resetDay(resetsAt: number): string {
  return new Date(resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The footer: `claude jenny 50%·5h 38%·wk  cjberragan 0%·wk  codex 34%·wk  muse  opencode`, one chunk per
 * agent, wrapped onto at most two lines of `width`. A window past 85% adds when it resets (`96%·5h ↻1h20`);
 * a read older than 30 minutes is dimmed, an account a run found spent shows `spent ↻Nov 23` in red, and one whose
 * login has ended shows `login` in red instead of numbers.
 */
export function quotaFooter(accounts: readonly QuotaAccount[], width: number, now: number): FooterSegment[][] {
  const chunks: FooterSegment[][] = [];
  for (const agent of ["claude", "codex", "muse", "opencode"] as const) {
    const own = accounts.filter((account) => account.agent === agent);
    if (!own.length) continue;
    const chunk: FooterSegment[] = [{ text: agent, fg: color.fgDim }];
    for (const account of own) {
      const stale = account.fetchedAt !== undefined && now - account.fetchedAt > staleMs;
      if (account.name) chunk.push({ text: ` ${account.name}`, fg: stale ? color.comment : color.fg });
      if (account.needsLogin) {
        // Its last numbers describe a login no run can use.
        chunk.push({ text: " login", fg: color.red }, { text: " ", fg: color.fg });
        continue;
      }
      if (account.spentUntil !== undefined)
        chunk.push({ text: ` spent ↻${resetDay(account.spentUntil)}`, fg: color.red });
      for (const window of account.windows) {
        const reset = window.percent >= 85 && window.resetsAt ? ` ↻${untilReset(window.resetsAt, now)}` : "";
        chunk.push({
          text: ` ${Math.round(window.percent)}%·${window.label}${reset}`,
          fg: stale ? color.comment : headroomColor(window.percent),
        });
      }
      chunk.push({ text: " ", fg: color.fg });
    }
    chunks.push(chunk);
  }
  const lines: FooterSegment[][] = [];
  let used = 0;
  for (const chunk of chunks) {
    const trimmed = chunk.slice(0, -1);
    const size = trimmed.reduce((total, segment) => total + segment.text.length, 0);
    const last = lines.at(-1);
    if (last && used + 2 + size <= width) {
      last.push({ text: "  ", fg: color.fg }, ...trimmed);
      used += 2 + size;
    } else if (lines.length < 2) {
      lines.push([...trimmed]);
      used = size;
    }
  }
  return lines;
}
