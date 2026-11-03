<p align="center"><img src="assets/icon.png" width="96" alt="kiln" /></p>

# kiln

kiln opens native Claude, Codex, OpenCode and Pi terminal sessions and pairs with an Android client. Kiln also lists read-only Codex Cloud tasks and optional Claude cloud sessions.

Claude and Codex keep their own TUIs for messages, prompts and approvals. Kiln discovers native sessions and reads provider status updates without starting a second agent. Terminal output never establishes activity.

<img src="assets/list.png" alt="kiln sessions grouped by directory" />

## Install

```sh
paru -S kiln-agents-bin # standalone binary
# or: paru -S kiln-agents # Bun source package
```

From source, install [Bun](https://bun.sh), fzf and tmux, then:

```sh
bun install --frozen-lockfile
bun start
```

Install Claude Code, Codex CLI, OpenCode or Pi, and sign in through each provider's own CLI. Native commands and their arguments can be overridden in settings.

## Set up with your agent

kiln ships three skills: `kiln-agents` lets running agents message each other, `kiln-config` changes its TOML settings and native agent commands, and `kiln-skills` inspects and repairs shared skills. kiln syncs them into the shared skill store each time it starts. To install them before running kiln, for any agent that reads [Agent Skills](https://agentskills.io):

```sh
npx skills add cjber/kiln
```

In Claude Code you can use the plugin instead: `/plugin marketplace add cjber/kiln`, then `/plugin install kiln@kiln`. The skills live in [`skills/`](skills).

## Agents talking to each other

Any running session kiln lists can message another one:

```sh
kiln msg list                       # names, status, directory and how a message would arrive
kiln msg send codex:019a "Run the API tests on cb/login and tell me what fails"
kiln msg send --all -               # every other session, text from stdin
kiln msg inbox                      # messages kiln could not type into this session
kiln msg whoami
```

Messages are kept in `$XDG_STATE_HOME/kiln/mailbox.sqlite` for seven days. Kiln puts a message in front of its recipient as a new prompt, starting with the sender's name and the command to reply:

| Recipient | Delivery |
| --- | --- |
| OpenCode on its background service | queued in OpenCode right away |
| Pi started by kiln | queued as a follow-up right away |
| Codex on its shared daemon | a new turn once it is idle |
| Claude started by kiln | pasted into its terminal once it is idle and nobody has it open |

Anything else, and a message whose recipient never becomes idle, waits for `kiln msg inbox`. Waiting messages are delivered by the next `kiln msg send`, and on each refresh of the list or the phone server while one runs. Kiln never types into a session that is working, asking a question, or open in a terminal, where it could join a prompt you are writing. A sender can send at most 20 messages to one recipient in ten minutes. The `kiln-agents` skill teaches agents to use these commands.

## Terminal

| Key | Action |
| --- | --- |
| `j` `k`, arrows | Select a session |
| `Enter` | Open a session or cloud task |
| `n` | Choose an agent, then a directory through fzf |
| `/` | Filter titles, directories, agent names and status |
| `Tab` | Expand children |
| `o` | Cycle list order |
| `x` | Close a kiln-owned session after confirmation |
| `s` | Edit settings |
| `S` | Open shared skills |
| `r` | Refresh |
| `q` | Quit the list |

Directory headings are orange. Sessions needing permission are yellow, ready sessions are muted green, and working sessions use subdued text. The header counts input requests even when children are collapsed. Open a yellow session to answer in the provider TUI.

New sessions run inside kiln's private tmux server. `Ctrl+Q` returns to the list and leaves the session running. Existing Kitty sessions can be focused; loaded Codex daemon threads and Claude background sessions can be attached through their native commands. Sessions in other terminals show their location.

Sessions running in a terminal survive a restart of the computer. They stay in the list as `stopped`: `Enter` resumes the conversation in a new kiln session in the same directory, and `x` forgets the row and leaves the conversation with its provider. A session closed before the restart is not kept, and neither is one without a provider session id, such as a Pi started outside kiln.

Finished Claude background jobs stay in the list, marked `completed` in green or `stopped` in grey. `Enter` attaches with `claude attach`. `x` deletes a background job, running or finished, with `claude rm`, which also removes its worktree and refuses while that worktree has unpushed commits.

Kiln observes each provider's own status and never guesses from terminal output, so unknown activity stays unknown. Kiln starts Pi with a small extension that reports the session's title and whether it is working, waiting on a prompt or ready. A Pi started outside kiln is listed with `unknown` status.

OpenCode status comes from its background service. Kiln starts each OpenCode session with its own `--session` id, which ties the terminal to its conversation. An OpenCode started outside kiln is listed with `unknown` status unless it was given `--session`, and a conversation still running with no known terminal is listed so `Enter` can attach to it. A session you switch to inside OpenCode, such as with `/new`, appears as its own row while it runs. Closing a session in kiln interrupts and archives it in OpenCode, and kiln never starts the service to read status.

Desktop notifications identify the session when it needs input or finishes an observed turn. Enable `notify-send` and a desktop notification service to receive them.

Cloud tasks retain their provider status and verified HTTPS links. Claude cloud tasks open in a browser. Codex Cloud tasks open a read-only CLI status/diff viewer. Cloud tasks cannot be closed or prompted from kiln.

## Settings

Press `s` to edit `~/.config/kiln/config.toml` (`$XDG_CONFIG_HOME` when set). Unknown keys are errors. Each agent command launches that agent's native TUI.

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
claude = ["claude"]
codex = ["codex"]
opencode = ["opencode"]
pi = ["pi"]
```

Set an agent command to `[]` to hide it from the new-session picker. `detach_key` and `status_bar` apply to native sessions and the Codex Cloud viewer. `remote_control` enables Claude Remote Control per new session and starts Codex Remote Control on its shared daemon.

`sort` accepts `project`, `directory`, `last_active`, `age` and `harness`. Directories are grouped by name and sessions by their most recent provider update. Branches are reread from the session directory on refresh.

Claude cloud listing is opt-in because it uses Claude's internal API. It reads an existing OAuth login and never accepts arbitrary API origins. Cloud reads are cached and refreshed asynchronously at most once per minute; provider failures retain the last successful list and show an error.

## Android

<img src="assets/android-list.png" width="270" alt="Android session list" /> <img src="assets/android-handoff.png" width="270" alt="Android provider handoff" />

Install the APK from the repository's releases. To get updates on the phone, add `https://github.com/cjber/kiln` to [Obtainium](https://obtainium.imranr.dev); each release carries the same signing key. The phone lists native sessions and cloud tasks. Opening a linked session uses the provider's installed app or browser through verified HTTPS links. Claude Remote Control and connected Codex Remote Control provide direct session links. OpenCode sessions open in OpenCode's own web UI on your PC, reached over Tailscale. Sessions without mobile access explain how to open them on the PC.

```sh
kiln setup # installs a user service that survives reboots, configures Tailscale Serve and prints a pairing QR
# In the foreground instead, until the terminal closes:
kiln serve
# With your own HTTPS tunnel instead:
kiln serve --origin https://your-machine.example
# Localhost only, without tunnel setup or a printed invitation:
kiln serve --local
# Generate another invitation while the server is running (the origin defaults to your Tailscale HTTPS name):
kiln pair
kiln pair https://your-machine.example
kiln devices
kiln revoke <device-id>
```

Sign in to Tailscale before running `kiln serve`. An existing HTTPS root serving another application is preserved; use `--origin` with a separate tunnel in that case. Keep the server running while using the phone.

`kiln setup` writes `~/.config/systemd/user/kiln-serve.service`, enables it and reports each change; running it again changes nothing. A unit that is a symlink, for example into a dotfiles repository, is left alone and reported. The service listens on localhost only and never prints a pairing code to the journal. It records the current `PATH` so the agents' CLIs are found; run `kiln setup` again after moving them. To start before login, run `loginctl enable-linger`. `--port` and `--origin` work as they do for `kiln serve`.

For OpenCode, `kiln setup` also pins OpenCode's background service to port 4096 and serves its web UI at `https://<your Tailscale name>:4096`, reachable only on your tailnet. "Open in OpenCode" then goes through kiln's own address, which signs the phone's browser in to OpenCode and opens the session; there is nothing to pair. Each link works once, for 15 minutes. Changing the port restarts OpenCode's service, so setup skips that step while a turn is running and asks you to run it again. Sessions in a terminal started with `--standalone` or `--server` belong to their own server and still open on the PC.

On the phone, finished Claude background jobs show as Completed or Stopped and move to History after a day.

Pairing invitations expire after five minutes and work once. The phone stores its bearer token privately. The server binds to localhost, rejects browser requests and checks pairing for each request and streamed update. Keep the tunnel origin HTTPS. Revocation disconnects the phone without affecting agent sessions.

The list supports search, ordering, activity/agent filters, collapsed children and hiding sessions on that phone. Hidden rows can be restored. Saved machine connections survive upgrades.

## Shared skills

Press `S` in a selected project to manage shared skills. `n` creates a skill and opens `SKILL.md` in `$EDITOR`; `Enter` edits it. Conflicting content is backed up before repair. Kiln does not overwrite unowned same-name skills.

```sh
kiln skills list
kiln skills share <name>
kiln skills sync
```

The `kiln-agents`, `kiln-config` and `kiln-skills` helpers in [`skills/`](skills) are synced into the shared store before the terminal starts.

## Verification

```sh
bunx biome ci .
bunx tsc --noEmit -p .
bun test
bun scripts/changelog.ts --check
python3 .sloppatrol/gate.py --base origin/main
python3 .sloppatrol/agents.py check
bun scripts/list-tui-e2e.ts
bun scripts/perf.ts
bun scripts/native-tui-e2e.ts
```

The PTY tests use [Tuistory](https://github.com/remorses/tuistory) against OpenTUI, with isolated fixtures and screenshot evidence. Native handoff tests exercise direct terminal input, detach, reattach and resizing.

After visible changes, regenerate and inspect terminal and dedicated-emulator screenshots:

```sh
bun scripts/screenshots.tsx 2>/dev/null
ANDROID_HOME=/opt/android-sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk python3 scripts/android-screenshots.py
ANDROID_HOME=/opt/android-sdk JAVA_HOME=/usr/lib/jvm/java-21-openjdk android/gradlew -p android checkKotlinFormat testDebugUnitTest lintDebug assembleDebug
```
