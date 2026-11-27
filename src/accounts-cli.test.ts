import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AccountRow, accountRows, adoptable, formatAccounts } from "./accounts-cli";
import type { QuotaAccount } from "./quota";
import { defaults, type Settings } from "./settings";

const now = Date.parse("2026-11-19T23:15:00Z");
const later = now + 3_600_000;

test("each account says whether a run can start on it, with its usage and pins", () => {
  const settings: Settings = {
    ...defaults,
    accounts: [
      { agent: "claude", name: "work", home: "/srv/work" },
      { agent: "claude", name: "old", home: "/srv/old", disabled: true },
    ],
    pins: [{ dir: "/srv/job", agent: "claude", account: "work" }],
  };
  const claude = (name: string, extra: Partial<QuotaAccount> = {}): QuotaAccount => ({
    agent: "claude",
    name,
    windows: [{ label: "5h", percent: 12.4, resetsAt: later }],
    source: "claude-usage",
    ...extra,
  });
  const rows = accountRows(
    [
      claude("default", { needsLogin: true }),
      claude("work"),
      claude("old"),
      { agent: "codex", windows: [], spentUntil: later, source: "none" },
    ],
    settings,
    now,
  );
  expect(rows.map((row) => row.state)).toEqual(["login", "ok", "disabled", "spent"]);
  expect(formatAccounts(rows).split("\n")).toEqual([
    "claude  default  login                          12%·5h",
    "claude  work     ok                             12%·5h         pinned /srv/job",
    "claude  old      disabled                       12%·5h",
    "codex            spent until 2026-11-20T00:15Z  usage unknown  recorded run limit",
  ]);
});

test("a full OpenCode Go window is ok to start on, a recorded limit is spent", () => {
  const go: QuotaAccount = {
    agent: "opencode",
    windows: [{ label: "mo", percent: 100, resetsAt: later }],
    source: "opencode-go",
  };
  expect(accountRows([go], { ...defaults }, now)[0]?.state).toBe("ok");
  expect(accountRows([{ ...go, spentUntil: later }], { ...defaults }, now)[0]?.state).toBe("spent");
});

test("an Antigravity account names its full model group, and is spent only when every group is full (#369)", () => {
  const agy = (...windows: [string, number][]): QuotaAccount => ({
    agent: "agy",
    windows: windows.map(([label, percent]) => ({ label, percent, resetsAt: later })),
    source: "agy-statusline",
  });
  const geminiFull = agy(["gemini-5h", 100], ["gemini-weekly", 49], ["3p-5h", 0], ["3p-weekly", 0]);
  const [row] = accountRows([geminiFull], { ...defaults }, now);
  expect(row?.state).toBe("ok");
  expect(row?.fullGroups).toEqual([{ group: "gemini", until: later }]);
  expect(formatAccounts([row as AccountRow])).toContain("gemini models full until");
  const all = accountRows([agy(["gemini-5h", 100], ["3p-weekly", 100])], { ...defaults }, now)[0];
  expect(all?.state).toBe("spent");
  expect(all?.until).toBe(later);
  expect(accountRows([agy(["gemini-5h", 50])], { ...defaults }, now)[0]).toMatchObject({ state: "ok" });
});

test("mclaude accounts not yet listed are adopted under their login's name, a taken name under its directory", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-adopt-"));
  const account = (id: string, email?: string, signedIn = true) => {
    mkdirSync(join(root, id));
    if (signedIn) writeFileSync(join(root, id, ".credentials.json"), "{}");
    writeFileSync(
      join(root, id, ".claude.json"),
      JSON.stringify(email ? { oauthAccount: { emailAddress: email } } : {}),
    );
  };
  account("aaaa", "sam@example.com");
  account("bbbb", "sam@example.org");
  account("cccc");
  account("dddd", "kit@example.com");
  account("eeee", "out@example.com", false);
  const settings: Settings = { ...defaults, accounts: [{ agent: "claude", name: "kit", home: join(root, "dddd") }] };
  expect(adoptable(root, settings)).toEqual([
    { agent: "claude", name: "sam", home: join(root, "aaaa") },
    { agent: "claude", name: "bbbb", home: join(root, "bbbb") },
    { agent: "claude", name: "cccc", home: join(root, "cccc") },
  ]);
  expect(adoptable(join(root, "absent"), settings)).toEqual([]);
});

test("a full window with no reset time is spent with no time to print", () => {
  const rows = accountRows(
    [{ agent: "codex", windows: [{ label: "wk", percent: 100 }], spentUntil: later, source: "codex-daemon" }],
    { ...defaults },
    0,
  );
  expect(formatAccounts(rows)).toMatch(/^codex\s+spent\s+100%·wk\s+usage window full$/);
});

test("a recorded Claude refusal is distinct from a full usage window", () => {
  const account: QuotaAccount = {
    agent: "claude",
    name: "work",
    windows: [{ label: "wk", percent: 0, resetsAt: later }],
    fetchedAt: now - 60_000,
    spentUntil: later,
    source: "claude-usage",
  };
  const [refusal, window] = accountRows(
    [account, { ...account, name: "full", windows: [{ label: "wk", percent: 100, resetsAt: later + 1 }] }],
    defaults,
    now,
  );
  expect(refusal).toMatchObject({ state: "spent", spentSource: "run", usageFetchedAt: account.fetchedAt });
  expect(window).toMatchObject({ state: "spent", spentSource: "usage", until: later + 1 });
  expect(formatAccounts(accountRows([account], defaults, now))).toContain(
    "0%·wk  recorded run limit (usage read 2026-11-19T23:14Z)",
  );
});
