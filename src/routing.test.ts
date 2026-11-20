import { describe, expect, test } from "bun:test";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Account, accountDisabled, pinFor } from "./accounts";
import type { QuotaAccount } from "./quota";
import { chooseRoute, routed, routeNew } from "./routing";

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

  test("default names the one login of an agent with no accounts listed", () => {
    const one = [{ agent: "claude" as const, windows: [], source: "none" as const }];
    expect(chooseRoute("claude", one, [], now, "default")).toEqual({ env: {} });
  });

  test("an account whose login has ended is never chosen, and naming it says how to sign in", () => {
    const ended = [claude("default", [0], { needsLogin: true }), claude("jenny", [50]), claude("work", [70])];
    expect(chooseRoute("claude", ended, configured, now).name).toBe("jenny");
    expect(() => chooseRoute("claude", ended, configured, now, "default")).toThrow(
      "claude account default is signed out; sign in with claude auth login",
    );
    const all = [claude("jenny", [0], { needsLogin: true })];
    expect(() => chooseRoute("claude", all, configured, now)).toThrow(
      "every claude account is signed out; run kiln login claude jenny",
    );
  });

  test("a disabled account is never chosen, and naming it is refused", () => {
    const off = [claude("default", [0], { disabled: true }), claude("jenny", [50]), claude("work", [70])];
    expect(chooseRoute("claude", off, configured, now).name).toBe("jenny");
    expect(() => chooseRoute("claude", off, configured, now, "default")).toThrow("is disabled in kiln's config");
    expect(() => chooseRoute("claude", [off[0] as QuotaAccount], configured, now)).toThrow(
      "every claude account is disabled",
    );
  });

  test("a directory's pin covers everything under it, the deepest winning, and a pinned run is never moved", async () => {
    const pins = [
      { dir: "/srv/job", agent: "claude" as const, account: "jenny" },
      { dir: "/srv/job/inner", agent: "claude" as const, account: "work" },
    ];
    const settings = { accounts: configured, pins };
    expect(pinFor(settings, "claude", "/srv/job/api")?.account).toBe("jenny");
    expect(pinFor(settings, "claude", "/srv/job/inner/x")?.account).toBe("work");
    expect(pinFor(settings, "claude", "/srv/jobs")).toBeUndefined();
    expect(pinFor(settings, "codex", "/srv/job")).toBeUndefined();
    expect(accountDisabled({ accounts: configured, defaultsOff: ["claude"] }, "claude", "default")).toBe(true);
    expect(accountDisabled({ accounts: configured, defaultsOff: ["claude"] }, "claude", "jenny")).toBe(false);
    await expect(routeNew("claude", settings, { cwd: "/srv/job/api", skip: ["jenny"] })).rejects.toThrow(
      "/srv/job is pinned to claude account jenny, which is at its limit",
    );
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
