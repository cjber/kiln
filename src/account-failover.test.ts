import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableAgain, failOverLimited, failoverNotice } from "./account-failover";
import type { QuotaAccount } from "./quota";
import type { Session } from "./sessions";
import { defaults, type Settings } from "./settings";
import { moveClaude } from "./spawn";
import { spentUntil } from "./spent";
import { respawn, start } from "./tmux";
import { killServer } from "./tmux-server";

// A private tmux server, so these tests never touch the real sessions.
const server = `kiln-failover-${process.pid}`;
Bun.env.KILN_TMUX_SERVER = server;
const root = mkdtempSync(join(tmpdir(), "kiln-failover-"));
const saved = { state: Bun.env.XDG_STATE_HOME, config: Bun.env.CLAUDE_CONFIG_DIR };
Bun.env.XDG_STATE_HOME = join(root, "state");
Bun.env.CLAUDE_CONFIG_DIR = join(root, "one");
afterAll(() => {
  killServer(server);
  for (const [name, value] of [
    ["XDG_STATE_HOME", saved.state],
    ["CLAUDE_CONFIG_DIR", saved.config],
  ] as const)
    if (value === undefined) delete Bun.env[name];
    else Bun.env[name] = value;
  rmSync(root, { recursive: true, force: true });
});

const until = async (found: () => boolean) => {
  for (let tries = 0; tries < 100 && !found(); tries++) await Bun.sleep(50);
};

test("a session stopped on its usage limit restarts once, in its pane, on the next account", async () => {
  const [two, cwd, log] = [join(root, "two"), join(root, "work"), join(root, "launches")];
  for (const dir of [two, cwd]) mkdirSync(dir, { recursive: true });
  // Stands in for Claude: it records the account and arguments it was started with, then stays open.
  const claude = join(root, "fake-claude");
  writeFileSync(claude, `#!/bin/sh\nprintf '%s|%s\\n' "$CLAUDE_CONFIG_DIR" "$*" >> ${log}\nexec sleep 600\n`);
  chmodSync(claude, 0o755);
  const settings: Settings = {
    ...defaults,
    agents: { ...defaults.agents, claude: [claude] },
    remoteControl: false,
    accounts: [{ agent: "claude", name: "two", home: two }],
  };
  const id = crypto.randomUUID();
  const name = `claude-${id.slice(0, 8)}`;
  expect(start(name, cwd, ["sleep", "600"], "limited")).toBe(true);
  const now = Date.now();
  const session: Session = {
    agent: "claude",
    id,
    title: "limited",
    cwd,
    startedAt: now - 2_000,
    account: "default",
    limited: { resetsAt: now + 3_600_000, at: now - 1_000 },
    place: { kind: "kiln", name },
  };
  const refused = () => session.limited?.at;
  const routes: string[][] = [];
  const route = async (_agent: string, _settings: unknown, options: { skip?: readonly string[] } = {}) => {
    routes.push([...(options.skip ?? [])]);
    return { name: "two", env: { CLAUDE_CONFIG_DIR: two } };
  };
  const dir = join(root, "claims");
  // The real restart, with a short wait for a command that quits at once.
  const move: typeof moveClaude = (pane, conversation, where, to, settingsGiven) =>
    moveClaude(pane, conversation, where, to, settingsGiven, 500);
  // A conversation resumed since its refusal, perhaps on another account, has not been refused itself.
  expect(await failOverLimited([{ ...session, startedAt: now }], settings, now, dir, route, move, refused)).toEqual([]);
  expect(spentUntil("claude", "default", now)).toBeUndefined();
  // A restart that fails is reported once and tried again.
  const broken = async () => false;
  expect(
    (await failOverLimited([session], settings, now, dir, route, broken, refused)).map((event) => event.kind),
  ).toEqual(["failed"]);
  expect(await failOverLimited([session], settings, now, dir, route, broken, refused)).toEqual([]);
  routes.length = 0;
  // A prompt typed since the listing was taken has put the conversation to work again, and it is left alone.
  expect(await failOverLimited([session], settings, now, dir, route, move, () => undefined)).toEqual([]);
  const first = await failOverLimited([session], settings, now, dir, route, move, refused);
  expect(first.map((event) => event.kind)).toEqual(["moved"]);
  expect(failoverNotice(first[0] as (typeof first)[number])).toBe(
    "limited reached its usage limit and moved to Claude account two",
  );
  // The list and the phone server both see the same refusal; the second to look does nothing.
  expect(await failOverLimited([session], settings, now, dir, route, move, refused)).toEqual([]);
  // The account it ran out on is never the one it moves to, and stays spent until the provider's reset.
  expect(routes[0]).toEqual(["default"]);
  expect(spentUntil("claude", "default", now)).toBe(now + 3_600_000);
  await until(() => existsSync(log));
  const launches = readFileSync(log, "utf8").trim().split("\n");
  expect(launches).toHaveLength(1);
  expect(launches[0]).toStartWith(`${two}|--resume ${id} -- `);
  // The new account's own config trusts the folder, or Claude would stop at its dialog.
  expect(readFileSync(join(two, ".claude.json"), "utf8")).toContain(cwd);
  // A watcher with an older listing leaves what was claimed of this refusal.
  const stale = { ...session, limited: { resetsAt: now + 3_600_000, at: now - 2_000 } };
  expect(await failOverLimited([stale], settings, now, dir, route, move, refused)).toEqual([]);
  expect(await failOverLimited([session], settings, now, dir, route, move, refused)).toEqual([]);
  // Once the provider's reset has passed the session's own account answers again, and it is left where it is.
  const later = { ...session, limited: { resetsAt: now - 1, at: now + 5 } };
  expect(await failOverLimited([later], settings, now, dir, route, move, refused)).toEqual([]);
  // A replaced command is given its environment again; tmux does not carry the first command's over.
  const seen = join(root, "outbox-seen");
  expect(
    respawn(name, cwd, ["sh", "-c", `echo "$KILN_OUTBOX" > ${seen}; exec sleep 600`], undefined, {
      KILN_OUTBOX: "/box",
    }),
  ).toBe(true);
  await until(() => existsSync(seen) && readFileSync(seen, "utf8").length > 0);
  expect(readFileSync(seen, "utf8").trim()).toBe("/box");
});

