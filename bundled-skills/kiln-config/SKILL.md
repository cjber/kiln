---
name: kiln-config
description: Change kiln's session list, native agent commands, cloud discovery and tmux settings using its strict TOML configuration.
---

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
- `[agents]`: `claude`, `codex` and `pi` are arrays of command arguments. An empty
  array hides that harness from new-session choices. Keep arguments separate;
  these are executed directly, not through a shell. Claude and Codex launch native TUIs; Pi speaks ACP. Defaults are `claude`, `codex` and `pi-acp`. Generated Claude/Codex ACP defaults migrate; custom native arguments are preserved.

`kiln status` loads and validates the file without taking the terminal screen.
In kiln, `s` edits and reloads settings. `o` cycles sorting for the current run;
change `sort` to persist it. Existing session launch arguments are not rewritten.

For Android, `kiln serve` configures Tailscale Serve and prints a pairing QR.
Use `--origin HTTPS_ORIGIN` with another tunnel or `--local` for localhost only.
`kiln pair HTTPS_ORIGIN --qr` creates another invitation while serving. Credentials are separate from TOML.
Use `kiln devices` and `kiln revoke DEVICE_ID` to manage phone access. Never put
credentials into config files, URLs or issue comments.

The bundled skill is maintained by kiln. `kiln skills sync` refreshes it from the
installed executable; TUI startup does the same. To customise these instructions,
copy them into a separately named user or project skill.

Claude and Codex use their native desktop TUIs. Kiln observes provider
status updates without starting a second agent. Phone sessions open verified
provider app links, with a browser fallback. Pi and saved ACP sessions open on the PC.
`remote_control` enables provider-native remote access for new sessions;
`detach_key` and `status_bar` apply to native tmux sessions and the cloud viewer.
