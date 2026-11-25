# Changelog

What changed in each release, in the terms someone using kiln would notice. Dates are UTC.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The entries are prose rather than bare
Added/Fixed lists. Each version's entry is also its GitHub release notes, and older entries are kept
verbatim.

## [Unreleased]

- **Closing a spawned Codex child keeps it resumable.** `kiln close` no longer archives the thread of a headless `kiln msg spawn` Codex child, so `codex exec resume <id>` still works afterwards.

## [0.37.6] - 2026-11-24

- **Kiln shows every harness and account in its usage list.** Missing usage is marked unknown, and the footer identifies Codex session history and OpenCode Go readings. Muse usage comes from its native quota command, and shared history is used for refusals only when there is one Muse account.
- **Antigravity quota can appear in Kiln.** Its native status line can pass model-group usage to Kiln while keeping the existing status line visible.
- **Launch errors explain which accounts are blocked.** They identify a full meter or a recorded run limit and include known reset times.
- **Claude sign-in checks follow the current login.** A renewal result from an old login no longer marks its replacement as signed out.

## [0.37.5] - 2026-11-24

- **`kiln accounts` explains why an account is spent.** It identifies a recorded run limit or a full usage window and shows when usage was last read alongside a recorded limit. After Claude resets an account early, run `kiln accounts reset-limit NAME` to clear that account’s recorded refusal.

## [0.37.4] - 2026-11-24

- **A spawned Claude run whose login expired no longer marks the wrong account.** Kiln records the Claude config home each spawn actually used, so the exit report checks and marks that login, whichever process reports the exit, and a login renewed while kiln was asking is not recorded as failed.
- **A Codex worker spawned at a linked worktree can fetch, merge and commit there.** Kiln grants that worktree's own git metadata plus the shared `objects`, `refs` and `logs`, never the shared git dir itself or its `config` and `hooks`. A worker at the main checkout still gets no git write access, so spawn it with `--dir` at its linked worktree.
- **Two kiln processes opening an older state database at once no longer fail upgrading it.**

## [0.37.3] - 2026-11-23

- **A Claude limit that refuses one model no longer spends the whole account.** A plan keeps a weekly allowance for one model beside the account's own 5-hour and weekly windows, and a run that stopped on it (Claude Code calls it the Fable limit) was recorded as the account having no allowance until the weekly reset, so kiln refused every new run there for days while the account's usage still read 86% used. Only a limit that refuses every model spends the account now, and what kiln reports names the model limit that stopped the run.

## [0.37.2] - 2026-11-23

- **Opening a Muse exec session now resumes its conversation.** Its own pane only streams output and takes no input, so Enter on a headless `muse exec` row starts (or reuses) an interactive `muse resume` pane for the same conversation instead of attaching to the stream.

- **OpenCode sessions no longer refuse to start when the OpenCode Go monthly window is full.** Go is one of the providers an OpenCode session can run on, and it keeps answering past a full window, so kiln now shows the window and ranks by it without treating it as a spent account. Only a limit an OpenCode run actually ended on, recorded when it stopped, keeps new sessions from starting until it resets.
- **The session list footer gives every account its own line.** Usage for each Claude account, Codex, Muse and OpenCode now reads top to bottom instead of being packed onto two lines.
- **Claude sessions can start from a read-only home when the workspace is already trusted.** Kiln needs write access only when it has to record workspace trust or an import decision.

## [0.37.1] - 2026-11-22

- **Kiln for Android closes its live connection when you leave the app.** UnifiedPush can still deliver notifications if you enable it.

## [0.37.0] - 2026-11-22

- **`kiln msg list` no longer rereads every Claude transcript.** Every kiln process now shares how far it has read each transcript in `~/.cache/kiln/transcripts.sqlite`, so a listing reads only what was appended since kiln last looked, instead of each transcript from its start. With 11 Claude sessions whose transcripts total about 500 MB, a listing went from about 1.15 s to about 0.5 s of CPU.
- **`kiln msg spawn --as @peer` starts a child for a program outside kiln.** The peer becomes the child's parent, so its exit report and its messages to that name land in `kiln msg inbox --as @peer`, including from a sandboxed child. `--json` prints the child's name, directory and parent for a host tool to parse.
- **The README leads with what kiln does.** It opens with one line on running every supported agent in one list, then agents messaging and spawning each other, account failover and the Android client, and adds badges and a quickstart.

## [0.36.0] - 2026-11-21

- **Claude account homes keep their sandbox files linked.** Config homes now retain the shared `launch.json` entry even when Claude creates it later, and no longer copy transient Claude config locks into another account.
- **Claude account homes repair stale config links.** Preparing an account removes an old lock link it created into the shared Claude home, so trust updates no longer wait on a lock that belongs to another home.
- **Expired Claude tokens are removed from account routing.** A 401 from Claude's usage endpoint now starts the normal renewal check, and an account whose renewal fails shows `login` and is not selected for a new run.
- **`kiln msg spawn` explains `--account` for agents without named accounts.** `--account cillian` on Codex now says Codex has no named accounts and runs on its default login, instead of printing an empty account list.
- **`kiln close` waits for a Codex child's writer to exit.** Closing a working headless Codex child archives its thread once the process has exited (up to 5 s), and if archiving still fails it says the session stopped and only archiving failed.
- **A Claude spawn into a home that has not finished first-run setup fails fast.** An interactive spawn whose `.claude.json` lacks `hasCompletedOnboarding` is refused with the command to finish setup, and the start-timeout error says to answer any prompt its screen shows by running `claude` once in that home.
- **Resuming a Code Mode conversation headless is refused up front.** `kiln msg spawn claude --resume` of a conversation started in Code Mode now says to pass `--interactive` instead of reporting success and then exiting 1.

