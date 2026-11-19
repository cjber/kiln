import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Account, expandHome, isAccountAgent } from "./accounts";
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
  /** Enable provider-native remote control when launching desktop sessions. */
  remoteControl: boolean;
  /** Include read-only Codex Cloud tasks. */
  cloud: boolean;
  /** Native desktop notifications when an observed turn reaches idle. */
  notifications: boolean;
  /** Opt into Claude Code's internal cloud-listing API using its existing login. */
  claudeCloud: boolean;
  /** The native TUI command for each agent; [] hides an agent from the picker. */
  agents: Record<Agent, string[]>;
  /** Let paired phones start sessions and send prompts. Off by default: a phone that can do so can run code here. */
  phoneWrite: boolean;
  /** `kiln serve` messages an agent when its pull request's checks fail, it conflicts, gets a review or merges. */
  prMessages: boolean;
  /** `kiln serve` warns two running agents when both edit the same file. */
  editMessages: boolean;
  /** `kiln serve` stops the computer suspending while an agent works; the screens still blank and lock. */
  keepAwake: boolean;
  /** Extra logins of codex, muse and opencode, each its own config home. Claude's come from mclaude. */
  accounts: Account[];
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
  agents: { claude: ["claude"], codex: ["codex"], opencode: ["opencode"], pi: ["pi"], muse: ["muse"], agy: ["agy"] },
  phoneWrite: false,
  prMessages: false,
  editMessages: true,
  keepAwake: true,
  accounts: [],
};

const template = `# kiln settings. Delete a line to use its default.

# List order: project (git repository/task groups, worktrees with their repository),
# directory (full paths),
# last_active, age (oldest first) or harness. Groups show the most recent rows first.
sort = "project"

# Leaves an attached session and returns to the list (tmux key syntax).
detach_key = "C-q"

# A one-line bar at the bottom of an attached session: working / waiting / idle.
status_bar = true

# Rank new-session directories with zoxide and record the ones kiln opens.
zoxide = true

# Enable the provider's own remote control for native desktop sessions.
remote_control = true

# Include read-only Codex Cloud tasks, refreshed at most once a minute.
cloud = true

# Notify when a turn finishes (requires notify-send and a desktop notification service).
notifications = true

# Opt into Claude cloud listing through its internal API using the existing login.
# Enter opens the session on claude.ai. This API can change between CLI versions.
claude_cloud = false

# kiln serve messages an agent when its pull request's checks fail, it has merge conflicts,
# it gets a review or it merges. Needs the GitHub CLI and kiln serve running (kiln setup).
pr_messages = false

# kiln serve messages two running agents when both edit the same file, once per file and prompt.
edit_messages = true

# kiln serve stops the computer suspending while an agent is working. Screens still turn off
# and lock as usual. Needs systemd-inhibit.
keep_awake = true

# The command each agent starts with. Set one to [] to hide it from \`n\`.
[agents]
claude = ["claude"]
codex = ["codex"]
opencode = ["opencode"]
pi = ["pi"]
muse = ["muse"]
agy = ["agy"]

# More than one login of codex, muse or opencode: each [[accounts]] entry is a config home of its own, and
# \`kiln login <agent> <name>\` signs in inside it. A new session or \`kiln msg spawn\` uses the account with the
# most headroom. The agent's own home stays an account called "default". Claude's accounts come from mclaude.
# [[accounts]]
# agent = "codex"
# name = "work"
# home = "~/.local/share/kiln/accounts/codex-work"

# Let paired phones start sessions in your directories and send prompts to running ones.
# A phone that can do this can run code on this computer.
[phone]
write = false
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

/** A fault in the user's file, safe to show as written. */
export class SettingsError extends Error {}

function fail(path: string, message: string): never {
  throw new SettingsError(`${path}: ${message}`);
}

function stringList(path: string, key: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    fail(path, `${key} must be a list of strings`);
  return value;
}

function parseAccount(path: string, entry: unknown): Account {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(path, "each [[accounts]] must be a table");
  for (const key of Object.keys(entry))
    if (!["agent", "name", "home"].includes(key)) fail(path, `unknown setting "accounts.${key}"`);
  const { agent, name, home } = entry as Record<string, unknown>;
  if (typeof agent !== "string" || !agent) fail(path, "an [[accounts]] entry needs an agent");
  if (agent === "claude") fail(path, "Claude accounts come from mclaude (mclaude account add), not [[accounts]]");
  if (!isAccountAgent(agent)) fail(path, `accounts.agent "${agent}" must be codex, muse or opencode`);
  if (typeof name !== "string" || !/^[\w.-]+$/.test(name) || name === "default")
    fail(path, 'accounts.name must be letters, digits, ".", "_" or "-", and not "default"');
  if (typeof home !== "string" || !home) fail(path, `accounts.home is required for ${agent} "${name}"`);
  return { agent, name, home: expandHome(home) };
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
      case "edit_messages":
        if (typeof value !== "boolean") fail(path, "edit_messages must be true or false");
        settings.editMessages = value;
        break;
      case "keep_awake":
        if (typeof value !== "boolean") fail(path, "keep_awake must be true or false");
        settings.keepAwake = value;
        break;
      case "pr_messages":
        if (typeof value !== "boolean") fail(path, "pr_messages must be true or false");
        settings.prMessages = value;
        break;
      case "agents":
        if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "[agents] must be a table");
        for (const [agent, command] of Object.entries(value)) {
          if (!agents.includes(agent as Agent))
            fail(path, `unknown agent "${agent}"; kiln supports ${agents.join(", ")}`);
          settings.agents[agent as Agent] = stringList(path, `agents.${agent}`, command);
        }
        break;
      case "accounts":
        if (!Array.isArray(value)) fail(path, "accounts must be [[accounts]] tables");
        settings.accounts = value.map((entry) => parseAccount(path, entry));
        break;
      case "phone":
        if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "[phone] must be a table");
        for (const [name, setting] of Object.entries(value)) {
          if (name !== "write") fail(path, `unknown setting "phone.${name}"`);
          if (typeof setting !== "boolean") fail(path, "phone.write must be true or false");
          settings.phoneWrite = setting;
        }
        break;
      default:
        fail(path, `unknown setting "${key}"`);
    }
  }
  const seen = new Set<string>();
  for (const account of settings.accounts) {
    const key = `${account.agent}:${account.name}`;
    if (seen.has(key)) fail(path, `${account.agent} account "${account.name}" is listed twice`);
    seen.add(key);
  }
  return settings;
}

export function loadSettings(): Settings {
  const path = settingsPath();
  return existsSync(path) ? parseSettings(readFileSync(path, "utf8"), path) : defaults;
}
