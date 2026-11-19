import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { claudeAccounts, codexRollout, type QuotaAccount, quotaFooter } from "./quota";

const fixtures = join(import.meta.dir, "fixtures", "quota");
const now = Date.parse("2026-11-19T23:15:00Z");
const text = (lines: ReturnType<typeof quotaFooter>) => lines.map((line) => line.map((s) => s.text).join(""));

describe("recorded provider data", () => {
  test("mclaude state files give each account's windows, disabled flag and read time", () => {
    const accounts = claudeAccounts(now, join(fixtures, "mclaude"));
    expect(accounts.map((a) => [a.name, a.disabled])).toEqual([
      ["jenny", false],
      ["cillian", true],
      ["cjberragan", false],
    ]);
    const jenny = accounts.find((a) => a.name === "jenny");
    expect(jenny?.windows.map((w) => [w.label, w.percent])).toEqual([
      ["5h", 50],
      ["wk", 38],
    ]);
    expect(jenny?.fetchedAt).toBe(Date.parse("2026-11-19T23:12:43.927Z"));
    // cjberragan reports no five-hour window at all.
    expect(accounts.find((a) => a.name === "cjberragan")?.windows.map((w) => w.label)).toEqual(["wk"]);
  });

  test("a window whose reset time has passed is dropped", () => {
    const later = Date.parse("2026-11-20T00:30:00Z");
    expect(
      claudeAccounts(later, join(fixtures, "mclaude"))
        .find((a) => a.name === "jenny")
        ?.windows.map((w) => w.label),
    ).toEqual(["wk"]);
  });

  test("a Codex session record gives the weekly window", () => {
    const codex = codexRollout(now, join(fixtures, "codex"));
    expect(codex?.windows).toEqual([{ label: "wk", percent: 34, resetsAt: 1795525202_000 }]);
    expect(codex?.source).toBe("codex-rollout");
  });
});

describe("footer", () => {
  const accounts = [
    ...claudeAccounts(now, join(fixtures, "mclaude")),
    codexRollout(now, join(fixtures, "codex")) as QuotaAccount,
    { agent: "muse", disabled: false, windows: [], source: "none" },
    { agent: "opencode", disabled: false, windows: [], source: "none" },
  ] satisfies QuotaAccount[];

  test("one line at 80 columns, disabled accounts left out", () => {
    expect(text(quotaFooter(accounts, 78, now))).toEqual([
      "claude jenny 50%·5h 38%·wk  cjberragan 0%·wk  codex 34%·wk  muse  opencode",
    ]);
  });

  test("wraps onto a second line rather than cutting an agent", () => {
    expect(text(quotaFooter(accounts, 50, now))).toEqual([
      "claude jenny 50%·5h 38%·wk  cjberragan 0%·wk",
      "codex 34%·wk  muse  opencode",
    ]);
  });

  test("an account near its limit shows when it resets", () => {
    const near: QuotaAccount = {
      agent: "claude",
      name: "a",
      disabled: false,
      windows: [{ label: "5h", percent: 96, resetsAt: now + 80 * 60_000 }],
      source: "mclaude",
    };
    expect(text(quotaFooter([near], 78, now))).toEqual(["claude a 96%·5h ↻1h20"]);
  });
});

describe("OpenCode Go allowance", () => {
  test("a recorded usage response gives the three windows and the limit the provider reports", async () => {
    const { parseGoUsage } = await import("./opencode-usage");
    const body = await Bun.file(join(import.meta.dir, "fixtures", "opencode", "go-usage.json")).json();
    const allowance = parseGoUsage(body);
    expect(allowance?.windows.map((w) => [w.label, w.percent])).toEqual([
      ["5h", 0],
      ["wk", 5],
      ["mo", 100],
    ]);
    expect(allowance?.limitedUntil).toBe(Date.parse("2026-12-02T09:46:55.000Z"));
    expect(parseGoUsage({ error: "x" })).toBeUndefined();
  });

  test("a spent account shows when it resets, in red", () => {
    const spent: QuotaAccount = {
      agent: "opencode",
      disabled: false,
      windows: [{ label: "mo", percent: 100, resetsAt: Date.parse("2026-12-02T09:46:55Z") }],
      spentUntil: Date.parse("2026-12-02T09:46:55Z"),
      source: "opencode-go",
    };
    expect(text(quotaFooter([spent], 120, now))).toEqual(["opencode spent ↻Dec 2 100%·mo ↻12d10h"]);
  });
});