## [0.35.0] - 2026-11-21

- **Subagents no longer notify the desktop.** A session kiln nests under a parent never sends a desktop or phone notification; kiln tells the parent instead when the child ends a turn without messaging it, with its state, last reply and the `kiln close` command. A turn that ends into background work notifies once, and that work finishing does not notify again.
- **Desktop notifications carry a category.** `notify-send` gets `--category` `kiln.needs-input`, `kiln.turn-finished` or `kiln.usage`, so a notification daemon such as mako can give each its own sound or style.
- **An exited parent's children are cleaned up.** When a parent's process is gone, `kiln serve` closes its idle children and hands working or waiting ones to their grandparent, or leaves them for you when there is none.
- **`kiln serve` restarts after an upgrade.** Under systemd it exits once its executable is replaced, so the service starts the new version instead of running the old code against the new config.
- **Dead child panes are reaped.** A gone child's record stays until its exit report reaps its pane, so exited children no longer leave dead panes open.
- **A print-mode Claude running a background agent shows working.** An in-process background agent that has not finished counts as background work, as a background shell does.
- **A phone message to a Claude in a kiln terminal arrives as your own prompt.** It is typed at the prompt once the turn ends instead of going through Claude's peer inbox, and the conversation view shows peer messages as notices.

## [0.34.1] - 2026-11-21

- **Antigravity (`agy`) sessions show `needs input` when waiting on you.** `agy` keeps `status` as running while waiting for approval or an answer and records waiting steps in `raw_summary`. kiln now reads `waiting_steps` from `raw_summary` (including nested in-process subagents) so waiting `agy` sessions turn yellow, fire desktop and phone notifications, and hold queued `kiln msg send` typing.
- **The kiln skill explains how a headless child waits.** A headless Claude child stays alive while its background tasks run and exits when nothing is left, so a child that waits does so as its own background task; once it has exited, `kiln msg spawn claude --resume <name>` carries it on.

## [0.34.0] - 2026-11-20

- **The phone knows about agent accounts.** A session's details name the account it runs on. With phone writes on, the New session sheet offers the chosen agent's accounts when it has more than one, marks any that is at its limit, signed out or turned off, and starts on the one you pick; "Any account" leaves the choice to kiln. With notifications on, a phone is told when a session moves to another account and when an account has allowance again, under a new Accounts notification channel. The phone API's rows carry `account`, `GET /v1/directories` lists `accounts` (`agent`, `name`, `state`, and `until` for a spent one), `POST /v1/sessions` accepts `account`, and pushes add the `moved` and `available` transitions, which earlier apps ignore.

## [0.33.0] - 2026-11-20

- **An interactive Claude session that hits its usage limit moves to another account.** Only a headless `kiln msg spawn` child was restarted before; a session in a terminal stayed stopped. kiln now reads the refusal from the session's transcript and restarts the conversation in its own pane on the account with the most headroom, with a notice in the list and a desktop notification. A spawned child keeps its sandbox grant, outbox and exit report, and one started with `--interactive` comes back interactive. A session started with `--model` returns on the default model. When no account can take the session it stays where it is and the notice says why.
- **An expired Claude login is told apart from one that needs signing in.** A token that expired while its account was idle is renewed by Claude Code itself: kiln runs `claude auth status` in that account's home, at most every half hour, and never writes a token. A login that cannot be renewed shows `login` in the footer, is never chosen for a new run, and `--account` naming it says which command signs it in.
- **Accounts can be turned off and directories pinned.** `disabled = true` on an `[[accounts]]` entry keeps that login out of every choice and out of the footer; an entry named `default` with only `disabled = true` does the same for the agent's own home. A `[[pins]]` entry (`dir`, `agent`, `account`) starts every session of that agent under a directory on one account. A pinned run is never moved: when its account is spent the start is refused with the reason.
- **`kiln accounts` shows what routing sees.** It prints each agent account's usage, whether a run can start on it (`ok`, `spent`, `login`, `disabled`) and the directories pinned to it, and `--json` gives the same as JSON. `kiln accounts adopt` writes an `[[accounts]]` entry for each mclaude account directory not listed yet, with no new login; `--dry-run` prints the entries instead.
- **Claude cloud sessions are listed from every account.** With `claude_cloud` on, each Claude login is read on its own and its rows name their account. A login that fails keeps its last rows and reports its own problem.
- **A notification says when a spent account has allowance again.** Once the time the provider gave for a limit has passed and the limit is gone, the list shows a notice and a desktop notification is sent, once per limit.

## [0.32.0] - 2026-11-20