test("a session no account can take is reported once and left in its pane", async () => {
  const now = Date.now();
  const session: Session = {
    agent: "claude",
    id: crypto.randomUUID(),
    title: "stuck",
    cwd: root,
    startedAt: now,
    account: "two",
    limited: { resetsAt: now + 60_000, at: now },
    place: { kind: "kiln", name: "claude-none" },
  };
  const settings: Settings = { ...defaults, accounts: [{ agent: "claude", name: "two", home: join(root, "two") }] };
  const full = async (): Promise<never> => {
    throw new Error("every claude account is at its limit");
  };
  const moved: string[] = [];
  const move = async (name: string) => {
    moved.push(name);
    return true;
  };
  const dir = join(root, "stuck-claims");
  const events = await failOverLimited([session], settings, now, dir, full, move, () => now);
  expect(events.map(failoverNotice)).toEqual(["stuck reached its usage limit: every claude account is at its limit"]);
  expect(await failOverLimited([session], settings, now, dir, full, move, () => now)).toEqual([]);
  // An account that opens later takes it on the next look.
  const open = async () => ({ name: "default", env: {} });
  expect(
    (await failOverLimited([session], settings, now, dir, open, move, () => now)).map((event) => event.kind),
  ).toEqual(["moved"]);
  expect(moved).toEqual(["claude-none"]);
});

