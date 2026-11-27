import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accountEnv, accountOf, loginCommand, prepareHome } from "./accounts";
import { defaults } from "./settings";

test("each agent's account is the variable its own CLI reads", () => {
  expect(accountEnv({ agent: "claude", name: "a", home: "/h" })).toEqual({ CLAUDE_CONFIG_DIR: "/h" });
  expect(accountEnv({ agent: "codex", name: "a", home: "/h" })).toEqual({ CODEX_HOME: "/h" });
  expect(accountEnv({ agent: "muse", name: "a", home: "/h" })).toEqual({ XDG_CONFIG_HOME: "/h" });
  expect(accountEnv({ agent: "opencode", name: "a", home: "/h" })).toEqual({ XDG_DATA_HOME: "/h" });
});

test("login runs the native login after the configured command", () => {
  expect(loginCommand("codex", defaults)).toEqual(["codex", "login"]);
  expect(loginCommand("opencode", defaults)).toEqual(["opencode", "auth", "login"]);
  expect(
    loginCommand("claude", { ...defaults, agents: { ...defaults.agents, claude: ["claude", "--chrome"] } }),
  ).toEqual(["claude", "auth", "login"]);
  // A wrapper that keeps its own accounts cannot be logged in through kiln.
  expect(() =>
    loginCommand("claude", { ...defaults, agents: { ...defaults.agents, claude: ["mclaude", "--chrome"] } }),
  ).toThrow("[agents] claude is mclaude, not claude");
  expect(loginCommand("muse", { ...defaults, agents: { ...defaults.agents, muse: ["env", "A=1", "muse"] } })).toEqual([
    "env",
    "A=1",
    "muse",
    "login",
  ]);
});

test("a Muse home links every other tool's config back, and owns only its login", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-home-"));
  const real = join(dir, "config");
  mkdirSync(join(real, "gh"), { recursive: true });
  mkdirSync(join(real, "muse"));
  writeFileSync(join(real, "muse", "settings.json"), "{}");
  writeFileSync(join(real, "muse", "auth.json"), "secret");
  const home = join(dir, "account");
  prepareHome({ agent: "muse", name: "a", home }, real);
  prepareHome({ agent: "muse", name: "a", home }, real);
  expect(readlinkSync(join(home, "gh"))).toBe(join(real, "gh"));
  expect(readlinkSync(join(home, "muse", "settings.json"))).toBe(join(real, "muse", "settings.json"));
  expect(() => lstatSync(join(home, "muse", "auth.json"))).toThrow();
});

test("a Claude home shares everything but its login with the default config dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-home-"));
  const real = join(dir, "claude");
  mkdirSync(real);
  writeFileSync(join(real, "settings.json"), "{}");
  writeFileSync(join(real, ".credentials.json"), "secret");
  writeFileSync(join(real, ".claude.json"), "{}");
  const home = join(dir, "account");
  prepareHome({ agent: "claude", name: "a", home }, real);
  // An entry the shared dir gains later is linked on the next launch.
  mkdirSync(join(real, "skills"));
  prepareHome({ agent: "claude", name: "a", home }, real);
  // The transcript store is shared even when the default config dir never held a conversation.
  for (const entry of ["projects", "sessions", "settings.json", "skills"])
    expect(readlinkSync(join(home, entry))).toBe(join(real, entry));
  expect(() => lstatSync(join(home, ".credentials.json"))).toThrow();
  expect(() => lstatSync(join(home, ".claude.json"))).toThrow();
});

test("a Claude home keeps a link for launch.json before the shared file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-home-"));
  const real = join(dir, "claude");
  mkdirSync(real);
  writeFileSync(join(real, ".credentials.json"), "secret");
  writeFileSync(join(real, ".claude.json"), "{}");
  const home = join(dir, "account");

  prepareHome({ agent: "claude", name: "a", home }, real);

  expect(readlinkSync(join(home, "launch.json"))).toBe(join(real, "launch.json"));
  expect(existsSync(join(home, "launch.json"))).toBe(false);
  writeFileSync(join(real, "launch.json"), "{}");
  expect(existsSync(join(home, "launch.json"))).toBe(true);
});

test("a Claude home does not link config locks and removes an old lock link", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-home-"));
  const real = join(dir, "claude");
  mkdirSync(real);
  writeFileSync(join(real, ".credentials.json"), "secret");
  writeFileSync(join(real, ".claude.json"), "{}");
  mkdirSync(join(real, ".claude.json.lock"));
  const home = join(dir, "account");
  mkdirSync(home);
  symlinkSync(join(real, ".claude.json.lock"), join(home, ".claude.json.lock"));

  prepareHome({ agent: "claude", name: "a", home }, real);

  expect(() => lstatSync(join(home, ".claude.json.lock"))).toThrow();
});

test("a Claude home keeps its own MCP needs-auth cache and unlinks a shared one", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-home-"));
  const real = join(dir, "claude");
  mkdirSync(real);
  writeFileSync(join(real, "mcp-needs-auth-cache.json"), '{"server":{"timestamp":1}}');
  writeFileSync(join(real, "settings.json"), "{}");
  const fresh = join(dir, "fresh");
  const linked = join(dir, "linked");
  mkdirSync(linked);
  symlinkSync(join(real, "mcp-needs-auth-cache.json"), join(linked, "mcp-needs-auth-cache.json"));

  prepareHome({ agent: "claude", name: "fresh", home: fresh }, real);
  prepareHome({ agent: "claude", name: "linked", home: linked }, real);

  for (const home of [fresh, linked]) {
    expect(() => lstatSync(join(home, "mcp-needs-auth-cache.json"))).toThrow();
    expect(lstatSync(join(home, "settings.json")).isSymbolicLink()).toBe(true);
  }
});

test("a running Claude is named by its config dir, and one in an unlisted dir has no name", () => {
  const accounts = [{ agent: "claude" as const, name: "work", home: "/srv/claude-work" }];
  expect(accountOf("claude", { CLAUDE_CONFIG_DIR: "/srv/claude-work" }, accounts)).toBe("work");
  expect(accountOf("claude", {}, accounts)).toBe("default");
  expect(accountOf("claude", { CLAUDE_CONFIG_DIR: "/srv/elsewhere" }, accounts)).toBeUndefined();
});
