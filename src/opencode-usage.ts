import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { QuotaWindow } from "./quota";

/**
 * OpenCode Go's allowance, as the provider reports it. OpenCode's own Console view asks
 * `GET https://opencode.ai/zen/go/v1/usage` with the signed-in credential's access token and its
 * `x-opencode-org-id` (read from the installed opencode source); the answer carries a percent, a status and a reset
 * time for the 5-hour (`rolling`), weekly and monthly windows. These are the provider's numbers, not an estimate.
 */
const usageUrl = "https://opencode.ai/zen/go/v1/usage";

type GoWindow = { status: "ok" | "rate-limited"; percent: number; resetsAt: string };
type GoUsage = { usage: { rolling: GoWindow; weekly: GoWindow; monthly: GoWindow } };

export type OpencodeAllowance = { windows: QuotaWindow[] };

/**
 * The windows of a Go usage response, for display and headroom only. A window the provider marks rate-limited does
 * not make the account spent: Go is one of the providers an opencode session runs on, and it keeps answering past a
 * full monthly window. Only a run that actually ended on its limit spends the account (`spent.ts`).
 */
export function parseGoUsage(body: unknown): OpencodeAllowance | undefined {
  const usage = (body as GoUsage | null)?.usage;
  if (!usage) return undefined;
  const windows: QuotaWindow[] = [];
  for (const [label, window] of [
    ["5h", usage.rolling],
    ["wk", usage.weekly],
    ["mo", usage.monthly],
  ] as const) {
    if (!window || typeof window.percent !== "number") continue;
    const resetsAt = Date.parse(window.resetsAt);
    windows.push({ label, percent: window.percent, resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt });
  }
  return windows.length ? { windows } : undefined;
}

type Credential = { type?: string; access?: string; expires?: number; metadata?: { orgID?: unknown } };

/** The stored OpenCode Console credential of one data home, or undefined when it holds none or it has expired. */
function consoleCredential(dataHome: string, now: number): { token: string; orgID: string } | undefined {
  const path = join(dataHome, "opencode", "opencode.db");
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .query<{ value: string }, []>(
        "SELECT value FROM credential WHERE integration_id = 'opencode' ORDER BY active DESC, time_updated DESC LIMIT 1",
      )
      .get();
    const credential = row ? (JSON.parse(row.value) as Credential) : undefined;
    const orgID = credential?.metadata?.orgID;
    // OpenCode refreshes an expired token when it next runs; kiln only reads, so it shows no numbers until then.
    if (credential?.type !== "oauth" || !credential.access || typeof orgID !== "string") return undefined;
    if (credential.expires !== undefined && credential.expires <= now) return undefined;
    return { token: credential.access, orgID };
  } catch {
    // A database OpenCode is migrating, or one without a credential table, has no Go plan to read.
    return undefined;
  } finally {
    db.close();
  }
}

const everyMs = 60_000;
const reads = new Map<string, { at: number; allowance: OpencodeAllowance | undefined }>();

/** The Go allowance of the OpenCode login under `dataHome`, asked at most once a minute. */
export async function opencodeAllowance(
  now: number,
  dataHome = Bun.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
): Promise<OpencodeAllowance | undefined> {
  const read = reads.get(dataHome);
  if (read && now - read.at < everyMs) return read.allowance;
  const credential = consoleCredential(dataHome, now);
  let allowance: OpencodeAllowance | undefined;
  if (credential) {
    try {
      const response = await fetch(usageUrl, {
        headers: { authorization: `Bearer ${credential.token}`, "x-opencode-org-id": credential.orgID },
        signal: AbortSignal.timeout(8000),
      });
      // 403 is the provider saying this workspace has no Go plan.
      if (response.ok) allowance = parseGoUsage(await response.json());
    } catch {
      // Offline or slow: the footer shows the account without numbers until the next read.
    }
  }
  reads.set(dataHome, { at: now, allowance });
  return allowance;
}

export function forgetAllowances(): void {
  reads.clear();
}