test("a session told to wrap up moves only while its account's usage shows it out of allowance", async () => {
  const now = Date.now();
  const session: Session = {
    agent: "claude",
    id: crypto.randomUUID(),
    title: "wrapped",
    cwd: root,
    startedAt: now - 2_000,
    account: "grace",
    limited: { at: now - 1_000 },
    pid: 7,
    place: { kind: "kiln", name: "claude-grace" },
  };
  const settings: Settings = { ...defaults, accounts: [{ agent: "claude", name: "grace", home: join(root, "grace") }] };
  const route = async () => {
    if (!open) throw new Error("every other claude account is at its limit");
    return { name: "two", env: {} };
  };
  let open = false;
  let quiet = false;
  const moved: string[] = [];
  const move = async (name: string) => {
    moved.push(name);
    return true;
  };
  const refused = () => session.limited?.at;
  const run = async (until: number | undefined, at = now) =>
    (
      await failOverLimited(
        [session],
        settings,
        at,
        join(root, "grace-claims"),
        route,
        move,
        refused,
        async () => until,
        () => quiet,
      )
    ).map((event) => event.kind);
  expect(await run(undefined)).toEqual([]);
  expect(await run(now + 3_600_000)).toEqual(["stuck"]);
  expect(spentUntil("claude", "grace", now)).toBe(now + 3_600_000);
  open = true;
  // Background work a restart would end holds the session where it is.
  expect(await run(undefined)).toEqual([]);
  expect(moved).toEqual([]);
  // The window the note was for has reset: a later full one is not this note's.
  expect(await run(now + 9_000_000, now + 3_600_000)).toEqual([]);
  expect(moved).toEqual([]);
  quiet = true;
  expect(await run(undefined)).toEqual(["moved"]);
  expect(await run(undefined)).toEqual([]);
  expect(moved).toEqual(["claude-grace"]);
});

test("a session stopped on one model's weekly allowance leaves the account open for every other model", async () => {
  const now = Date.now();
  const session: Session = {
    agent: "claude",
    id: crypto.randomUUID(),
    title: "fable",
    cwd: root,
    startedAt: now - 2_000,
    account: "model",
    limited: { resetsAt: now + 3_600_000, at: now - 1_000, limit: { kind: "model", label: "Fable limit" } },
    place: { kind: "kiln", name: "claude-fable" },
  };
  const settings: Settings = { ...defaults, accounts: [{ agent: "claude", name: "model", home: join(root, "model") }] };
  const route = async () => ({ name: "two", env: {} });
  const move = async () => true;
  const events = await failOverLimited([session], settings, now, join(root, "model-claims"), route, move, () => {
    return session.limited?.at;
  });
  expect(events.map(failoverNotice)).toEqual(["fable reached its Fable limit and moved to Claude account two"]);
  // The account's other models still answer, so nothing about it is spent: it can take new runs.
  expect(spentUntil("claude", "model", now)).toBeUndefined();
});

test("an account seen at its limit is reported once when the limit has gone, and never before its time", () => {
  const limited = mkdtempSync(join(tmpdir(), "kiln-limited-"));
  const at = Date.parse("2026-11-19T23:15:00Z");
  const account = (percent: number, extra: Partial<QuotaAccount> = {}): QuotaAccount => ({
    agent: "claude",
    name: "work",
    windows: [{ label: "5h", percent, resetsAt: at + 3_600_000 }],
    source: "claude-usage",
    ...extra,
  });
  expect(availableAgain([account(20)], at, limited)).toEqual([]);
  expect(availableAgain([account(100)], at, limited)).toEqual([]);
  // The provider's numbers fell early; the time it gave has not passed.
  expect(availableAgain([account(20)], at + 60_000, limited)).toEqual([]);
  expect(availableAgain([account(100, { needsLogin: true })], at + 3_700_000, limited)).toEqual([]);
  expect(availableAgain([account(0)], at + 3_700_000, limited)).toEqual(["claude account work"]);
  expect(availableAgain([account(0)], at + 3_800_000, limited)).toEqual([]);
});

test("a full OpenCode Go window is never seen at its limit, a recorded limit is reported when it passes", () => {
  const limited = mkdtempSync(join(tmpdir(), "kiln-limited-opencode-"));
  const at = Date.parse("2026-11-19T23:15:00Z");
  const go = (extra: Partial<QuotaAccount> = {}): QuotaAccount => ({
    agent: "opencode",
    windows: [{ label: "mo", percent: 100, resetsAt: at + 3_600_000 }],
    source: "opencode-go",
    ...extra,
  });
  expect(availableAgain([go()], at, limited)).toEqual([]);
  expect(availableAgain([go({ spentUntil: at + 3_600_000 })], at, limited)).toEqual([]);
  expect(availableAgain([go()], at + 3_700_000, limited)).toEqual(["opencode"]);
  expect(availableAgain([go()], at + 3_800_000, limited)).toEqual([]);
});
