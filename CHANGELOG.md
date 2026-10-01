# Changelog

What changed in each release, in the terms someone using kiln would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The entries are prose rather than bare
Added/Fixed lists. Each version's entry is also its GitHub release notes, and older entries are kept
verbatim.

## [Unreleased]

- **Saved sessions open native terminals.** Claude and Codex sessions created before 0.7.0 resume their exact provider identity instead of reopening kiln's chat view. Kiln keeps a private recovery copy before releasing the old ACP adapter.

## [0.7.0] - 2026-10-01

- **Desktop sessions use native Claude and Codex TUIs.** Enter attaches or focuses the provider terminal. Kiln observes provider status; existing ACP conversations and Pi keep their shared controls.

- **One command pairs the phone.** `kiln serve` configures Tailscale Serve and prints a pairing QR without replacing another service. Use `--origin` with another HTTPS tunnel or `--local` for localhost only.

- **Phone sessions open provider apps.** Verified Claude and ChatGPT links open the installed app or browser. The phone no longer maintains a separate conversation feed.

## [0.6.0] - 2026-10-01

- **The kiln icon includes a terminal prompt.** A keystone arch surrounds the prompt in the shared README and Android launcher mark, keeping the oxide and ember colours.

- **Large session lists respond faster.** Parent and child relationships are indexed once per snapshot. Process lookup and Pi bridge directory scans no longer block terminal input while they wait.

- **Return from sessions without the detach flash.** Kiln suppresses tmux's exit message, batches attachment settings and reports attachment failures inside the list.

- **ACP sessions replace native discovery.** Kiln owns local Claude, Codex and Pi sessions through ACP. Terminal and phone clients share conversation, progress, prompt and approval controls. External native sessions are no longer listed. Old default agent commands migrate automatically; custom commands must launch ACP adapters. Update the Android app alongside kiln.

- **Input requests are visible.** Directory headings use orange, input requests use yellow, ready titles use muted green, and working titles are subdued. Desktop notifications identify input requests and completed turns.

## [0.5.0] - 2026-09-30

- **Android uses a compact session list.** Two-line rows show agent logos, activity, project and relative age. Search and named filters sit in the toolbar; pairing, machine management and Pi conversations use the same light and dark themes.

- **Hide sessions on your phone.** Swipe left to hide a session and its subagents, undo the swipe or restore them from Hidden. Hidden sessions are saved per machine without stopping or archiving anything on the provider.

- **Older cloud tasks move to History.** Live shows local sessions, working or waiting cloud tasks and cloud tasks updated within 24 hours.

- **The Android launcher mark fits circular masks.** More foreground padding keeps the kiln mark inside the icon.

## [0.4.0] - 2026-09-30

- **Prepare releases through a PR.** The release helper updates desktop and Android versions together. Its separate tag action requires the merged main commit.

- **Control Pi sessions from a paired phone.** Install the bundled extension with kiln pi install and restart Pi. Android can read recent text, send a prompt and stop a turn. Live titles and activity come from the same bridge. One phone writes at a time; extension dialogs stay in the local terminal.

- **Skill backups retain relative link targets.** Repair keeps links to external instructions and supporting files readable after moving a conflicting directory, while internal relative links remain relative.

- **Releases include a signed Android app.** Each tag builds, checks and attaches kiln-android.apk using a persistent signing key, so release installations can update without losing their paired machines.

- **Open the selected local Codex thread from Android.** Connected daemon relay metadata supplies the host identity for ChatGPT's thread route. The client validates the thread and host query; unavailable metadata keeps the manual handoff and reports read failures without exposing provider responses.

- **Match the Android list to the compact desktop view.** Task titles use the orange accent, with status and elapsed update times beneath them. Harness and branch stay together in details on both surfaces. Android keeps Pi tasks visible for details and uses the shared kiln launcher mark.

- **Count Codex threads rather than terminal clients.** Confirmed thread IDs deduplicate attached terminals; unidentified clients no longer become duplicate PID tasks. Provider child threads nest beneath their parents on desktop and phone. README screenshots now come from seeded terminal and Android UI fixtures.

## [0.3.1] - 2026-09-30

- **Show compact task rows with live elapsed updates.** Directory headings group task titles, status and time since their last update. The clock advances even while discovery is slow. Unassigned Codex launch screens and exited Claude processes are omitted.

- **Repair shared skills without losing clashing files.** The skills view colours shared, missing and conflicting links. `f` backs up conflicts before linking the shared skill. Bundled `kiln-skills` and `kiln-config` helpers stay in sync with the installed version; edited instructions are backed up and same-name user skills are preserved.

