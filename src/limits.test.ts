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

  test("a Claude transcript's rate_limit record is a limit, with the reset time the provider gave", () => {
    const limited = join(fixtures, "claude", "limited.jsonl");
    const refused = Date.parse("2026-11-19T23:10:04.000Z");
    expect(claudeLimit("id", refused - 4000, limited)).toEqual({
      resetsAt: 1795392000_000,
      limit: { kind: "account", label: "weekly limit" },
    });
    // A resumed conversation still holds the record that ended its previous run.
    expect(claudeLimit("id", refused + 1, limited)).toBeUndefined();
    // Prose that only mentions the words is not the record, nor is a 429 with no usage window behind it.
    expect(claudeLimit("id", 0, join(fixtures, "claude", "finished.jsonl"))).toBeUndefined();
    expect(claudeLimit("id", 0, join(fixtures, "claude", "absent.jsonl"))).toBeUndefined();
  });

  test("a refusal of one model's weekly allowance names it, rather than standing for the whole account", () => {
    const fable = join(fixtures, "claude", "fable.jsonl");
    const refused = Date.parse("2026-11-20T22:37:25.822Z");
    // The same weekly reset the account-wide window uses, but only the Fable allowance is used up.
    expect(claudeLimit("id", refused - 4000, fable)).toEqual({
      resetsAt: 1795687200_000,
      limit: { kind: "model", label: "Fable limit" },
    });
  });

  test("Codex is limited when its provider's own read shows the account full", () => {
    const full: QuotaAccount = {
      agent: "codex",
      windows: [{ label: "wk", percent: 100, resetsAt: now + 3_600_000 }],
      source: "codex-daemon",
    };
    const record = { agent: "codex" as const, id: "ses_1", startedAt: now - 1000 };
    expect(detectLimit(record, now, [full])?.resetsAt).toBe(now + 3_600_000);
    expect(detectLimit(record, now, [{ ...full, windows: [{ label: "wk", percent: 40 }] }])).toBeUndefined();
  });

  test("OpenCode quota and earlier refusals do not identify why a new run exited", () => {
    const full: QuotaAccount = {
      agent: "opencode",
      windows: [{ label: "mo", percent: 100, resetsAt: now + 3_600_000 }],
      source: "opencode-go",
    };
    const record = { agent: "opencode" as const, id: "ses_1", startedAt: now - 1000 };
    expect(detectLimit(record, now, [full])).toBeUndefined();
    expect(detectLimit(record, now, [{ ...full, spentUntil: now + 3_600_000 }])).toBeUndefined();
  });
});
