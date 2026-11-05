# Changelog

What changed in each release, in the terms someone using kiln would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The entries are prose rather than bare
Added/Fixed lists. Each version's entry is also its GitHub release notes, and older entries are kept
verbatim.

## [Unreleased]

Every pull request a session opened, not only the one for its branch. Kiln reads the pull requests a
Claude, Codex or Pi session created with `gh pr create` from its transcript. The terminal list shows the
most urgent one with a count of the rest, such as `#212+3`, and each one's checks in the details line.
The dashboard lists them all, and the phone shows them all in a session's details, with a link to each
open one.

Kiln can tell an agent about its pull requests. With `pr_messages = true` in `config.toml`, `kiln serve`
sends a session's agent a message when its checks fail, naming the failed checks, when it has merge
conflicts, when it gets a review, and when it merges. Each one is sent once, and waits until the agent
is idle.

The phone drops its History tab. Cloud tasks and finished background jobs leave the list once they have
been quiet for a day.

## [0.20.0] - 2026-11-05

Every agent's pull request in one place. The phone has a progress tab that groups the sessions on your
computer by stage, from failing checks to merged, with each pull request's check counts and merge queue
label, and a link to the pull request in the session details. The terminal list shows each branch's
pull request number in a `pr` column coloured by stage, and its checks in the details line.

`kiln dashboard` lists every open pull request you authored, in any repository that is not archived,
with its checks and merge queue label, including ones no running session works on.

## [0.19.0] - 2026-11-04

The phone can answer an agent that stops to ask you something. When a session in kiln's tmux shows a
numbered menu, such as Claude's plan approval, a permission prompt, a question Claude asks, or a Codex
command approval, the session view shows the question with its answers as buttons. Answers that take
text, such as "Tell Claude what to change" or "Type something.", send what is in the reply box.

The reply box has a + button to attach images and other files of up to 20 MB. Kiln keeps them on the
computer for seven days, and the message tells the agent where they are.

Agent replies in the session view render as Markdown: headings, lists, bold and italic text, inline
code, code blocks, quotes, tables and links.

The phone's session list opens in the order set by `sort` in `config.toml`, as the terminal list does,
and orders sessions the same way. The project order now gathers a worktree under its repository,
where it used to show as a group of its own.

Command output in the session view no longer shows terminal colour codes as raw text.

## [0.18.1] - 2026-11-04

Codex sessions opened in the app show what each command printed. Before, a command run through
Codex's code mode showed its raw JSON result, and a failed command now shows as an error.

The session view on the phone is easier to scan. Each of your messages starts a new turn under an orange
"you" label with its time, tool names are coloured by kind (edits purple, lookups grey, everything else
teal), each result shows two dim lines, and the reply box is a filled field with a send button that
turns orange once there is something to send.

## [0.18.0] - 2026-11-04

