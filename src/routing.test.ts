import { describe, expect, test } from "bun:test";

import type { QuotaAccount } from "./quota";
import { chooseRoute } from "./routing";

const now = Date.parse("2026-11-19T23:15:00Z");
const later = now + 3_600_000;
const claude = (name: string, id: string, percents: number[], extra: Partial<QuotaAccount> = {}): QuotaAccount => ({
  agent: "claude",
  name,
  id,
  disabled: false,
  windows: percents.map((percent, index) => ({ label: index ? "wk" : "5h", percent, resetsAt: later })),
  source: "mclaude",
  ...extra,
});

describe("routing", () => {
  const accounts = [
    claude("jenny", "f4bs7z2d", [50, 38]),
    claude("cjberragan", "pvdrfbhu", [0]),
    claude("cillian", "k62cv57p", [0], { disabled: true }),
  ];

  test("the account with the most headroom wins and a disabled one never does", () => {
    expect(chooseRoute("claude", accounts, [], now)).toEqual({
      name: "cjberragan",
      env: { MCLAUDE_USE_ACCOUNT: "pvdrfbhu" },
    });
  });

  test("an account at its limit is never chosen, whether a window is full or a run found it spent", () => {
    const full = [claude("jenny", "f4bs7z2d", [100, 20]), claude("cjberragan", "pvdrfbhu", [0], { spentUntil: later })];
    expect(() => chooseRoute("claude", full, [], now)).toThrow("every claude account is at its limit");
    expect(() => chooseRoute("claude", full, [], now, "jenny")).toThrow("at its limit");
    // The full window resets, so the account is open again afterwards.
    expect(chooseRoute("claude", full, [], later + 1).env.MCLAUDE_USE_ACCOUNT).toBeDefined();
  });

  test("--account picks by name or id and rejects an unknown one", () => {
    expect(chooseRoute("claude", accounts, [], now, "jenny").env).toEqual({ MCLAUDE_USE_ACCOUNT: "f4bs7z2d" });
    expect(() => chooseRoute("claude", accounts, [], now, "nobody")).toThrow("no claude account nobody");
  });

  test("accounts a failed run already hit its limit on are skipped", () => {
    expect(chooseRoute("claude", accounts, [], now, undefined, ["cjberragan"]).name).toBe("jenny");
  });

  test("a spent number-less Muse is not chosen", () => {
    const muse: QuotaAccount = { agent: "muse", disabled: false, windows: [], spentUntil: later, source: "none" };
    expect(() => chooseRoute("muse", [muse], [], now)).toThrow("every muse account is at its limit");
  });
});
