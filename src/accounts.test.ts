import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accountEnv, loginCommand, prepareHome } from "./accounts";
import { defaults } from "./settings";

test("each agent's account is the variable its own CLI reads", () => {
  expect(accountEnv({ agent: "codex", name: "a", home: "/h" })).toEqual({ CODEX_HOME: "/h" });
  expect(accountEnv({ agent: "muse", name: "a", home: "/h" })).toEqual({ XDG_CONFIG_HOME: "/h" });
  expect(accountEnv({ agent: "opencode", name: "a", home: "/h" })).toEqual({ XDG_DATA_HOME: "/h" });
});

test("login runs the native login after the configured command", () => {
  expect(loginCommand("codex", defaults)).toEqual(["codex", "login"]);
  expect(loginCommand("opencode", defaults)).toEqual(["opencode", "auth", "login"]);
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