- **Start sessions and send prompts from the phone.** With `write = true` under `[phone]` in `config.toml`, the Android app gains a New session button: pick an agent, one of the directories kiln already knows (your listed sessions and zoxide's list) and a first prompt, and the session starts on your computer with the provider's remote control on. The app then opens its details, where Claude and Codex sessions open in the provider's own app. Each running session's details also get a Send box that delivers a prompt the way `kiln msg send` does and says whether it was delivered or why it waits. Writes are off by default, `kiln pair` says which mode it pairs for, and `kiln devices` lists the sessions each phone started.
- **Phone notifications clear once you have read them.** Opening the session in the app clears its notification, and so does reading it on the computer: attaching to its kiln terminal or typing in it after the alert, or the session starting a new turn. With "Notify when the app is closed" on, the computer sends the clear as a push, so it reaches the phone with the app closed too.
- **Sessions open in the phone app.** On a computer with `write = true` under `[phone]`, tapping a Claude, Codex, OpenCode or Pi session on that computer shows its conversation in kiln, with no provider app or web page needed: your prompts, the agent's replies, and each tool call with how it ended, updating live. A reply typed there is sent the way the Send box sends it, and one sent while the agent is working waits for the turn to end. Stop ends the turn in progress for a Claude, Codex or Pi session kiln started. Without writes, a tap opens the session's details as before, and the provider's own app stays in the ⋮ menu.
- **A session with a background shell or subagent still running is working, not ready.** A Claude session whose turn had ended while a background shell or agent it started kept running was listed as ready and sent a "Turn finished" notification. Kiln now takes Claude's status as Claude's own agent view shows it, and lists that session as working. A Codex or OpenCode session whose subagent is still working also stays working, in the list, on the phone and in notifications, until its subagents finish.

## [0.17.0] - 2026-11-04

- **The phone can notify you with the app closed.** Turn on "Notify when the app is closed" in the app's Machines screen and pick ntfy, or another UnifiedPush app, to deliver it. Every paired machine then sends an encrypted push when a session needs input or finishes a turn, and tapping it opens that session. ntfy relays only ciphertext, and a public or self-hosted ntfy server both work. While a phone has this on, `kiln serve` checks sessions every ten seconds instead of once a minute, so a short turn is not missed. The live connection still notifies while the app is open, and a change that arrives both ways shows once.
- **A pairing link replaces the invitation on the open app.** Opening a second pairing link while the app was running stacked another copy of the app over the first, with the old invitation still behind it. The link now fills the invitation in the one open app.

## [0.16.0] - 2026-11-04

- **Sessions group by git repository.** The default `project` order now groups a session under the repository it works in, so sessions in linked worktrees sit with the repository that owns them instead of in a group per worktree. A directory outside git is still its own group.
- **Time since latest activity is colour coded.** The updated column is green for the first minute, teal up to ten minutes, dim up to an hour and grey after that, so recently active sessions stand out.
- **The phone notifies you.** While a session on your computer works, the Android app keeps a quiet "Watching" notification and tells you when a session needs input or finishes a turn. Tapping one opens that session. Each machine has a "Notify me" switch, and the app asks for notification permission the first time a session starts working, never at launch.
- **`kiln msg inbox` no longer fails with `database is locked`.** Reading an inbox while other sessions send messages now waits for them instead of failing. Pairing and the saved-session records wait the same way.
- **The list fits narrow terminals.** The title line keeps the waiting count and the end of the filter you are typing, and the close prompt, agent picker and filter hints shorten instead of being cut off. A directory heading that scrolls off the top stays pinned above its rows.
- **Clearer list details.** With nothing selected the hints drop the row keys, and a kept filter offers `esc clear`. Emoji titles no longer push the status column out of line. Inside the harness order the most recent session comes first. A completed job says completed in its detail line, and a session that never reported activity shows when it started.
- **Phone app fixes.** A bad pairing invitation shows its error on the invitation field and no longer follows you to the session list. Last active reads "Unknown, started 12m ago" when there is no activity time, and the app says computer everywhere. The Copy session ID button no longer looks disabled, and the setup steps link and the "Nothing hidden" hint line up with their text.

## [0.15.1] - 2026-11-03

- **The dashboard counts a session once.** A session whose pull request has merged was counted both as running and as finished. It now counts only as finished.

## [0.15.0] - 2026-11-03

- **A live dashboard of every session.** `kiln dashboard` serves a page on 127.0.0.1 that shows each running session's progress: sessions running and finished, a bar per project split into Working, PR failing, PR checks running, PR green and Done, the checks of every open pull request, and a table of every session with its uncommitted files. It updates itself every few seconds without reloading, and reads pull requests from GitHub at most once a minute per branch, in the background.

## [0.14.1] - 2026-11-03

- **Only sessions kiln can open are listed.** A session running in a terminal kiln cannot reach, such as a plain terminal or another tmux server, no longer shows up as a row that only says to open it in its terminal. It still comes back as `stopped` after a restart, since that row resumes in kiln.

## [0.14.0] - 2026-11-03

- **Running agents can message each other.** `kiln msg list` shows every running session an agent can reach, `kiln msg send` messages one or all of them, and `kiln msg inbox` reads what could not be delivered. Kiln puts a message in front of an OpenCode, Pi, Codex or kiln-started Claude session as a new prompt that names the sender and how to reply, and waits until a session is idle before typing into it. The new `kiln-agents` skill teaches agents to use it.
- **Agents can install kiln's skills without running kiln.** `npx skills add cjber/kiln` and the Claude Code plugin (`/plugin marketplace add cjber/kiln`) now install `kiln-config` and `kiln-skills`, which moved to `skills/`. `kiln --help` and kiln.cjber.dev point agents to them, and the site serves an `llms.txt`.
- **A closed OpenCode session that is still running stays in the list.** Closing a session archives it in OpenCode, which hides it, so anything the service kept doing afterwards had no row left and spent without anyone seeing it or stopping it. A conversation the service is still working on is now listed whatever its archive state, so it can be watched, opened or interrupted.

## [0.13.4] - 2026-11-02

- **A Claude session waiting on a background command is idle.** Claude reports a session whose turn has ended while a shell it started keeps running as busy, so kiln listed it as working. Kiln now reads that session's own status record and lists it as idle until its next turn.
- **Claude cloud sessions show working and needs input.** Kiln matched Claude's cloud worker states against names Claude does not send, so a running cloud session showed no status and one asking for input was not flagged. It now reads `running`, `requires_action` and `idle`.
- **A crashed Claude background job stays listed.** A job that crashed disappeared from the list. It is now shown as stopped, and opening it attaches to read what happened.
- **Codex servers are not listed as sessions.** A Codex app server started with an option before its subcommand, such as the one the ChatGPT desktop app runs (`codex -c ... app-server`), was listed as a Codex session with no title or status. Kiln now skips option values when it reads the subcommand.

## [0.13.3] - 2026-11-02

- **OpenCode status costs almost nothing to read.** kiln asked OpenCode's background service for each session's state by starting `opencode api`, two calls per refresh plus two for every working session, about 0.15 s of CPU each. It now sends those requests straight to the service on this machine, so the list and the phone server no longer keep a core busy while OpenCode sessions run.

## [0.13.2] - 2026-11-02

- **OpenCode on the phone needs no pairing.** "Open in OpenCode" signs the phone's browser in through kiln's own address and lands on the session, so `kiln setup` no longer prints a second QR code and the sign-in no longer runs out after 30 days. Each link works once, for 15 minutes. The phone app needs this release too.

- **Sessions show the worktree they work in.** An agent started in one checkout and working in a worktree was listed under the checkout it started in, with that checkout's branch, so most rows said `main`. The list, the footer and the phone now show the checkout of the agent's latest file edit or `cd`, and its branch. Claude and OpenCode sessions are read this way; Codex already reported its own. Opening or resuming a session still starts it where it began.

## [0.13.1] - 2026-11-02

- **The phone server's address explains itself in a browser.** Opening it showed `{"error":"Device is not paired"}`, which read as a lost pairing. It now says it is the kiln phone server, that sessions are in the phone app, and that `kiln pair` adds a phone.

## [0.13.0] - 2026-11-02

- **OpenCode sessions open on the phone.** `kiln setup` serves OpenCode's web UI on your tailnet and prints a QR code that signs the phone's browser in once. OpenCode rows then get an "Open in OpenCode" button that goes straight to the session. The Android app accepts these links only for the machine it paired with, so it needs this release too.

## [0.12.3] - 2026-11-02

- **The phone server rests while no phone is watching.** `kiln serve` looked for sessions every two seconds whether or not a phone was connected, starting the Claude, OpenCode and kitty command-line tools each time, which kept about one CPU core busy. With no phone connected it now looks once a minute, enough to remember running sessions across a restart, and goes back to every two seconds as soon as the app opens.

- **`kiln serve` keeps pairing codes out of the service log.** Run as a service, it prints where the phone server is and the `kiln pair` command for that address; the invitation and QR code appear only when it runs in a terminal.

- **The footer shows relative time.** The selected session's hint says "updated 2m" like the list, instead of a raw ISO timestamp.

## [0.12.2] - 2026-11-02

- **The phone app looks like the terminal list.** It is always dark, uses the terminal's colours and a monospace font, and shows each session as one line: the agent name in its colour, the title in its status colour (yellow needs input, green ready or completed) and the age in grey. Swiping to hide no longer leaves a green band behind every row.

- **A hidden session comes back when its status changes.** Hide a long job while it works and it returns to the list once it finishes, stops or needs input, along with its parent and helpers. Losing sight of it for a moment does not count as a change.

- **The phone says when Tailscale is off.** If no VPN is running, the list and the pairing screen say Tailscale is off and offer an Open Tailscale button, and the app reconnects as soon as it comes on. When Tailscale is on but the computer does not answer, it says to check that the computer is awake and `kiln serve` is running.

- **Pairing help names the right commands.** The pairing screen points to `kiln setup` for the first phone and `kiln pair` for another.

## [0.12.1] - 2026-11-02

- **Agent names keep their proper casing.** The list, status line, prompts and notifications say Claude, Codex, OpenCode and Pi.

- **`kiln pair` needs no origin on Tailscale.** With no argument it uses this machine's Tailscale HTTPS name, and the invitation always prints with its QR code.

- **Stopped OpenCode sessions leave the list.** A conversation with no terminal is listed only while the OpenCode service is still running it, so one whose last run failed no longer stays as "needs input" when there is nothing to open.

- **A long title keeps its helper count.** The `[+N]` count of nested sessions stays on the line, and only the title is shortened to fit.

- **`kiln setup` uses a phone server unit from your dotfiles.** When `kiln-serve.service` is a link to a unit kiln did not write, setup leaves it as it is and goes on to the tunnel and the pairing QR instead of stopping.

- **The terminal UI runs on OpenTUI 0.8.1.** Opening a session from the list hands the terminal over once the list has fully let go of it.

## [0.12.0] - 2026-11-01

- **OpenCode is a fourth agent.** `n` starts OpenCode, the list shows its titles and whether it is working, waiting or ready, helpers nest under their parent, and a session a restart stopped resumes in place. Closing a session interrupts and archives it, and a conversation still running with no terminal can be attached. It shares `.agents/skills` without links. On the phone these rows open on the PC, and the Android app must be updated with the desktop to read them.

- **The Android list is flatter.** Session rows drop the card, the activity pill and the per-row buttons for text-only rows like the terminal: the title is coloured by status, long-press shows details, and the Live, History and Hidden tabs no longer carry counts.

## [0.11.3] - 2026-10-06

- **Helpers appear under their parent conversation.** Claude helpers launched by Codex nest under the conversation that started them. Parent links work across Claude, Codex and Pi, including grandchildren, and survive removal of duplicate Codex terminal rows.

## [0.11.2] - 2026-10-06

- **Empty Codex threads stay hidden.** Idle daemon threads without a name or first prompt no longer appear as UUID-titled ready rows. Terminal-owned threads and working or waiting tasks remain visible.

## [0.11.1] - 2026-10-05

- **Codex sessions stay closed.** Closing a Codex terminal also archives its daemon thread, so the conversation does not return as a background row. History is retained. Local terminals still close when the daemon is unavailable, and an archive failure reports the partial close so it can be retried.

## [0.11.0] - 2026-10-03

- **Sessions survive a restart.** Restarting the computer emptied the list, because kiln only knew the sessions that were running. It now saves each Claude, Codex and Pi session running in a terminal, and after a restart lists them as `stopped`. `Enter` resumes the conversation in a new kiln session in the same directory, and `x` forgets the row without touching the conversation. A session closed before the restart is not kept.

## [0.10.0] - 2026-10-02

- **Pi sessions show their status and title.** Kiln starts Pi with a small extension that reports whether the session is working, waiting on a prompt or ready, along with its name or first prompt. The list, the phone and turn-finished notifications use it like Claude's and Codex's own status. A Pi started outside kiln still shows `unknown`.
- **ACP adapter names in settings are no longer rewritten.** `claude-agent-acp`, `codex-acp` and `pi-acp` in `[agents]` were read as the native commands. They are now run as written, so set them to `claude`, `codex` and `pi`.

## [0.9.0] - 2026-10-02

- **Pi opens in its own terminal UI.** Kiln ran Pi through an ACP adapter and drew the conversation itself. New Pi sessions now start `pi` in kiln's tmux server like Claude and Codex, `Ctrl+Q` returns to the list, and running Pi terminals appear in the list with their status shown as unknown, because Pi reports none. A settings file that still says `pi = ["pi-acp"]` uses `pi`.
- **The ACP host is gone.** Kiln no longer starts a background host process, needs `pi-acp` or `flock`, or serves `/v1/acp` to phones. Conversations saved by the host are no longer listed; a Claude or Codex one can be resumed from that provider's own resume picker.

## [0.8.4] - 2026-10-02

- **Claude rows stay put when `claude agents` is slow.** A listing that timed out or failed emptied every Claude row until the next refresh. The last rows now stay, with their status shown as unknown, until a listing succeeds.

## [0.8.3] - 2026-10-02

- **`x` deletes a running Claude background job in one step.** It stopped the job and left a `stopped` row that needed a second `x`. It now stops the job and removes it with `claude rm`, after the same confirmation.

## [0.8.2] - 2026-10-02

- **Finished Claude jobs can be deleted from the list.** `x` on a completed or stopped job asks for confirmation, then runs `claude rm`. Claude removes the job and its worktree and refuses while the worktree has unpushed commits; kiln shows its reason.
- **Codex status survives a large archive.** Listing archived threads took one pass per refresh inside a 1.5 second budget, so several thousand archived threads made every Codex row lose its status. A long scan now continues across refreshes; a short one still runs in full each time.
- **Plainer phone copy.** The pairing screen is titled "Pair with kiln" and the machines screen says "Computers paired with this phone."
- **The skills view uses the list's colours** for shared, missing and conflict.

## [0.8.1] - 2026-10-02

- **Claude sessions show their titles again.** Claude Code now records the titles it generates separately from ones you set with `/rename`, and kiln read only the latter, so sessions fell back to names like `kiln-05`. Kiln reads both; a title you set still wins.
- **Sessions no longer go missing from the list.** A Codex session started with a prompt whose first word is a subcommand name, such as `codex "review the retry change"`, was dropped as if it were `codex review`. One unreadable recovery file made every refresh fail with "Session discovery unavailable". Both are fixed.
- **Recovery rows for released Claude sessions can be closed.** `x` now retires the row; before, it only said to close the session in its terminal.
- **Filtering matches the status column.** Typing `unknown`, `ready` or `needs input` finds the rows that show those words.
- **Smaller terminal fixes.** A connection error in a Pi conversation clears once the connection returns. Opening a Claude cloud session uses the validated link. In the skills view, `j` on an empty list no longer hides the first skill you create, and Tab is not typed into a name. kiln's tmux server no longer appends the same terminal features on every attach, and its status bar skips the kitty lookup it did every three seconds.
- **`kiln setup` refuses a broken symlinked unit.** A `kiln-serve.service` link whose target was missing was written through; it is now reported like any other link kiln did not create.
- **Phone fixes.** Cancelling pairing while a request is in flight no longer leaves the pairing screen disabled. "Updates delayed" is timed on the phone's own clock, so a phone a few seconds ahead of the PC no longer shows it permanently. The open button uses the PC's wording, so Codex rows read "Open in ChatGPT". A settings error made while `kiln serve` runs is named on the phone instead of "Session host unavailable". A malformed command to a saved ACP session returns 400 rather than an internal error.
- **One failing source no longer blanks the whole list.** If the ACP host or native discovery fails, the other keeps updating and the failed one keeps its last rows with unknown status. The reason stays on the status line until it recovers, on the terminal and the phone. The filter words for sessions without a terminal are now `job`, `thread` and `saved` instead of `background`.

## [0.8.0] - 2026-10-02

- **Finished Claude background jobs stay in the list.** Jobs that have completed or been stopped appear with that status instead of disappearing, on the terminal and the phone. Enter attaches with `claude attach`. On the phone they move to History after a day. Kiln does not delete them; use `claude rm`.
- **`kiln setup` keeps phone access running.** It installs and enables a systemd user service for the phone server, configures Tailscale Serve and prints a pairing QR. Each step reports what it changed, and a repeated run changes nothing. The service listens on localhost only and does not write pairing codes to the journal.
- **The README explains phone updates through Obtainium.** Releases already attach a signed APK, so no store is needed.

## [0.7.2] - 2026-10-01

- **Closing a resumed session removes its recovery row.** Private backups stay on disk without bringing an explicitly closed session back into the list.

## [0.7.1] - 2026-10-01

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
