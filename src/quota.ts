import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { codexRateLimits } from "./codex";
import { color } from "./tui";

/** One rate-limit window an agent's provider reports: how much of it is used and when it resets. */
export type QuotaWindow = { label: string; percent: number; resetsAt?: number };

/** One account of one agent. `windows` is empty for an agent whose provider reports nothing kiln can read. */
export type QuotaAccount = {
  agent: "claude" | "codex" | "muse" | "opencode";
  /** Which of the agent's accounts; absent for an agent with one. */
  name?: string;
  disabled: boolean;
  windows: QuotaWindow[];
  /** When the provider's numbers were read, ms; absent when they are live. */
  fetchedAt?: number;
  /** Where the numbers came from, for diagnosing a wrong one. */
  source: "mclaude" | "codex-daemon" | "codex-rollout" | "none";
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

type McLaudeWindow = { utilization: number; resets_at: string | null } | null | undefined;

/** Every mclaude account's last good usage read, from its state files. */
export function claudeAccounts(now: number, home = join(homedir(), ".mclaude")): QuotaAccount[] {
  const dir = join(home, "state");
  if (!existsSync(dir)) return [];
  const accounts: QuotaAccount[] = [];
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    try {
      const state = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        alias?: string;
        id?: string;
        disabled?: boolean;
        usage?: { lastGood?: { five_hour?: McLaudeWindow; seven_day?: McLaudeWindow }; fetchedAt?: string };
      };
      const good = state.usage?.lastGood;
      const windows = (
        [
          ["5h", good?.five_hour],
          ["wk", good?.seven_day],
        ] as const
      ).flatMap(([label, window]) =>
        window
          ? [
              {
                label,
                percent: window.utilization,
                resetsAt: window.resets_at ? Date.parse(window.resets_at) : undefined,
              },
            ]
          : [],
      );
      accounts.push({
        agent: "claude",
        name: state.alias ?? state.id ?? file.slice(0, -5),
        disabled: state.disabled === true,
        windows: current(windows, now),
        fetchedAt: state.usage?.fetchedAt ? Date.parse(state.usage.fetchedAt) : undefined,
        source: "mclaude",
      });
    } catch {
      // A state file mclaude is rewriting reads whole on the next refresh.
    }
  }
  return accounts;
}

type RolloutLimit = { used_percent: number; window_minutes: number | null; resets_at: number | null } | null;

/** The newest `rate_limits` a Codex session recorded, for when no daemon is running to ask. */
export function codexRollout(
  now: number,
  home = Bun.env.CODEX_HOME ?? join(homedir(), ".codex"),
): QuotaAccount | undefined {
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
                disabled: false,
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
let codexRead: { at: number; account: QuotaAccount | undefined } = { at: 0, account: undefined };

/** Codex's plan limits: the running daemon's answer, else the last session's record. Asked at most every 30 s. */
async function codexAccount(now: number): Promise<QuotaAccount | undefined> {
  if (now - codexRead.at < codexEveryMs) return codexRead.account;
  const live = await codexRateLimits();
  const account: QuotaAccount | undefined = live
    ? {
        agent: "codex",
        disabled: false,
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
    : codexRollout(now);
  codexRead = { at: now, account };
  return account;
}

/**
 * Every agent account's plan usage, as its provider reports it. Muse and OpenCode publish no usage kiln can
 * read (`muse usage` has no documented shape and answers `server_sent_no_usage`; OpenCode has no plan limit),
 * so they are listed without numbers rather than guessed.
 */
export async function readQuota(now = Date.now()): Promise<QuotaAccount[]> {
  const codex = await codexAccount(now);
  return [
    ...claudeAccounts(now),
    ...(codex ? [codex] : []),
    { agent: "muse", disabled: false, windows: [], source: "none" },
    { agent: "opencode", disabled: false, windows: [], source: "none" },
  ];
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

/**
 * The footer: `claude jenny 50%·5h 38%·wk  cjberragan 0%·wk  codex 34%·wk  muse  opencode`, one chunk per
 * agent, wrapped onto at most two lines of `width`. A window past 85% adds when it resets (`96%·5h ↻1h20`);
 * a read older than 30 minutes is dimmed, and a disabled account is left out.
 */
export function quotaFooter(accounts: readonly QuotaAccount[], width: number, now: number): FooterSegment[][] {
  const chunks: FooterSegment[][] = [];
  for (const agent of ["claude", "codex", "muse", "opencode"] as const) {
    const own = accounts.filter((account) => account.agent === agent && !account.disabled);
    if (!own.length) continue;
    const chunk: FooterSegment[] = [{ text: agent, fg: color.fgDim }];
    for (const account of own) {
      const stale = account.fetchedAt !== undefined && now - account.fetchedAt > staleMs;
      if (account.name) chunk.push({ text: ` ${account.name}`, fg: stale ? color.comment : color.fg });
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
