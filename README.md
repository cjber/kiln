<p align="center"><img src="assets/icon.png" width="96" alt="kiln" /></p>

# kiln

kiln runs Claude, Codex and Pi sessions through [ACP](https://agentclientprotocol.com), with a terminal conversation view and a paired Android client. It also lists read-only Codex Cloud tasks and optional Claude cloud sessions.

Local sessions are owned by kiln. Sessions started in unrelated terminals are not discovered. Status, progress and permission requests come from ACP, rather than process scans or terminal output.

<img src="assets/list.png" alt="kiln sessions grouped by directory" />

## Install

```sh
paru -S kiln-agents-bin # standalone binary
# or: paru -S kiln-agents # Bun source package
```

From source, install [Bun](https://bun.sh), fzf and tmux (used by the Codex Cloud viewer), then:

```sh
bun install --frozen-lockfile
bun start
```

Install the adapters for the agents you use:

```sh
npm install -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp pi-acp
```

Claude and Codex adapters use their existing agent credentials. Pi uses its configured providers. An adapter may require authentication before it can create or prompt a session; kiln displays its error. Adapter commands can be overridden in settings.

## Terminal

| Key | Action |
| --- | --- |
| `j` `k`, arrows | Select a session |
| `Enter` | Open a conversation or cloud task |
| `Esc` in a conversation | Return to the list; the session keeps running |
| `Enter` in a conversation | Send a prompt or confirm the selected permission option |
| `Ctrl+C` in a conversation | Stop the current turn |
| `n` | Choose an agent, then a directory through fzf |
| `/` | Filter titles, directories, agent names and status |
| `Tab` | Expand children |
| `o` | Cycle list order |
| `x` | Close a kiln-owned session after confirmation |
| `s` | Edit settings |
| `S` | Open shared skills |
| `r` | Refresh |
| `q` | Quit the list |

Directory headings are orange. Sessions needing permission are yellow, ready sessions are muted green, and working sessions use subdued text. The header counts input requests even when children are collapsed. Opening a yellow session shows the request and the adapter's choices.

A separate owner-only session host keeps ACP connections alive when the list closes. The terminal and phone share that host, so an approval answered on either disappears on both. Kiln saves its own session identities and reloads them when the adapter supports ACP session loading. Failed restoration remains visible with an error. A disconnected adapter has unavailable status; kiln does not invent activity.

Desktop notifications identify the session when it needs input or finishes an observed turn. Enable `notify-send` and a desktop notification service to receive them.

Cloud tasks retain their provider status and verified HTTPS links. Claude cloud tasks open in a browser. Codex Cloud tasks open a read-only CLI status/diff viewer. Cloud tasks cannot be closed or prompted from kiln.

## Settings

Press `s` to edit `~/.config/kiln/config.toml` (`$XDG_CONFIG_HOME` when set). Unknown keys are errors. Commands in `[agents]` must speak ACP over stdio; native interactive agent commands cannot be used.

```toml
sort = "project"
detach_key = "C-q"
status_bar = true
zoxide = true
cloud = true
notifications = true
claude_cloud = false
remote_control = true

[agents]
claude = ["claude-agent-acp"]
codex = ["codex-acp"]
pi = ["pi-acp"]
```

Set an agent command to `[]` to hide it from the new-session picker. Existing configurations using `claude`, `codex` or `pi` as native commands need the adapter commands above. `detach_key` and `status_bar` apply to the Codex Cloud tmux viewer. `remote_control` is retained for configuration compatibility; local conversation control now uses kiln's ACP host.

`sort` accepts `project`, `directory`, `last_active`, `age` and `harness`. Directories are grouped by name and sessions by their most recent ACP update. Branches are reread from the session directory on refresh.

Claude cloud listing is opt-in because it uses Claude's internal API. It reads an existing OAuth login and never accepts arbitrary API origins. Cloud reads are cached and refreshed asynchronously at most once per minute; provider failures retain the last successful list and show an error.

## Android

<img src="assets/android-list.png" width="270" alt="Android session list" /> <img src="assets/android-pi.png" width="270" alt="Android conversation" />

Install the APK from the repository's releases. The phone shows the same kiln-owned sessions and cloud tasks. It can read conversations, send prompts, stop turns and answer ACP permission requests. Cloud tasks use verified provider links.

```sh
kiln serve
# Expose localhost:7437 using Tailscale Serve or another authenticated HTTPS tunnel.
kiln pair https://your-machine.example --qr
kiln devices
kiln revoke <device-id>
```

Pairing invitations expire after five minutes and work once. The phone stores its bearer token privately. The server binds to localhost, rejects browser requests and checks pairing for each request and streamed update. Keep the tunnel origin HTTPS. Revocation disconnects the phone without affecting agent sessions.

The list supports search, ordering, activity/agent filters, collapsed children and hiding sessions on that phone. Hidden rows can be restored. Saved machine connections survive upgrades.

## Shared skills

Press `S` in a selected project to manage shared skills. `n` creates a skill and opens `SKILL.md` in `$EDITOR`; `Enter` edits it. Conflicting content is backed up before repair. Kiln does not overwrite unowned same-name skills.

```sh
kiln skills list
kiln skills share <name>
kiln skills sync
```

The bundled `kiln-config` and `kiln-skills` helpers are synced into the shared store before the terminal starts.

## Verification

```sh
bunx biome ci .
bunx tsc --noEmit -p .
bun test
bun scripts/changelog.ts --check
python3 .sift/gate.py --base origin/main
python3 .sift/agents.py check
bun scripts/list-tui-e2e.ts
bun scripts/perf.ts
bun scripts/acp-tui-e2e.ts
bun scripts/acp-host-e2e.ts
```

The PTY test uses [Tuistory](https://github.com/remorses/tuistory) against OpenTUI, with isolated fixtures and screenshot evidence. ACP protocol tests launch a real stdio fixture and verify working, input, approval and completion transitions.

After visible changes, regenerate and inspect terminal and dedicated-emulator screenshots:

```sh
bun scripts/screenshots.tsx 2>/dev/null
ANDROID_HOME=/opt/android-sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk python3 scripts/android-screenshots.py
ANDROID_HOME=/opt/android-sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk android/gradlew -p android checkKotlinFormat testDebugUnitTest lintDebug assembleDebug
```

Google Play preparation and signing instructions are in [docs/play-store/submission.md](docs/play-store/submission.md).
