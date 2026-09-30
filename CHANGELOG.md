# Changelog

What changed in each release, in the terms someone using kiln would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The entries are prose rather than bare
Added/Fixed lists. Each version's entry is also its GitHub release notes, and older entries are kept
verbatim.

## [Unreleased]

- **Codex Cloud tasks appear in the list.** Read-only cloud rows show their title and activity.
  Enter opens status and diff in tmux; they cannot be closed from kiln. Cloud refreshes at most
  once a minute without delaying local sessions, and `cloud = false` hides them.

## [0.1.0] - 2026-09-30

- **First release.** One list of every interactive Claude, Codex and Pi session on the machine, with
  vim keys and no tmux prefix. Enter attaches to sessions kiln started, or focuses the kitty window an
  agent runs in. `n` starts a new session in a directory picked with fzf and ranked by zoxide, and
  `Ctrl+Q` comes back to the list while the agent keeps working.
- **Background sessions are listed and open like any other.** A Claude session started with
  `claude --bg` or a Codex thread on its daemon shows as `bg`; Enter attaches to it inside kiln's tmux.
- **New Claude and Codex sessions have remote control on**, so they can be picked up from the Claude
  and ChatGPT apps. `remote_control = false` turns it off.
