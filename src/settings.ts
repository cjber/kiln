import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { type SessionSort, sessionSorts } from "./session-sort";

import { type Agent, agents } from "./sessions";

export type Settings = {
  /** tmux key syntax, e.g. `C-q` or `M-Escape`. */
  detachKey: string;
  /** Initial list order; o cycles it for the current run. */
  sort: SessionSort;
  /** One line at the bottom of an attached session with counts across every session. */
  statusBar: boolean;
  /** Rank new-session directories with zoxide, and record the ones kiln opens. */
  zoxide: boolean;
  /** Legacy configuration compatibility; kiln controls local sessions through ACP. */
  remoteControl: boolean;
  /** Include read-only Codex Cloud tasks. */
  cloud: boolean;
  /** Native desktop notifications when an observed turn reaches idle. */
  notifications: boolean;
  /** Opt into Claude Code's internal cloud-listing API using its existing login. */
  claudeCloud: boolean;
  /** ACP stdio adapter command; an empty list hides it from the new-session picker. */
  agents: Record<Agent, string[]>;
};

export const defaults: Settings = {
  detachKey: "C-q",
  sort: "project",
  statusBar: true,
  zoxide: true,
  remoteControl: true,
  cloud: true,
  notifications: true,
  claudeCloud: false,
  agents: { claude: ["claude-agent-acp"], codex: ["codex-acp"], pi: ["pi-acp"] },
};

const template = `# kiln settings. Delete a line to use its default.

# List order: project (directory/task groups), directory (full paths),
# last_active, age (oldest first) or harness. Groups show the most recent rows first.
sort = "project"

# Leaves an attached session and returns to the list (tmux key syntax).
detach_key = "C-q"

# A one-line bar at the bottom of an attached session: working / waiting / idle.
status_bar = true

# Rank new-session directories with zoxide and record the ones kiln opens.
zoxide = true

# Retained for existing configuration files. Local control uses ACP.
remote_control = true

# Include read-only Codex Cloud tasks, refreshed at most once a minute.
cloud = true

# Notify when a turn finishes (requires notify-send and a desktop notification service).
notifications = true

# Opt into Claude cloud listing through its internal API using the existing login.
# Enter opens the session on claude.ai. This API can change between CLI versions.
claude_cloud = false

# The command each agent starts with. Set one to [] to hide it from \`n\`.
[agents]
claude = ["claude-agent-acp"]
codex = ["codex-acp"]
pi = ["pi-acp"]
`;

function settingsPath(): string {
  const root = Bun.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "kiln", "config.toml");
}

/** Create the commented settings file on first use, so `s` always opens something to edit. */
export function ensureSettingsFile(): string {
  const path = settingsPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template);
  }
  return path;
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

function stringList(path: string, key: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    fail(path, `${key} must be a list of strings`);
  return value;
}

/** A typo in the file is an error, not a silent default: a setting that does nothing is worse than a message. */
export function parseSettings(source: string, path = settingsPath()): Settings {
  const raw = Bun.TOML.parse(source) as Record<string, unknown>;
  const settings: Settings = { ...defaults, agents: { ...defaults.agents } };
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "sort":
        if (!sessionSorts.includes(value as SessionSort)) fail(path, `sort must be one of ${sessionSorts.join(", ")}`);
        settings.sort = value as SessionSort;
        break;
      case "detach_key":
        if (typeof value !== "string" || !value) fail(path, 'detach_key must be a tmux key such as "C-q"');
        settings.detachKey = value;
        break;
      case "status_bar":
      case "zoxide":
      case "remote_control":
        if (typeof value !== "boolean") fail(path, `${key} must be true or false`);
        settings[key === "status_bar" ? "statusBar" : key === "remote_control" ? "remoteControl" : "zoxide"] = value;
        break;
      case "cloud":
        if (typeof value !== "boolean") fail(path, "cloud must be true or false");
        settings.cloud = value;
        break;
      case "claude_cloud":
        if (typeof value !== "boolean") fail(path, "claude_cloud must be true or false");
        settings.claudeCloud = value;
        break;
      case "notifications":
        if (typeof value !== "boolean") fail(path, "notifications must be true or false");
        settings.notifications = value;
        break;
      case "agents":
        if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "[agents] must be a table");
        for (const [agent, command] of Object.entries(value)) {
          if (!agents.includes(agent as Agent))
            fail(path, `unknown agent "${agent}"; kiln supports ${agents.join(", ")}`);
          const argv = stringList(path, `agents.${agent}`, command);
          if (argv.length === 1 && argv[0] === agent) continue;
          if (argv[0] && agents.includes(basename(argv[0]) as Agent))
            fail(path, `agents.${agent} must run an ACP adapter; use ${defaults.agents[agent as Agent][0]}`);
          settings.agents[agent as Agent] = argv;
        }
        break;
      default:
        fail(path, `unknown setting "${key}"`);
    }
  }
  return settings;
}

export function loadSettings(): Settings {
  const path = settingsPath();
  return existsSync(path) ? parseSettings(readFileSync(path, "utf8"), path) : defaults;
}
