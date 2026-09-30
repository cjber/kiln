---
name: kiln-config
description: Change kiln's session list, agent launch commands, cloud discovery and tmux settings using its strict TOML configuration.
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
- `notifications` uses `notify-send` when an observed working turn reaches idle.
  It requires a desktop notification service; approval pauses are not completion.
- `claude_cloud`: boolean, default `false`; uses Claude's internal cloud API and
  existing login. Enable alongside `cloud` for Claude cloud rows.
- `[agents]`: `claude`, `codex` and `pi` are arrays of command arguments. An empty
  array hides that harness from new-session choices. Keep arguments separate;
  these are executed directly, not through a shell.

`kiln status` loads and validates the file without taking the terminal screen.
In kiln, `s` edits and reloads settings. `o` cycles sorting for the current run;
change `sort` to persist it. Existing session launch arguments are not rewritten.

For Android, run `kiln serve`, expose its localhost port through Tailscale Serve
and pair using `kiln pair HTTPS_ORIGIN --qr`. Credentials are separate from TOML.
Use `kiln devices` and `kiln revoke DEVICE_ID` to manage phone access. Never put
credentials into config files, URLs or issue comments.

The bundled skill is maintained by kiln. `kiln skills sync` refreshes it from the
installed executable; TUI startup does the same. To customise these instructions,
copy them into a separately named user or project skill.
