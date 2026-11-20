import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parseClaudeUsage } from "./claude-usage";
import { codexRollout, type QuotaAccount, quotaFooter } from "./quota";

const fixtures = join(import.meta.dir, "fixtures", "quota");
const now = Date.parse("2026-11-19T23:15:00Z");
const window = (label: string, percent: number) => ({ label, percent, resetsAt: now + 3_600_000 });
const text = (lines: ReturnType<typeof quotaFooter>) => lines.map((line) => line.map((s) => s.text).join(""));

describe("recorded provider data", () => {
  test("a recorded Claude usage response gives the 5-hour and weekly windows", async () => {
    const body = await Bun.file(join(fixtures, "claude", "usage.json")).json();
    expect(parseClaudeUsage(body)).toEqual([
      { label: "5h", percent: 50, resetsAt: Date.parse("2026-11-20T00:00:00.465871+00:00") },
      { label: "wk", percent: 38, resetsAt: Date.parse("2026-11-26T09:00:00.465891+00:00") },
    ]);
    // An account that has not used its 5-hour window reports it as null.
    expect(parseClaudeUsage({ ...body, five_hour: null })?.map((w) => w.label)).toEqual(["wk"]);
    expect(parseClaudeUsage({ error: { type: "authentication_error" } })).toBeUndefined();
  });

  test("a Codex session record gives the weekly window", () => {
    const codex = codexRollout(now, join(fixtures, "codex"));
    expect(codex?.windows).toEqual([{ label: "wk", percent: 34, resetsAt: 1795525202_000 }]);
    expect(codex?.source).toBe("codex-rollout");
  });
});

describe("footer", () => {
  const accounts = [
    { agent: "claude", name: "jenny", windows: [window("5h", 50), window("wk", 38)], source: "claude-usage" },
    { agent: "claude", name: "cjberragan", windows: [window("wk", 0)], source: "claude-usage" },
    codexRollout(now, join(fixtures, "codex")) as QuotaAccount,
    { agent: "muse", windows: [], source: "none" },
    { agent: "opencode", windows: [], source: "none" },
  ] satisfies QuotaAccount[];

  test("one line at 80 columns, every agent in turn", () => {
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
      windows: [{ label: "5h", percent: 96, resetsAt: now + 80 * 60_000 }],
      source: "claude-usage",
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
      windows: [{ label: "mo", percent: 100, resetsAt: Date.parse("2026-12-02T09:46:55Z") }],
      spentUntil: Date.parse("2026-12-02T09:46:55Z"),
      source: "opencode-go",
    };
    expect(text(quotaFooter([spent], 120, now))).toEqual(["opencode spent ↻Dec 2 100%·mo ↻12d10h"]);
  });
});
