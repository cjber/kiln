# Configure kiln

Settings live at `${XDG_CONFIG_HOME:-~/.config}/kiln/config.toml`. Read the existing
file first, preserve unrelated values and change only what the user requested.
Unknown keys are errors; do not add speculative settings.

Supported top-level settings:

- `sort`: `project` (default, groups by directory/task name with recent rows first),
  `directory` (full paths), `last_active`, `age` (oldest first), or `harness`.
- `detach_key`: tmux key syntax, default `C-q`.
- `status_bar`, `zoxide`, `remote_control`, `cloud`, `notifications`: booleans, default `true`.
- `notifications` uses `notify-send` for input requests and completed observed turns.
  It requires a desktop notification service; approval pauses are not completion.
- `claude_cloud`: boolean, default `false`; uses Claude's internal cloud API and
  existing login. Enable alongside `cloud` for Claude cloud rows.
- `pr_messages`: boolean, default `false`; `kiln serve` messages a session's agent when its pull
  request's checks fail, it conflicts, gets a review or merges. Needs `gh` and the `kiln setup` service.
- `[agents]`: `claude`, `codex`, `opencode`, `pi`, `muse` and `agy` are arrays of command arguments. An empty
  array hides that harness from new-session choices. Keep arguments separate;
  these are executed directly, not through a shell. Each launches its native TUI. Defaults are `claude`, `codex`, `opencode`, `pi`, `muse` and `agy`.

- `[[accounts]]`: more than one login of `claude`, `codex`, `muse` or `opencode`. Each entry has `agent`,
  `name` and `home`, the config home that account runs in (`CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME`
  for Codex, `XDG_CONFIG_HOME` for Muse, `XDG_DATA_HOME` for OpenCode). The agent's own home stays an
  account called `default`. `kiln login <agent> <name>` signs in inside the account's home.
  A Claude home owns only its login (`.credentials.json`, `.claude.json`); everything else links to
  `~/.claude`, so every account shares transcripts, settings, skills and memory. With Claude accounts
  listed, `[agents] claude` starts `claude` itself, not a wrapper that picks an account of its own.
  A directory that is already a signed-in Claude config dir, such as an mclaude account under
  `~/.mclaude/accounts/<id>`, is adopted by naming it as `home`, with no new login;
  `kiln accounts adopt` writes those entries (`--dry-run` prints them).
  `disabled = true` keeps an account out of every choice and out of the footer. To turn off the
  agent's own home, add an entry named `default` with only `agent` and `disabled = true`.
- `[[pins]]`: `dir`, `agent` and `account`. Sessions of that agent started in `dir`, or anywhere under
  it, always use that account (`default` or an `[[accounts]]` name); the deepest pinned directory
  wins and `--account` overrides it. A pinned run is never moved to another account: when its
  account is spent, the start is refused with the reason.

A new session or `kiln msg spawn` uses the account with the most headroom and skips one at its limit;
`--account NAME` pins one. `--model M` and `--effort E` (Claude and Antigravity `--effort`, Codex `-c model_reasoning_effort`, Pi `--thinking`, Muse `--reasoning-effort`; refused for OpenCode) apply to that spawn only, not to a restart on another account. When a spawned run ends on the provider's usage-limit signal, kiln records
the account as spent until its reset (shown red in the footer) and starts the work again on another
account. Claude resumes the same conversation, since its accounts share one transcript store; Codex, Muse, Antigravity and
OpenCode start fresh with the brief and the last output, and the parent is told which happened.
An interactive Claude session kiln started that stops on its usage limit is restarted in its own
pane on another account, in the same conversation, with a notice and a desktop notification. A
session no account can take stays where it is and the notice says why. When a spent account's
limit has passed, a notification says it has allowance again.

A Claude account whose token expired while idle is renewed by Claude Code: kiln runs
`claude auth status` in its home, at most every half hour, and never writes a token itself. An
account that cannot be renewed shows `login` in the footer and is never chosen until
`kiln login claude <name>` (or `claude auth login` for `default`) signs it in again.
`kiln accounts` prints each account's usage, state (`ok`, `spent`, `login`, `disabled`) and pins;
`--json` gives the same as JSON. With `claude_cloud` on, cloud sessions are listed from every
Claude account, each row naming its account.

Starting `kiln` validates the file and reports a fault before it takes the terminal screen.
In kiln, `s` edits and reloads settings. `o` cycles sorting for the current run;
change `sort` to persist it. Existing session launch arguments are not rewritten.

For Android, `kiln setup` installs a systemd user service for the phone server,
configures Tailscale Serve and prints a pairing QR. `kiln serve` does the same in the foreground.
Use `--origin HTTPS_ORIGIN` with another tunnel or `--local` for localhost only.
`kiln pair HTTPS_ORIGIN --qr` creates another invitation while serving. Credentials are separate from TOML.
Use `kiln devices` and `kiln revoke DEVICE_ID` to manage phone access. Never put
credentials into config files, URLs or issue comments.

The bundled `kiln` skill is maintained by kiln. `kiln skills sync` refreshes it from the
installed executable; TUI startup does the same. To customise these instructions,
copy them into a separately named user or project skill.

Claude, Codex, OpenCode, Pi, Muse and Antigravity use their native desktop TUIs. Kiln observes provider
status updates without starting a second agent. Phone sessions open verified
provider app links, with a browser fallback. OpenCode, Pi, Muse and Antigravity sessions open on the PC.
`remote_control` enables provider-native remote access for new sessions;
`detach_key` and `status_bar` apply to native tmux sessions and the cloud viewer.