- **kiln keeps Claude accounts itself, without mclaude.** `[[accounts]]` now takes `agent = "claude"`, where `home` is that login's `CLAUDE_CONFIG_DIR`, and `kiln login claude <name>` prepares the home and runs `claude auth login` in it. A Claude home holds only its login; everything else links to `~/.claude`, so every account shares transcripts, settings, skills and memory and a conversation resumes on any of them. kiln reads each login's 5-hour and weekly usage from Claude's own usage endpoint for the footer and for choosing an account, and recognises a run that stopped on a usage limit from the record Claude writes in its transcript. New sessions, phone starts, resumed conversations, `kiln msg spawn` and failover pin the chosen account with `CLAUDE_CONFIG_DIR` and start `claude` directly. An existing mclaude account is adopted with no new login by an entry whose `home` is its directory, such as `~/.mclaude/accounts/<id>`. kiln no longer reads mclaude's state or sets `MCLAUDE_USE_ACCOUNT`: to keep several Claude logins, list them under `[[accounts]]` and set `[agents] claude` to `claude`. On macOS, where Claude keeps the login in the Keychain, accounts list without usage numbers.

## [0.31.4] - 2026-11-20

- **`kiln msg send` no longer calls a running session gone when it could not list the sessions.** A `kiln msg` command reads Claude's sessions from `claude agents`, which is given two seconds. When that failed or ran out of time, such as on a machine short of memory, the command saw no Claude session at all and answered `has exited` or `no running session` for one that was working. `kiln msg send`, `view` and `interrupt` now say that the listing failed for a name it could have left out, and a message a spawned child sent from its sandbox waits for a complete listing.

- **A child's exit keeps its status when tmux's sockets are in a directory of their own.** With `TMUX_TMPDIR` set, the command that reports a spawned child's exit looked for kiln's tmux server in `/tmp`, found no pane and told the parent only that the child `ended`, without its exit status or last output. The reporter is now given the socket directory along with the server name.

## [0.31.3] - 2026-11-20

- **An overlap notice no longer repeats for a file a session edited once.** kiln-autopilot told a Claude session that another session "is also editing" a file "which you changed for your current prompt" again each time any other session edited that file, long after the first session had moved on. A message from another session, such as a coordinator's next brief, now starts a new prompt for that session, so a file changed for an earlier one is not described as current. kiln's own notices, the overlap notice included, and a child's exit report do not start one, so being warned does not hide the next overlap. Each session hears about another one editing a file once, and again only after it edits that file for a new prompt.

## [0.31.2] - 2026-11-20

- **A session whose agent was killed can be resumed.** When an OOM killer or a `kill -9` ended a spawned Claude and nothing closed its kiln pane, `kiln msg spawn --resume` refused with `already running` and `kiln resume` listed nothing. A pane whose agent has exited no longer counts as running: the spawn reports the old run and replaces the pane, and `kiln resume` lists such a top-level session as stopped.
- **`kiln msg send` no longer refuses a resumed child on its old exit.** A child resumed after it was killed answered `has exited` with the earlier run's exit report whenever a send could not find it running. kiln now names that report only when no later run of the conversation has started.
- **`kiln msg spawn claude --interactive` no longer stops at the external imports question.** In a folder whose `CLAUDE.md` imports files from outside it, Claude asked once whether to allow those imports, so the child waited at a dialog no one could answer and the spawn failed with Claude's screen instead of an id. Where kiln trusts the spawn's folder it now also allows its imports, as answering that dialog would, and a choice already saved in the Claude config, including a refusal, is kept.
- **A session whose process is stopped no longer shows as working or takes a message.** A Claude stopped with SIGSTOP or a job-control stop kept the status its agent last reported, `kiln msg list` showed it as working with `delivery: now`, and a send reported delivered while nothing read it. Such a session now lists as `paused` with no status, and messages to it wait until its process continues.
- **A reply hint no longer names a kiln that was removed.** A kiln that kept running after its install moved, such as from `~/.local/bin` to `/usr/bin`, wrote its old path into the `[Reply with: ...]` line of each message it delivered, and following it failed with exit 127. The hint now names that kiln's executable only while it exists, and the `kiln` on PATH otherwise.

## [0.31.1] - 2026-11-20

- **A child that exits at once is no longer reported as started on a busy machine.** When a Codex or Antigravity child exited before it began its conversation, kiln waited one second for tmux to read its exit status and, if tmux had not, printed an id for a child that was already gone. kiln now reads the status of an exited process from the kernel, so the spawn fails with the child's exit status and output however long tmux takes.

## [0.31.0] - 2026-11-19

