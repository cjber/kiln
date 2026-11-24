import { homedir } from "node:os";
import { join } from "node:path";

import type { QuotaWindow } from "./quota";

type Meter = { usedPercent?: unknown; resetsAtMs?: unknown };
type UsageResponse = {
  schemaVersion?: unknown;
  allowance?: { asOfMs?: unknown; tier?: unknown; weekly?: Meter; window?: Meter } | null;
};

export type MuseAllowance = { windows: QuotaWindow[]; fetchedAt?: number; tier?: string };

/** Muse's native usage response. */
export function parseMuseUsage(body: unknown): MuseAllowance | undefined {
  const response = body as UsageResponse | null;
  const allowance = response?.allowance;
  if (response?.schemaVersion !== 1 || !allowance) return undefined;
  const windows: QuotaWindow[] = [];
  for (const [label, meter] of [
    ["5h", allowance.window],
    ["wk", allowance.weekly],
  ] as const) {
    if (typeof meter?.usedPercent !== "number" || !Number.isFinite(meter.usedPercent)) continue;
    const resetsAt =
      typeof meter.resetsAtMs === "number" && Number.isFinite(meter.resetsAtMs) ? meter.resetsAtMs : undefined;
    windows.push({ label, percent: meter.usedPercent, resetsAt });
  }
  if (!windows.length) return undefined;
  const fetchedAt =
    typeof allowance.asOfMs === "number" && Number.isFinite(allowance.asOfMs) ? allowance.asOfMs : undefined;
  return { windows, fetchedAt, tier: typeof allowance.tier === "string" ? allowance.tier : undefined };
}

const everyMs = 60_000;
const reads = new Map<string, { at: number; allowance: Promise<MuseAllowance | undefined> }>();

async function readUsage(home: string): Promise<MuseAllowance | undefined> {
  try {
    const child = Bun.spawn(["muse", "usage", "--json"], {
      env: { ...Bun.env, XDG_CONFIG_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(5000),
    });
    const [source, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? parseMuseUsage(JSON.parse(source)) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the subscription without a model turn. Named accounts use the same config home as their runs. */
export function museAllowance(
  now: number,
  home = Bun.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
): Promise<MuseAllowance | undefined> {
  const cached = reads.get(home);
  if (cached && now - cached.at < everyMs) return cached.allowance;
  const allowance = readUsage(home);
  reads.set(home, { at: now, allowance });
  return allowance;
}

export function forgetMuseAllowances(): void {
  reads.clear();
}
