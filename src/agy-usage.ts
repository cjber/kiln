import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { QuotaWindow } from "./quota";

type StatusBucket = {
  remaining_fraction?: unknown;
  remaining_amount?: unknown;
  reset_time?: unknown;
  reset_in_seconds?: unknown;
  disabled?: unknown;
};

export type AgyBucket = {
  id: string;
  remainingFraction?: number;
  remainingAmount?: number;
  resetsAt?: number;
  disabled?: boolean;
};

export type AgyUsage = { observedAt: number; buckets: AgyBucket[] };

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resetsAt(bucket: StatusBucket, now: number): number | undefined {
  const absolute = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
  if (Number.isFinite(absolute)) return absolute;
  const seconds = finite(bucket.reset_in_seconds);
  return seconds !== undefined && seconds >= 0 ? now + seconds * 1_000 : undefined;
}

/** Select only quota fields from Antigravity's documented status-line JSON. */
export function parseAgyUsage(payload: unknown, now: number): AgyUsage | undefined {
  if (typeof payload !== "object" || !payload) return undefined;
  const { product, quota } = payload as { product?: unknown; quota?: unknown };
  if (product !== "antigravity" || typeof quota !== "object" || !quota || Array.isArray(quota)) return undefined;
  const buckets: AgyBucket[] = [];
  for (const [id, raw] of Object.entries(quota)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof raw !== "object" || !raw || Array.isArray(raw)) continue;
    const bucket = raw as StatusBucket;
    const fraction = finite(bucket.remaining_fraction);
    const amount = finite(bucket.remaining_amount);
    const remainingFraction = fraction !== undefined && fraction >= 0 && fraction <= 1 ? fraction : undefined;
    const remainingAmount = amount !== undefined && amount >= 0 ? amount : undefined;
    const disabled = typeof bucket.disabled === "boolean" ? bucket.disabled : undefined;
    if (remainingFraction === undefined && remainingAmount === undefined && disabled === undefined) continue;
    buckets.push({ id, remainingFraction, remainingAmount, resetsAt: resetsAt(bucket, now), disabled });
  }
  return buckets.length ? { observedAt: now, buckets } : undefined;
}

export function agyQuotaWindows(usage: AgyUsage): QuotaWindow[] {
  return usage.buckets.flatMap(({ id, remainingFraction, resetsAt, disabled }) =>
    remainingFraction === undefined || disabled
      ? []
      : [{ label: id, percent: (1 - remainingFraction) * 100, resetsAt }],
  );
}

const statePath = () => join(Bun.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kiln", "agy-usage.json");

/** A callback without quota data leaves the previous observation available. */
export function recordAgyUsage(payload: unknown, now = Date.now(), path = statePath()): void {
  const usage = parseAgyUsage(payload, now);
  if (!usage) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(usage), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

export function agyUsage(path = statePath()): AgyUsage | undefined {
  try {
    const usage = JSON.parse(readFileSync(path, "utf8")) as AgyUsage;
    return Number.isFinite(usage.observedAt) && Array.isArray(usage.buckets) ? usage : undefined;
  } catch {
    return undefined;
  }
}