- **Several logins per agent.** Claude's accounts come from mclaude and kiln starts Claude through it, pinned to one account. Codex, Muse and OpenCode take `[[accounts]]` entries in the config, each with its own home, and `kiln login <agent> <name>` signs in to one. A new session or `kiln msg spawn` uses the account with the most headroom and skips one at its limit, `--account NAME` pins one, and the list shows each row's account. The footer shows numbers per account, OpenCode Go's from its usage endpoint, and a Muse or OpenCode account that hit its limit reads `spent ↻<date>` in red until it resets. A spawned run that ends on a usage limit starts again on another account: Claude resumes the same conversation, the others start fresh with the brief and last output, and the parent is told which.
- **`bun scripts/screenshots.tsx` no longer depends on the machine it runs on.** It builds the demo in a scratch home, so the list shot opens on the same row everywhere.
- **The session list shows how much of each agent's plan is used.** A line at the bottom reads, for example, `claude jenny 61%·5h 41%·wk  cjberragan 0%·wk  codex 35%·wk  muse spent ↻Nov 23`: each Claude account's five-hour and weekly windows from mclaude's last usage read, Codex's from its daemon, and OpenCode Go's from its usage endpoint. A window past 85% adds when it resets, a read older than 30 minutes is dimmed, and a disabled mclaude account is left out. Muse publishes no usage numbers, so it shows only `spent` after a run hits its limit.
- **Antigravity is a sixth agent kiln opens, lists and messages.** Sessions from the Antigravity CLI (`agy`) join the list, the dashboard, the phone and `kiln msg`: `n` starts one in a directory, `[agents] agy` sets its command, and `kiln msg spawn agy` runs a headless `agy -p` child that shows as working while it runs and reports its exit to its parent. An interactive session shows working or idle from Antigravity's own summary database, and appears without a status or id until its first prompt creates the conversation. Messages are typed into an agy session kiln started once it is idle. kiln cannot read an Antigravity transcript, so `kiln msg view` shows nothing for it and an agy child answers by messaging its parent.
- **`kiln attach <name>` opens a session's terminal from the command line.** It does what `Enter` does on a row in the list, for the name `kiln msg list` prints or one of its aliases, so a launcher or desktop panel can open a session without knowing its tmux name. An unknown name exits 1.

## [0.30.6] - 2026-11-19

- **A Codex child starts outside a git repository.** `kiln msg spawn codex` run from a folder that is neither a git repository nor trusted by Codex printed a child id, and the child exited at once with `Not inside a trusted directory and --skip-git-repo-check was not specified`. kiln now passes `--skip-git-repo-check`, and a Codex child that exits before it starts its thread fails the spawn with its exit status and output instead of printing an id.
- **A Muse child loads its workspace's rules.** `kiln msg spawn muse` started Muse with the workspace untrusted, so the child skipped the folder's AGENTS.md, its project skills and delegation, which a Claude or Codex child in the same folder loads. kiln now passes `--trust-workspace`, which trusts the folder for that run only and saves nothing.
- **`kiln resume` reports a saved session list it cannot read.** When kiln could not read or update its saved sessions file, `kiln resume` printed `no stopped sessions` and the list showed none, so sessions a restart stopped looked lost. One cause was a sessions file that a newer kiln had given an extra column, which an older kiln could not write to. kiln now writes its rows into such a file, and `kiln resume` and `kiln close` exit with `Stopped sessions unavailable:` and the reason, which the list and the phone also show. Running sessions are still listed.
- **tmux below 3.7 can drop the last output lines of a spawned child's exit report.** The README now says so. The exit status is still reported correctly.

## [0.30.5] - 2026-11-18

- **A spawned child can message its parent and commit from inside its sandbox.** A Codex or Claude child started with `kiln msg spawn` runs its commands in its agent's sandbox, which hides the other sessions, so `kiln msg send <parent>` exited with `cannot see the sessions running outside it`, and a Codex child in a git worktree could not commit because Codex kept the worktree's git metadata read-only. The child's `send` now leaves the message in an outbox kiln grants it, and kiln delivers it from outside the sandbox, as from that child. A Codex child is also granted its worktree's git directory and the repository's objects, refs and logs, but not its hooks or config. Outside a spawn, a sandboxed `send` that names its recipient in full waits in the mailbox for kiln's list or phone server to deliver it. A message to a name kiln cannot resolve comes back to the child with the reason, and an interactive Claude child is granted the outbox through its sandbox settings, so it never stops at a prompt to trust the folder.

## [0.30.4] - 2026-11-18

- **A spawned child that fails reports its exit status and error to its parent.** `kiln msg spawn` run from an agent inside kiln's tmux set the child's exit hook and `remain-on-exit` on the parent's own window, because tmux took the target of those commands from the caller's `$TMUX_PANE`. The child's pane then closed as it exited, and the parent heard only `ended while working on ...`, without the status or the error, such as a Muse usage limit. The child's pane now gets its own options, so the report carries the exit status and the last output.

## [0.30.3] - 2026-11-18

- **`kiln msg` says when a sandbox hides the sessions.** Run inside a sandbox with a process namespace of its own, such as Claude Code's Bash sandbox, `kiln msg list` printed nothing and `kiln msg send` said `no running session`, so an agent concluded its peers were gone. kiln now exits with `kiln runs in a process namespace of its own (sandboxed?), so it cannot see the sessions running outside it`, and names the socket when the sandbox refuses kiln's tmux server.

## [0.30.2] - 2026-11-18

