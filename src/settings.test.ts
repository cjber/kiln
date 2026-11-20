import { expect, test } from "bun:test";

import { defaults, parseSettings } from "./settings";

test("a partial file overrides only what it names", () => {
  const settings = parseSettings(
    `status_bar = false\ncloud = false\nnotifications = false\n[agents]\nclaude = ["claude", "--model"]\npi = []\n`,
    "config.toml",
  );
  expect(settings.cloud).toBe(false);
  expect(settings.notifications).toBe(false);
  expect(settings.claudeCloud).toBe(false);
  expect(parseSettings("claude_cloud = true").claudeCloud).toBe(true);
  expect(settings.statusBar).toBe(false);
  expect(settings.remoteControl).toBe(true);
  expect(settings.detachKey).toBe(defaults.detachKey);
  expect(settings.agents.claude).toEqual(["claude", "--model"]);
  expect(settings.agents.codex).toEqual(defaults.agents.codex);
  expect(settings.agents.pi).toEqual([]);
  expect(settings.agents.muse).toEqual(["muse"]);
  expect(settings.agents.agy).toEqual(["agy"]);
  expect(parseSettings(`[agents]\nmuse = ["muse", "--provider", "echo"]\n`, "config.toml").agents.muse).toEqual([
    "muse",
    "--provider",
    "echo",
  ]);
});

test("a typo is an error naming the file and key, not a silent default", () => {
  expect(() => parseSettings(`statusbar = false\n`, "config.toml")).toThrow('config.toml: unknown setting "statusbar"');
  expect(() => parseSettings(`cloud = "yes"\n`, "config.toml")).toThrow("cloud must be true or false");
  expect(() => parseSettings(`notifications = "yes"\n`, "config.toml")).toThrow("notifications must be true or false");
  expect(() => parseSettings(`claude_cloud = "yes"\n`, "config.toml")).toThrow("claude_cloud must be true or false");
  expect(() => parseSettings(`zoxide = "yes"\n`, "config.toml")).toThrow("zoxide must be true or false");
  expect(() => parseSettings(`[agents]\ngemini = ["gemini"]\n`, "config.toml")).toThrow('unknown agent "gemini"');
  expect(() => parseSettings(`[phone]\nwrite = "yes"\n`, "config.toml")).toThrow("phone.write must be true or false");
  expect(() => parseSettings(`[phone]\nread = true\n`, "config.toml")).toThrow('unknown setting "phone.read"');
});

test("phones stay read-only unless [phone] write is on", () => {
  expect(defaults.phoneWrite).toBe(false);
  expect(parseSettings(`[phone]\nwrite = true\n`).phoneWrite).toBe(true);
  expect(defaults.prMessages).toBe(false);
  expect(parseSettings("pr_messages = true\n").prMessages).toBe(true);
  expect(() => parseSettings('pr_messages = "on"\n', "config.toml")).toThrow("pr_messages must be true or false");
});

test("the README settings example matches the shipped defaults", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  const example = readme.match(/```toml\n([\s\S]*?)```/);
  expect(example).not.toBeNull();
  expect(parseSettings(example?.[1] ?? "", "README.md")).toEqual(defaults);
});

test("[[accounts]] lists extra logins and rejects what kiln cannot honour", () => {
  const settings = parseSettings(
    `[[accounts]]\nagent = "codex"\nname = "work"\nhome = "/srv/codex-work"\n[[accounts]]\nagent = "muse"\nname = "alt"\nhome = "/srv/muse-alt"\n[[accounts]]\nagent = "claude"\nname = "work"\nhome = "/srv/claude-work"\n`,
    "config.toml",
  );
  expect(settings.accounts).toEqual([
    { agent: "codex", name: "work", home: "/srv/codex-work" },
    { agent: "muse", name: "alt", home: "/srv/muse-alt" },
    { agent: "claude", name: "work", home: "/srv/claude-work" },
  ]);
  expect(defaults.accounts).toEqual([]);
  const bad = (body: string) => () => parseSettings(`[[accounts]]\n${body}`, "config.toml");
  expect(bad('agent = "pi"\nname = "a"\nhome = "/x"')).toThrow("must be claude, codex, muse or opencode");
  expect(bad('agent = "codex"\nname = "default"\nhome = "/x"')).toThrow("accounts.name");
  expect(bad('agent = "codex"\nname = "a"')).toThrow("accounts.home is required");
  expect(bad('agent = "codex"\nname = "a"\nhome = "/x"\nplan = "max"')).toThrow('unknown setting "accounts.plan"');
  expect(() =>
    parseSettings(
      `[[accounts]]\nagent = "codex"\nname = "a"\nhome = "/x"\n[[accounts]]\nagent = "codex"\nname = "a"\nhome = "/y"\n`,
    ),
  ).toThrow("listed twice");
});
