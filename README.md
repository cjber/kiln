<div align="center">
  <img src="assets/icon.png" alt="" width="96" />
  <h1>kiln</h1>

  **Every coding agent on this machine, in one list.**

  [![CI](https://img.shields.io/github/actions/workflow/status/cjber/kiln/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/cjber/kiln/actions/workflows/ci.yml)
  [![AUR](https://img.shields.io/aur/version/kiln-agents?style=flat-square&color=6366F1)](https://aur.archlinux.org/packages/kiln-agents)
  [![License](https://img.shields.io/badge/license-MIT-475569?style=flat-square)](LICENSE)
</div>

<img src="assets/list.png" alt="kiln listing Claude, Codex and Pi sessions with their status, directory and branch" />

kiln lists every interactive Claude Code, Codex and Pi session on the machine, wherever you started
it, and takes you to the one you pick. The keys are vim's, there is no tmux prefix to learn, and one
key brings you back to the list while the agent keeps working.

The session list and shared skills view have no chat pane or daemon of their own.

## Install

On Arch, from the AUR:

```sh
paru -S kiln-agents     # source package, requires Bun
paru -S kiln-agents-bin # compiled binary, no Bun dependency
```

From source, with [Bun](https://bun.sh), [tmux](https://github.com/tmux/tmux) and
[fzf](https://github.com/junegunn/fzf) installed:

```sh
git clone https://github.com/cjber/kiln.git
cd kiln
bun install
ln -sf "$PWD/bin/kiln" ~/.local/bin/kiln
```

[zoxide](https://github.com/ajeetdsouza/zoxide) is optional and ranks the directories offered for a
new session. kiln runs on Linux: it reads `/proc` to find agents and their working directories.

## Keys

The list is normal mode. Filtering is the only mode that takes text, and Esc leaves it.

| Key | Action |
| --- | --- |
| `j` `k`, `g` `G`, `Ctrl+D` `Ctrl+U` | Move |
| `Enter` | Open the selected session |
| `n` | New session: pick an agent with `h` `l`, then a directory in fzf |
| `x` | Close the selected session, or archive a Codex background thread (`y` confirms) |
| `/` | Filter by agent, directory, branch or status |
| `s` | Edit settings in `$EDITOR`; they reload when you close it |
| `S` | Manage shared skills for this user or the selected session's project |
| `r` | Refresh now (the list refreshes every two seconds anyway) |
| `q` | Quit |

<img src="assets/new.png" alt="Picking an agent for a new session" />

The directory picker is fzf over zoxide's ranking. Type any path that isn't in the list and Enter
opens it anyway.

## Where Enter goes

- **Started by kiln:** the agent runs in kiln's own tmux server (`tmux -L kiln`, set up by
  [`tmux.conf`](tmux.conf)). It has no prefix and one binding: `Ctrl+Q` goes back to the list and
  leaves the agent running. Esc stays with the agent, where it interrupts a turn. A one-line bar at
  the bottom names the session and counts the rest, e.g. `2 working · 1 waiting · 3 idle`.
- **In a kitty window:** kiln focuses that window. This needs `allow_remote_control yes` and
  `listen_on unix:@kitty` in `kitty.conf`.
- **In the background** (`bg`): a Claude session started with `claude --bg` or from agent view, or
  a Codex thread on its shared daemon with no terminal open (`codex agents`). kiln opens it with
  `claude attach` or `codex resume --remote` inside its own tmux, so `Ctrl+Q` works the same.
- **Codex Cloud** (`cloud`): read-only task rows. Enter shows `codex cloud status` and
  `codex cloud diff` in tmux. Press Enter to return, or `Ctrl+Q` to detach. Tasks cannot be
  closed here. The age is time since the last update, and the directory column shows the task
  title. Pending tasks are working, ready or failed tasks are waiting, and applied tasks are idle.
  Tasks refresh at most once a minute; a failed refresh keeps the last rows and shows a notice.
  Claude cloud discovery is unavailable in the CLI.
- **Anywhere else** (another multiplexer, an SSH session): listed, but there is nothing to attach to.

Sessions outside kiln and kitty appear grey because kiln cannot open them. Select one to see its
PID, terminal and originating agent or parent process when available. When that agent is a known
kiln session, the child appears beneath it with a small arrow.

<img src="assets/unavailable.png" alt="A grey child session nested beneath its Codex parent, with its source shown below" />

`x` archives Codex background threads through their daemon, keeping history and hiding archived
threads from the list, including threads archived elsewhere. Codex may also archive descendant
threads. This action does not promise to stop active work. Use `codex unarchive <id>` to restore history.
For Claude background jobs, `x` stops the job and keeps its conversation. For kiln, kitty and other
terminal sessions of any agent, it closes the tmux session or terminates the agent process. Unsupported
actions explain why immediately, without asking for confirmation. Cloud tasks remain read-only.

<img src="assets/archive.png" alt="Codex background thread selected with confirmation to archive and keep its history" />

Local directories refresh with the list: Claude and Pi use their live process working directory,
and a matched Codex daemon thread supplies its current session directory. The branch is read from
that directory on every refresh, including linked worktrees. A temporary `cd` inside a tool command
does not change the session directory. Cloud rows show task titles rather than a local checkout.

## Status

`working` is mid-turn, `waiting` has stopped to ask you something, and `idle` is ready for your next
message. Claude reports its own status through `claude agents --json`, and Codex through its daemon.
Recent pane output counts as `working` when no agent status is available. Silence shows `·`, since
a quiet tool may still be running. Codex threads are matched by their local thread ID when available;
ambiguous directory matches show `·` rather than borrowing another session's status. Unmatched daemon
threads stay available as `bg` rows. Remote Control
servers run by a systemd service and Codex daemon sub-threads are left out.

## Settings

`s` opens `~/.config/kiln/config.toml` (under `$XDG_CONFIG_HOME` if set), creating it with every
option at its default. An unknown key is an error, never silently ignored.

```toml
detach_key = "C-q"   # back to the list, in tmux key syntax
status_bar = true    # the one-line bar inside an attached session
zoxide = true        # rank new-session directories with zoxide
cloud = true        # list read-only Codex Cloud tasks
claude_cloud = false # opt into Claude's internal cloud-listing API; requires cloud = true
remote_control = true  # new Claude and Codex sessions can be driven from their phone apps

[agents]             # the command each agent starts with; [] hides it from `n`
claude = ["claude"]
codex = ["codex"]
pi = ["pi"]
```

With `remote_control` on, kiln starts Claude with `--remote-control` and makes sure Codex's daemon
is running with remote control (`codex remote-control start`) before starting Codex on it. Pi has no
remote control, so it is unaffected.

Codex only uses its shared daemon when the command has no `-c`, `--enable`, `--disable` or `--search`
flag. Put those in `~/.codex/config.toml` instead (`web_search = "live"` for search), or the session
gets neither remote control nor a real status.

An opt-in [Pi remote control prototype](prototypes/README.md) exposes an existing interactive
session through a private local socket. It is not installed or enabled by kiln.

## Claude cloud listing

Set `claude_cloud = true` to include Claude cloud sessions alongside Codex tasks. This uses the
internal listing API used by Claude Code 2.1.285's cloud picker, not a public Claude Code API.
It reads the existing Claude login from `~/.claude/.credentials.json`, or `$CLAUDE_CONFIG_DIR`,
and sends it only to `api.anthropic.com`. API-key logins do not provide these sessions. Expired
credentials need a running Claude CLI to refresh them, or `claude auth login`.

Bridge sessions already running locally and archived sessions are excluded. Listing runs in the
background at most once a minute with a ten-second deadline. Failures retain the last rows and
show a notice. Unknown worker states display `·`. Enter opens the selected session on claude.ai
using `xdg-open`; it does not teleport or change a local branch. `x` cannot close cloud sessions.
`cloud = false` hides both providers. Long lists scroll with the selected row.

## Shared skills

`S` opens the skills view. `u` selects `~/.agents/skills`, which applies to this user across
projects on this machine. `p` selects `.agents/skills` at the selected session's git root, or its
working directory when it is outside git. These are the canonical directories for all three agents.

`n` creates a skill and opens `SKILL.md` in `$EDITOR`. `Enter` edits an existing skill. `i` copies
an existing skill directory, including supporting files, into the selected scope. `l` shares it:
Codex reads the shared directory directly; Claude and Pi use relative compatibility links in their
own discovery directories. Existing entries that point somewhere else are marked `conflict` and
are never replaced. `x`, then `y`, removes only those Claude and Pi links. It keeps the shared
files and Codex access. `q` returns to sessions.

Project skills stay in their project; importing them into the user scope is an explicit action.
kiln does not migrate existing harness folders automatically. A `link` in the source column means
the shared entry still points to files elsewhere. Plugin, synced and built-in skills remain managed
by their harness. Reload skills or restart existing sessions after changing the links.

<img src="assets/skills.png" alt="Shared project skills and their Claude and Pi compatibility links" />

## Development

CI builds and runs the standalone binary on native Linux x64 and arm64 runners. It checks the
TUI, embedded tmux configuration, attach/detach and the status bar's executable path. An Arch
container builds and installs the rendered binary PKGBUILD without Bun and checks its metadata,
checksums and TUI. The release job runs the same checks before publishing either executable.

```sh
bun install --frozen-lockfile
bunx biome ci .                           # format and lint; `bunx biome check --write .` fixes
bunx tsc --noEmit -p .
bun test
bun scripts/changelog.ts --check
python3 .sift/gate.py --base origin/main   # project rules (see .agents/skills/sift-project)
python3 .sift/agents.py check
bun scripts/screenshots.tsx 2>/dev/null   # re-render assets/*.png from the real UI
```

Build standalone Linux x64 and arm64 executables with:

```sh
bun install --frozen-lockfile --os linux --cpu "*"
bun scripts/build.ts
```

The files in `dist/` include OpenTUI's native library and the tmux configuration. They still
need tmux and fzf. Release assets can also be installed directly as `kiln` on your PATH.

A release is `bun scripts/release.ts patch` (or `minor`, `major`) on `main`. It turns the
`[Unreleased]` entry in [CHANGELOG.md](CHANGELOG.md) into the new version's, then makes a signed
commit and tag. Pushing the tag publishes the GitHub release, with that entry as its notes, and the
source and binary AUR packages.

## Changelog

What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT. kiln started as a fork of [agent-deck](https://github.com/asheshgoplani/agent-deck) by Ashesh
Goplani and has since been rewritten down to this list; the original copyright notice is kept in
[LICENSE](LICENSE).

Made by Cillian Berragan · [GitHub](https://github.com/cjber)