- **`kiln msg send` says when Claude holds a message at its approval prompt.** Claude can hold a message from another session until a person picks `Deliver this message to Claude` in the recipient's terminal, as it does for a session that is not prompting for permissions. kiln reported that as `Claude did not queue it, so it held, refused or dropped it`, the same as a lost message, so the sender waited on a reply that could not come. When the recipient runs in a kiln pane that shows the prompt, kiln now says `held at Claude's message approval prompt in <session>; approve it there`.

## [0.30.1] - 2026-11-18

- **A Claude session that compacts its conversation while idle shows as idle.** Claude compacts a long conversation when it has sat idle for most of an hour, and can report the session as busy meanwhile. `kiln msg list`, the list and the dashboard showed it as working while its pane waited at an empty prompt, and kiln read the summary Claude writes into the transcript as a new prompt. The summary no longer counts as one, and a Claude session in a kiln pane whose transcript ended its turn reads as idle unless its footer shows a turn running (`esc to interrupt`).

## [0.30.0] - 2026-11-18

- **Muse is a fifth agent kiln opens, lists and messages.** Sessions from Muse (`muse`) join Claude, Codex, OpenCode and Pi in the list, the dashboard, the phone and `kiln msg`: `n` starts one in a directory, a restart-stopped one resumes with `muse resume`, and `kiln msg spawn muse` runs a headless `muse exec` child that shows as working while it runs and reports its exit to its parent. Messages reach a running Muse session at once through Muse's own session messaging, including from a Muse session itself, whose `kiln msg whoami` now resolves. Muse publishes no session status, so an interactive Muse session shows its activity as unknown rather than guessed, and kiln cannot read a Muse transcript, so `kiln msg view` shows nothing for Muse and a Muse child answers by messaging its parent.

- **One `kiln` skill replaces `kiln-agents`, `kiln-config` and `kiln-skills`.** Messaging other sessions, changing kiln's TOML settings and repairing shared skills are one skill with one entry in an agent's skill list; the settings and skill-repair detail load only when needed. kiln removes the three skills it bundled before, with their Claude and Pi links, the next time it syncs. A copy you edited is kept under the shared store's `.kiln-backups`, and a same-name skill kiln did not install is left alone. `npx skills add cjber/kiln` and the Claude Code plugin install the new skill.

## [0.29.2] - 2026-11-18

- **`kiln msg spawn claude --resume <name>` carries on a Claude child that has exited.** It restarts the conversation by the id spawn printed, in the directory it began in and with its title, and records the caller as its parent, so a child cut off by a network outage or a usage limit picks up where it stopped and still reports its exit.
- **A running `codex exec` session shows as working.** A Codex child started with `kiln msg spawn`, or any other `codex exec` run, was listed with status `unknown` from start to finish, the same as a session whose status kiln cannot read, so a parent could not tell from `kiln msg list` whether its child was still at work. `codex exec` runs one turn without asking anything and exits when the turn ends, so kiln now lists it as working while its process runs; it leaves the list when it exits, and its parent still gets the exit report. Messages to it still wait in its mailbox, and `kiln msg interrupt` says it cannot stop one rather than pressing Escape in a pane that takes no input.
- **`kiln resume` no longer offers a Claude session that finished or has nothing to resume.** A session Claude lists as a finished background job, or whose Claude transcript no longer exists, is dropped from the stopped sessions a restart left, instead of showing in `kiln resume` and the list. Resuming a Claude session with no transcript now says it has no conversation to resume, rather than starting Claude and reporting `Claude exited with status -1`.
- **A spawned interactive Claude that never starts fails the spawn.** `kiln msg spawn claude --interactive` used to print the child's id and exit successfully even when Claude was held at a startup question kiln does not answer, such as whether to allow a project's CLAUDE.md to import files from outside its folder. The child then never read its prompt and never appeared in `kiln msg list`. Now a child that has not started its session within 30 seconds fails the spawn with what its screen shows, and kiln closes it.
- **A spawned child's exit is still reported when its pane is gone before the status can be read.** The exit watcher stopped silently once tmux no longer had the pane, and a report needed a status to read, so a child whose session closed first (a person closed it, tmux restarted, or a tmux without remain-on-exit removed the pane as its command ended) produced no notice at all. The watcher now reports that child as ended, naming it from its spawn record, and the message id keeps a hook and a watcher from reporting one exit twice. A spawn that recorded no caller also reports to the parent found for it later, rather than to nobody. A report still carries the child's exit status whenever tmux has it: the exit hook and watcher read the tmux server that holds the pane under any locale, where a reporter without a UTF-8 locale used to misread the pane as gone and report the child as ended with no status, and a pane is closed only after its report is posted, so a reporter that stops partway leaves the exit to the next one. An interactive Claude that quits before it starts its session no longer holds `kiln msg spawn` for 30 seconds while tmux has yet to collect its process.
- **A message to a Claude session is no longer held by its faint prompt suggestion.** kiln held a message with `Queued, sends by itself: someone is typing in its terminal` when Claude's prompt box showed only the suggestion Claude draws faint, as if that suggestion were a draft. kiln now ignores faint text when it checks the prompt, so the message is typed in, and a real draft still holds it.
- **A message to a spawned child that has exited names its exit.** `kiln msg send`, `view` and `interrupt` said `no running session is called <name>` for a child that had ended, the same as for a mistyped name. When kiln reported that child's exit, they now say it has exited, when, and with what status.

## [0.29.1] - 2026-11-17

- **Messages reach a Claude session waiting on a wakeup or background work.** Claude keeps a `claude -p` session, such as a headless `kiln msg spawn` child, listed as busy for as long as it runs, so a child that ended its turn to wait on a `ScheduleWakeup` or a background shell held every message until it woke by itself, sometimes for half an hour. Kiln now reads each turn's end from the session's transcript: such a session shows as idle in the list, the status bar, the dashboard and `kiln msg list`, and as working only while a background shell it started still runs. Messages to Claude sessions go through the inbox Claude opens for messages from other sessions instead of being typed into the terminal: a waiting session starts a new turn with the message at once, a working one takes it at its next step, and Claude sessions kiln did not start can be messaged too. Sessions without that inbox are typed into as before.

## [0.29.0] - 2026-11-17

- **`kiln msg interrupt <name>` stops another session's turn.** It presses Escape in a Claude session kiln started, and asks Codex's shared daemon or OpenCode's service to stop the turn in progress, so a session spending effort on the wrong task can be stopped and then redirected with `kiln msg send`. A session that is not working is left alone, and Pi sessions or Claude sessions kiln did not start report why they cannot be interrupted. The phone's Stop button uses the same path, so it now also stops OpenCode sessions and Codex threads on the shared daemon.

## [0.28.4] - 2026-11-17

- **A spawn's exit watcher stops when its session closes.** On tmux 3.8 the watcher every spawn starts kept running after its session was gone, one background process per spawn. It now stops once tmux no longer has the session.

- **`kiln msg spawn claude --interactive` no longer stops at the folder trust question.** Claude asks whether to trust a folder before an interactive session reads its prompt, so a child spawned into a folder Claude had not trusted waited there and never started its work. Kiln now records the spawn's folder as trusted in the Claude config the child runs with, the way Claude saves that answer itself: the repository's main checkout, or the folder outside a repository, and never the home directory. When a launcher such as a multi-account wrapper starts Claude under another config, kiln trusts the folder there too and starts Claude again. Kiln writes under the same lock Claude takes for that file, never trusts the home directory or the filesystem root (an interactive spawn there now fails with the reason instead of waiting), and leaves a `.claude.json` it cannot parse as it is, failing the spawn with the reason.

- **A spawned child's exit is reported even when tmux loses it.** A spawn's exit report waits for tmux's `pane-died` hook, and a tmux built with libutempter, as Debian and Ubuntu ship it, can miss the hook for a pane command that exits while tmux runs its utmp helper. Each spawn now starts a watcher that reads its pane, so tmux collects an exit it missed and the parent hears the real status instead of nothing.

## [0.28.3] - 2026-11-16

This release also includes the changes from 0.28.2, which was tagged but never published: `kiln resume` reports a session that does not start, Claude sessions started in Code Mode resume, and a Claude session is no longer mistaken for the process that took its pid.

- **An agent that quits is reported with its real exit status.** tmux marks a pane dead as soon as its terminal closes, and a tmux built with libutempter, as Debian and Ubuntu ship it, can miss the command's exit entirely. `kiln resume` now waits for tmux to have the status and asks tmux to collect an exit it missed, so it no longer reports status 0 for an agent that failed, and an agent killed by a signal is reported with the status a shell gives it, such as 143 for SIGTERM. A command that closes its terminal but keeps running no longer keeps kiln waiting past its grace period, and a session another resume or reconnect restarts meanwhile is left running.

## [0.28.2] - 2026-11-16

This version was tagged but never published: its release build failed, and 0.28.3 carries its changes.

- **`kiln resume` reports a session that does not start.** A resume now counts only once kiln sees the conversation running in its pane, so an agent that quits during launch, however late, makes `kiln resume` exit non-zero with what it printed, and the session stays in the stopped list to try again.

- **Claude sessions started in Code Mode resume.** Kiln reads Claude's record that a conversation started in Code Mode and resumes it with Code Mode on and without Remote Control, which Claude needs to resume it.

- **A Claude session is not mistaken for the process that took its pid.** When `claude agents` fails, kiln keeps the rows from its last listing, and now drops one whose process has since exited and had its pid handed to another program, instead of listing that program as the session.

## [0.28.1] - 2026-11-16

- **A spawned child's answer can be read after it exits.** `kiln msg view <name>` reads a session that is no longer running by the full name `kiln msg spawn` printed, from the transcript its provider keeps. A spawned Codex run is now named by its thread rather than its process, so its name leads to that transcript.

- **Starting a session right after the last one closed no longer fails.** Kiln's tmux server now stays up when it has no sessions, so a spawn or new session that arrives while it would have been shutting down starts as usual.

## [0.28.0] - 2026-11-16

- **Spawned Claude sessions can be watched.** `kiln msg spawn claude --interactive` starts Claude's terminal UI with the chosen title and model, so you can attach from the list and follow a long run as it works.

- **Headless Claude children keep their background work.** Claude's print mode stopped a child's workflows, monitors and shells 10 minutes after its last turn. Spawned Claude children now wait for them.

## [0.27.0] - 2026-11-16

- **Agent messages arrive without waiting on unrelated sessions.** Active Codex sessions receive replies during their current turn. Separate recipients deliver concurrently, and peer sends and JSON inbox reads avoid a full session discovery.

- **Peer programs can forward replies reliably.** `kiln msg inbox --peek --wait` leaves messages unread until a recipient-scoped `kiln msg ack`. `kiln msg view` reads transcript pages for local daemon integrations.

- **Android screenshot capture waits for hidden system bars.** Seeded screenshots signal readiness after immersive mode takes effect.
- **Child exit reports leave replacement panes running.** A delayed report only removes the exited pane generation it inspected. OpenCode conversations remain available after a child exits; use `kiln close` to interrupt and archive one explicitly.

- **Codex reconnect keeps configured commands discoverable.** `kiln reconnect <name>` resumes an unknown Codex pane with its thread UUID, including when the configured command has flags or a wrapper.

- **Codex spawn identities stay resolvable.** `kiln msg list --json` keeps the provider session as `name` and exposes the process identity printed by `kiln msg spawn` in `aliases`, so liveness checks continue to find a running child after Codex assigns its thread id.

## [0.26.2] - 2026-11-13

- **Commits no longer fail in watched checkouts.** Kiln counts a checkout's changed files with `git --no-optional-locks status`, so its poll never holds `index.lock` while an agent commits there.

- **Spawned Codex runs can be listed and messaged.** A `codex exec` run appears in `kiln msg list` under its thread id, the name it knows itself by, and still answers to the id `kiln msg spawn` printed. A message to it waits in its mailbox until it runs `kiln msg inbox`, and it keeps its recorded parent and title.

## [0.26.1] - 2026-11-13

- **Spawned Claude sessions keep their title.** `kiln msg spawn claude --title T` names the session T, instead of the list showing the title Claude generated from the prompt.

## [0.26.0] - 2026-11-13

- **Timers can start agents.** `kiln msg spawn` run outside an agent session, from a timer or your own shell, starts a top-level headless session in kiln instead of refusing.

## [0.25.0] - 2026-11-13

- **Running OpenCode agents stay visible.** Kiln reads active conversations beyond the service's first page and keeps runs whose process names their conversation visible while the service is unavailable. Their status stays unknown until it can be read, and spawned runs keep their recorded title and parent.

- **Queued phone messages stay visible.** The session view shows messages waiting in the mailbox after the conversation as queued user messages, and keeps the reply field available when kiln can accept the message later.

- **Phone messages reach a session open on the computer.** kiln used to hold every message for a Claude session while any terminal had it attached, so a phone reply waited until you left the session on the computer. It now waits only while that session's prompt box holds a draft, and the phone says why a queued message is waiting and that it sends by itself.

- **Message programs that are not sessions.** A name starting with `@` is a mailbox with no session, such as another tool's CLI: `kiln msg send @name` posts to it, and `kiln msg send --as @name` and `kiln msg inbox --as @name` let that program send and read. A session's reply command names the peer, so its answer waits in that mailbox. `kiln msg send --json` prints each recipient's outcome.

- **The computer stays awake while agents work.** `kiln serve` holds a systemd sleep lock while any session is working, so an idle timer's suspend is refused until the work finishes. Screens still turn off and lock as usual. Set `keep_awake = false` to turn it off.

## [0.24.0] - 2026-11-08

- **A restart no longer revives finished subagents.** A one-shot `opencode run` stayed in kiln's saved sessions, so after a restart it showed as stopped and `kiln resume --all` started it again as an interactive session, which went on editing its old worktree. Subagents and headless runs are no longer saved for resuming, and rows already saved for them are dropped.

- **Finished OpenCode sub-sessions leave the list.** An OpenCode run another agent started is archived once its process has exited and its last turn ended, whether or not `kiln msg spawn` started it, so a parent no longer collects a pile of ready children for six hours. One that failed or asks a question stays listed.

- **Subagents ask the agent that started them.** An OpenCode subagent that stops to ask a question now sends it to its parent agent as a kiln message, since a headless run's question shows on no screen. The parent's `kiln msg send` reply answers the question in OpenCode directly, rather than waiting behind it as a new prompt.

- **Subagents that need input show under a collapsed parent.** The header counted every session waiting for input, but a waiting subagent stayed hidden inside its collapsed parent, which only read "working". The list now shows each waiting subagent, and the agents between it and its top-level parent, without expanding the row.

- **See what each agent edited.** Press `e` on a session to list its prompts with the files each one changed and the lines added and removed, then open a file to read it with each agent's lines marked in its colour. `]` and `[` jump between edits, `v` and `a` send selected lines and a question to the session that wrote them, and `f` follows a session, opening each file as it is edited. `kiln edits` and `kiln blame <file>` print the same from the command line, and `kiln edits --follow` streams new edits as JSON. Edits come from the Claude, Codex, OpenCode and Pi transcripts, and a line something else changed since is credited to nobody.

- **Warnings when two sessions edit the same file.** When a session edits a file another live session changed in its latest prompt, `kiln serve` messages both. Set `edit_messages = false` to turn this off.

- **Edits on the phone.** A session's view in the Android app has an Edits tab listing each prompt's changed files and line counts.

- **Android builds retry the Gradle download.** A release no longer fails when services.gradle.org returns an error or stalls for a moment: the wrapper now tries five times, five seconds apart, and waits up to a minute per attempt. The release's source tarball and CI's gitleaks download retry the same way, and a release run can be rerun after a later step fails.

## [0.23.0] - 2026-11-08

- **Close sessions from the command line.** `kiln close` lists the sessions the list's `x` key can close, and `kiln close <name...>` closes them the same way: a kiln terminal closes, an OpenCode or Codex daemon conversation is archived, a Claude background job is stopped and removed and a stopped row is forgotten. Agents can now tidy up finished sessions, and the `kiln-agents` skill says when to.

## [0.22.2] - 2026-11-06

- **Publishes the 0.22.1 changes.** The 0.22.1 build stopped on an outdated test and published nothing, so this is the first release with them.

## [0.22.1] - 2026-11-06

- **A tidier session list.** Each row is one line: the detail line with the repository, worktree, branch, pull requests and changed files now shows only under a row you expand with space. The `pr` column shows the newest pull request's number with a dot coloured by its stage, red failing, yellow running, green passing and grey merged, and the expanded row lists every pull request the same way. Claude's name is now peach, so it no longer shares orange with the directory headings.

- **Detached subagents nest under the agent that started them.** A run started with `nohup opencode run ... &` outlives the shell that started it, so its process ancestry stops at init and it listed at the top level. Kiln now reads the session id the run inherited from its agent's environment, such as `CLAUDE_CODE_SESSION_ID`, records that agent as its parent, and keeps it nested after the run exits. The `kiln-agents` skill now tells agents to use `kiln msg spawn` only when their own session runs in kiln.

- **Subagents stay under the agent that started them after they finish.** A headless run such as `opencode run`, started from another agent's shell, nested under that agent only while its process ran. Once the run exited, its session, still listed as ready, moved to the top level. Kiln now records the parent while the run is alive, and keeps the record as long as the provider lists the session. Children started with `kiln msg spawn` also kept their recorded parent for only two minutes after their process exited. They now keep it the same way.

## [0.22.0] - 2026-11-06

- **The dashboard shows what each session is doing, and how the day went.** `kiln dashboard` now draws one card per top-level session, with a lane for the session and each child under it: agent, repository and worktree chips, a five-step bar from working to merged, its pull request, and its uncommitted count. Projects other than the busiest collapse into pills you can open. Under the header a stacked area chart covers working and waiting agents over six hours with a hover readout, a donut splits open pull requests by stage, and each lane has a sparkline of its working time. The page keeps its light and dark palettes, pulses a lane when its stage changes, fades sessions idle for 30 minutes, and fits a phone.
- **A wordmark for kiln.** The name is drawn as vector outlines from Liberation Sans, with the dot of the i kept as an ember in the icon's colours. The README and the site header show the light or dark version to match the page, both generated by `scripts/wordmark.py`.
- **The session list shows what each session is working on.** Every row now has a dim line with its repository, worktree, branch, pull request stage and count of changed files, kept current at the list refresh. `Space` expands a session's children alongside `Tab`, `Left` and `Right`, and an expanded row shows `⌄` with its child count after the title.
- **Agents start subagents that nest under them.** `kiln msg spawn <agent> [--dir PATH] [--title T] -- <prompt>` starts a headless agent in kiln's tmux server, records the caller as its parent and prints the child's kiln id. Children nest under their parent in the terminal list, the dashboard and `kiln msg list`, and a child messages its parent with `kiln msg send <parent>` when it finishes. A spawned OpenCode run is archived when it exits. A headless OpenCode run kiln did not start now carries the PID of its `opencode run` process, so it nests under the agent whose shell started it, and is hidden once it has been idle for six hours.
- **Resume every session a restart stopped, from the command line or the phone.** `kiln resume` lists the stopped sessions, and `kiln resume --all` or `kiln resume <name...>` resumes them one at a time, with `--prompt TEXT` as a first prompt. Each one must run for five seconds to count as resumed; an agent that quits sooner, as several started at the same moment can, is started once more and then reported with what it printed, where before its pane vanished without a trace. A stopped session's sheet on the phone has a Resume button when phone writes are on.
- **The phone tells you when a pull request's checks fail.** When a session's open pull request goes from running or passing checks to failing, `kiln serve` sends a push naming the pull request and the session, even while the app is closed. The alert has its own notification channel, "Checks failed", so it can be muted on its own, and it clears once the checks stop failing or the session closes. A turn alert for the same session no longer replaces it.
- **The tmux status line costs far less CPU.** Every attached kiln terminal refreshed its status line every three seconds by listing every session, which started `claude agents` each time. `kiln status` now shares one line, cached for 15 seconds, across every terminal, and only one of them refreshes it.

## [0.21.0] - 2026-11-05

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

- **The in-session status bar costs almost nothing.** Every attached tmux client shares one session count, refreshed at most every 15 seconds, so the bar no longer lists every session, and starts `claude agents`, for each client every 3 seconds.

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
