import { expect, test } from "bun:test";

import { defaults, parseSettings } from "./settings";

test("a partial file overrides only what it names", () => {
  const settings = parseSettings(
    `status_bar = false\ncloud = false\nnotifications = false\n[agents]\nclaude = ["claude-agent-acp", "--model"]\npi = []\n`,
    "config.toml",
  );
  expect(settings.cloud).toBe(false);
  expect(settings.notifications).toBe(false);
  expect(settings.claudeCloud).toBe(false);
  expect(parseSettings("claude_cloud = true").claudeCloud).toBe(true);
  expect(settings.statusBar).toBe(false);
  expect(settings.remoteControl).toBe(true);
  expect(settings.detachKey).toBe(defaults.detachKey);
  expect(settings.agents.claude).toEqual(["claude-agent-acp", "--model"]);
  expect(settings.agents.codex).toEqual(defaults.agents.codex);
  expect(settings.agents.pi).toEqual([]);
});

test("a typo is an error naming the file and key, not a silent default", () => {
  expect(() => parseSettings(`statusbar = false\n`, "config.toml")).toThrow('config.toml: unknown setting "statusbar"');
  expect(() => parseSettings(`cloud = "yes"\n`, "config.toml")).toThrow("cloud must be true or false");
  expect(() => parseSettings(`notifications = "yes"\n`, "config.toml")).toThrow("notifications must be true or false");
  expect(() => parseSettings(`claude_cloud = "yes"\n`, "config.toml")).toThrow("claude_cloud must be true or false");
  expect(() => parseSettings(`zoxide = "yes"\n`, "config.toml")).toThrow("zoxide must be true or false");
  expect(() => parseSettings(`[agents]\ngemini = ["gemini"]\n`, "config.toml")).toThrow('unknown agent "gemini"');
});

test("the README settings example matches the shipped defaults", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  const example = readme.match(/```toml\n([\s\S]*?)```/);
  expect(example).not.toBeNull();
  expect(parseSettings(example?.[1] ?? "", "README.md")).toEqual(defaults);
});

test("old generated agent defaults migrate while custom native commands fail clearly", () => {
  expect(parseSettings('[agents]\nclaude = ["claude"]\ncodex = ["codex"]\npi = ["pi"]').agents).toEqual(
    defaults.agents,
  );
  expect(() => parseSettings('[agents]\ncodex = ["codex", "--model", "custom"]')).toThrow("ACP adapter");
});
