import { expect, test } from "bun:test";

import { defaults, parseSettings } from "./settings";

test("a partial file overrides only what it names", () => {
  const settings = parseSettings(
    `status_bar = false\n[agents]\nclaude = ["claude", "--dangerously-skip-permissions"]\npi = []\n`,
    "config.toml",
  );
  expect(settings.statusBar).toBe(false);
  expect(settings.remoteControl).toBe(true);
  expect(settings.detachKey).toBe(defaults.detachKey);
  expect(settings.agents.claude).toEqual(["claude", "--dangerously-skip-permissions"]);
  expect(settings.agents.codex).toEqual(defaults.agents.codex);
  expect(settings.agents.pi).toEqual([]);
});

test("a typo is an error naming the file and key, not a silent default", () => {
  expect(() => parseSettings(`statusbar = false\n`, "config.toml")).toThrow('config.toml: unknown setting "statusbar"');
  expect(() => parseSettings(`zoxide = "yes"\n`, "config.toml")).toThrow("zoxide must be true or false");
  expect(() => parseSettings(`[agents]\ngemini = ["gemini"]\n`, "config.toml")).toThrow('unknown agent "gemini"');
});
