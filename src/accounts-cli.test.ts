import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accountRows, adoptable, formatAccounts } from "./accounts-cli";
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
    "claude  work     ok                             12%·5h  pinned /srv/job",
    "claude  old      disabled                       12%·5h",
    "codex            spent until 2026-11-20T00:15Z",
  ]);
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
