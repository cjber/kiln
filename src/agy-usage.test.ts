import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agyQuotaWindows, agyUsage, recordAgyUsage } from "./agy-usage";

test("Antigravity quota captures only the provider buckets", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-agy-usage-"));
  try {
    const path = join(dir, "agy-usage.json");
    const now = Date.parse("2026-11-24T12:00:00Z");
    recordAgyUsage(
      {
        product: "antigravity",
        email: "person@example.test",
        transcript_path: "/some/private/path",
        quota: {
          "gemini-weekly": { remaining_fraction: 0.75, reset_time: "2026-11-24T13:00:00Z" },
          "gemini-rolling": { remaining_amount: 20, reset_in_seconds: 60 },
          "another-weekly": { remaining_fraction: 0, disabled: true },
          "\u001b[5m": { remaining_fraction: 0.5 },
        },
      },
      now,
      path,
    );
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("person@example.test");
    expect(source).not.toContain("/some/private/path");
    const usage = agyUsage(path);
    expect(usage).toEqual({
      observedAt: now,
      buckets: [
        { id: "gemini-weekly", remainingFraction: 0.75, resetsAt: now + 3_600_000 },
        { id: "gemini-rolling", remainingAmount: 20, resetsAt: now + 60_000 },
        { id: "another-weekly", remainingFraction: 0, disabled: true },
      ],
    });
    if (!usage) throw new Error("No quota observation");
    expect(agyQuotaWindows(usage)).toEqual([{ label: "gemini-weekly", percent: 25, resetsAt: now + 3_600_000 }]);
    recordAgyUsage({ product: "antigravity", quota: {} }, now + 1_000, path);
    expect(agyUsage(path)).toEqual(usage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