- **Show provider session titles.** Codex terminals retain their assigned title even when absent from the daemon's loaded list. Claude transcript titles and explicitly selected Pi session names follow renames without inventing activity.
- **Desktop notifications when agent turns finish.** kiln uses notify-send when an observed
  working turn reaches idle, including while attached to tmux. Approval pauses and quiet output
  do not trigger alerts. Set `notifications = false` to disable them.

## [0.3.0] - 2026-09-30

- **Group sessions by directory or task, with recent updates first.** Titles and update times distinguish sessions. Unopenable roots are hidden and children start collapsed. Android uses compact rows, a black OLED background and muted oxide colours.

- **Avoid duplicate background rows for resumed Codex threads.** Read the explicit thread ID from a resumed terminal even when the daemon owns its thread lock. The terminal receives its own daemon status and directory, and the same thread is no longer also listed as background.

- **List sessions on Android.** Pair the native client with a localhost kiln server exposed through Tailscale. It streams directories, branches and activity, filters and sorts sessions, and opens verified Claude and cloud links. Local Codex rows explain how to select the thread in ChatGPT. Each phone has a revocable credential; pairing codes expire and work once.

- **Cloud rows carry verified phone links.** Codex task URLs are retained from the CLI and Claude
  sessions use their verified claude.ai route. Unexpected URLs and malformed pages report a fault
  without leaking response content. Codex pagination deduplicates tasks while retaining the last
  successful list when a refresh fails.

## [0.2.0] - 2026-09-30

- **Local directory and branch follow the session.** Claude uses its live process working directory
  and Codex uses the matched daemon thread’s directory. Branches are read again on each refresh,
  including when a session moves to another worktree.

- **Show last activity and choose the list order.** Sessions default to most recently active first.
  Set `sort` or press `o` to cycle age, harness, directory and project order while keeping children
  beneath their parent. Unknown activity timestamps are labelled and sort last.

- **List Claude cloud sessions through its existing login.** `claude_cloud = true` opts into the
  internal API used by Claude Code's cloud picker. Enter opens the session on claude.ai; archived
  and local bridge sessions are left out. Refreshes run in the background, and long lists scroll
  with the selection. The API may change between Claude Code versions.

- **Manage skills in shared directories.** `S` opens user and project skills in `.agents/skills`.
  Create, edit or copy a skill, then share it through Claude and Pi compatibility links. Codex reads
  the shared directory directly. Name clashes are reported before linking; unlinking keeps the files.

- **Release binaries run on both target architectures before publication.** CI exercises Linux x64
  and arm64 executables, including tmux and native UI loading, then builds and installs the binary
  AUR package in Arch without Bun. Releases wait for these checks.

## [0.1.2] - 2026-09-30

- **Archive Codex background threads with x.** The confirmation names the archive action; history
  is kept and archived threads stay hidden. Other sessions retain their close action, and
  unsupported actions explain why before confirmation.

## [0.1.1] - 2026-09-30

- **Sessions that cannot be opened appear grey.** Selecting one shows its PID, terminal and originating
  agent or parent process when available. Children of a known kiln session appear directly below it.

- **Session status avoids false idle readings.** Codex sessions with a local thread ID no longer
  borrow another thread's status, and ambiguous directory matches remain unknown. Quiet terminal
  output no longer counts as evidence that a session is idle.

- **Try a local Pi remote control bridge.** An opt-in extension exposes state, transcript events,
  prompts and abort through an owner-only Unix socket. It needs no fork of Pi and is not enabled
  automatically. Remote dialog replies are not supported.

- **Codex Cloud tasks appear in the list.** Read-only cloud rows show their title and activity.
  Enter opens status and diff in tmux; they cannot be closed from kiln. Cloud refreshes at most
  once a minute without delaying local sessions, and `cloud = false` hides them.

- **Install kiln without Bun.** Releases include Linux x64 and arm64 executables, and
  `kiln-agents-bin` installs them from the AUR. The tmux configuration and native UI library
  are embedded.

## [0.1.0] - 2026-09-30

- **First release.** One list of every interactive Claude, Codex and Pi session on the machine, with
  vim keys and no tmux prefix. Enter attaches to sessions kiln started, or focuses the kitty window an
  agent runs in. `n` starts a new session in a directory picked with fzf and ranked by zoxide, and
  `Ctrl+Q` comes back to the list while the agent keeps working.
- **Background sessions are listed and open like any other.** A Claude session started with
  `claude --bg` or a Codex thread on its daemon shows as `bg`; Enter attaches to it inside kiln's tmux.
- **New Claude and Codex sessions have remote control on**, so they can be picked up from the Claude
  and ChatGPT apps. `remote_control = false` turns it off.
