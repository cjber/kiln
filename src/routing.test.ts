import { describe, expect, test } from "bun:test";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Account } from "./accounts";
import type { QuotaAccount } from "./quota";
import { chooseRoute, routed } from "./routing";

const now = Date.parse("2026-11-19T23:15:00Z");
const later = now + 3_600_000;
const claude = (name: string, percents: number[], extra: Partial<QuotaAccount> = {}): QuotaAccount => ({
  agent: "claude",
  name,
  windows: percents.map((percent, index) => ({ label: index ? "wk" : "5h", percent, resetsAt: later })),
  source: "claude-usage",
  ...extra,
});

describe("routing", () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-routing-"));
  const configured: Account[] = [
    { agent: "claude", name: "jenny", home: join(home, "jenny") },
    { agent: "claude", name: "work", home: join(home, "work") },
  ];
  const accounts = [claude("default", [70]), claude("jenny", [50, 38]), claude("work", [0])];

  test("the account with the most headroom wins, pinned by its config dir", () => {
    expect(chooseRoute("claude", accounts, configured, now)).toEqual({
      name: "work",
      env: { CLAUDE_CONFIG_DIR: join(home, "work") },
    });
  });

  test("an account at its limit is never chosen, whether a window is full or a run found it spent", () => {
    const full = [claude("jenny", [100, 20]), claude("work", [0], { spentUntil: later })];
    expect(() => chooseRoute("claude", full, configured, now)).toThrow("every claude account is at its limit");
    expect(() => chooseRoute("claude", full, configured, now, "jenny")).toThrow("at its limit");
    // The full window resets, so the account is open again afterwards.
    expect(chooseRoute("claude", full, configured, later + 1).env.CLAUDE_CONFIG_DIR).toBeDefined();
  });

  test("--account picks by name and rejects an unknown one", () => {
    expect(chooseRoute("claude", accounts, configured, now, "jenny").env).toEqual({
      CLAUDE_CONFIG_DIR: join(home, "jenny"),
    });
    expect(() => chooseRoute("claude", accounts, configured, now, "nobody")).toThrow("no claude account nobody");
  });

  test("Claude's default account runs with the config dir variable taken away, another agent's with none set", () => {
    const route = chooseRoute("claude", accounts, configured, now, "default");
    expect(route).toEqual({ name: "default", env: {}, unset: "CLAUDE_CONFIG_DIR" });
    expect(routed(["claude", "-p"], route)).toEqual(["env", "-u", "CLAUDE_CONFIG_DIR", "claude", "-p"]);
    const codex: QuotaAccount = { agent: "codex", name: "default", windows: [], source: "none" };
    expect(chooseRoute("codex", [codex], [], now)).toEqual({ name: "default", env: {} });
    expect(routed(["codex"], {})).toEqual(["codex"]);
  });

  test("a single login with no configured accounts needs no pin", () => {
    expect(chooseRoute("claude", [{ agent: "claude", windows: [], source: "none" }], [], now)).toEqual({ env: {} });
  });

  test("accounts a failed run already hit its limit on are skipped", () => {
    expect(chooseRoute("claude", accounts, configured, now, undefined, ["work"]).name).toBe("jenny");
  });

  test("a spent number-less Muse is not chosen", () => {
    const muse: QuotaAccount = { agent: "muse", windows: [], spentUntil: later, source: "none" };
    expect(() => chooseRoute("muse", [muse], [], now)).toThrow("every muse account is at its limit");
  });
});
