import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { claudeLimit, detectLimit } from "./limits";
import { museLimit } from "./muse-limit";
import type { QuotaAccount } from "./quota";

const fixtures = join(import.meta.dir, "fixtures", "limits");
const now = Date.parse("2026-11-19T23:15:00Z");

describe("limit detection", () => {
  test("a recorded Muse session that failed on tier_limit/429 is a limit, with the reset time from its one sentence", () => {
    const hit = museLimit("01a1f627-f68d-7ff2-8ba1-80af5b6151af", join(fixtures, "muse"));
    expect(hit?.resetsAt).toBe(Date.parse("2026-11-23T00:00:00Z"));
    expect(museLimit("00000000-0000-0000-0000-000000000000", join(fixtures, "muse"))).toBeUndefined();
  });

  test("Claude's StopFailure rate_limit record names the session that stopped", () => {
    const limits = join(fixtures, "mclaude");
    expect(claudeLimit("7f0c1c1e-2b6e-4a43-9d0e-0a4f6f3f7f10", 0, limits)).toEqual({});
    expect(claudeLimit("another-session", 0, limits)).toBeUndefined();
  });

  test("Codex and OpenCode are limited when their provider's own read shows the account full", () => {
    const full: QuotaAccount = {
      agent: "opencode",
      disabled: false,
      windows: [{ label: "mo", percent: 100, resetsAt: now + 3_600_000 }],
      source: "opencode-go",
    };
    const record = { agent: "opencode" as const, id: "ses_1", startedAt: now - 1000 };
    expect(detectLimit(record, now, [full])?.resetsAt).toBe(now + 3_600_000);
    expect(detectLimit(record, now, [{ ...full, windows: [{ label: "mo", percent: 40 }] }])).toBeUndefined();
  });
});
