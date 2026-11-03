# AGENTS.md

kiln is a Bun + TypeScript terminal UI (OpenTUI React) that opens native Claude, Codex, OpenCode and Pi TUIs, plus read-only cloud discovery. Arch users install it
from the AUR as `kiln-agents`, which a `v*` tag publishes.

## Commands

`bun start` opens the TUI; it needs `fzf` and `tmux` on `PATH`.

```sh
bun install --frozen-lockfile
bunx biome ci .
bunx tsc --noEmit -p .
bun test
bun scripts/changelog.ts --check
bun scripts/perf.ts
bun scripts/list-tui-e2e.ts
bun scripts/native-tui-e2e.ts
python3 .sloppatrol/gate.py --base origin/main
python3 .sloppatrol/agents.py check
```

CI runs the same except `bun scripts/perf.ts`, plus actionlint, zizmor and gitleaks over the workflows and history.
Native x64 and arm64 CI jobs build and exercise the standalone executable and install the rendered
binary AUR package in Arch without Bun. Release publication waits for both jobs.
After every visible change, regenerate and inspect both terminal and mobile mock screenshots.
`bun scripts/screenshots.tsx 2>/dev/null` renders the terminal;
`ANDROID_HOME=/path/to/sdk JAVA_HOME=/path/to/jdk21 python3 scripts/android-screenshots.py`
renders seeded production Android list, pairing and handoff screens on a dedicated emulator, never a real phone.
`assets/icon.svg` is the shared mark; `python3 scripts/icons.py` regenerates README and launcher assets.
Every version needs a `CHANGELOG.md` entry (prose, bold-lead bullets) before its tag.

## Layout

- `src/sessions.ts` - `discovery()` merges native and cached cloud rows and drops `elsewhere` ones kiln cannot open; each source keeps its last rows while it fails.
  `sessionIdentity` is the one name for a session in the list, on the phone and in notifications.
- `src/native-sessions.ts`, `src/codex.ts` - native session discovery and daemon status. Finished Claude background jobs carry a
  `lifecycle` (`completed`, `stopped`) instead of an activity. Pi is found by process.
- `src/pi-status.ts`, `pi-extension/kiln-status.js` - the extension kiln loads into the Pi sessions it starts (`pi -e`) and the reader for the
  per-process status file it writes. A Pi started elsewhere has no record and stays unknown.
- `src/opencode.ts` - status from OpenCode's background service over loopback HTTP, using the address and password it records in
  `$XDG_STATE_HOME/opencode/service.json`; read only while that service runs. Closing archives through `opencode api`, which starts the service if needed. Kiln passes each session its `--session` id; a terminal with no id in argv is never paired by directory.
- `src/saved-sessions.ts` - the terminal sessions and Codex daemon threads last seen running, in `$XDG_STATE_HOME/kiln/sessions.sqlite`. One saved in an
  earlier boot is listed as `stopped` in place `saved`, and opening it resumes the provider conversation.
- `src/cloud-links.ts` - validated provider HTTPS URLs for cloud-session handoffs.
- `src/cloud.ts` - cached read-only Codex Cloud tasks; CLI refresh is asynchronous, at most every 60 s.
- `src/transcript.ts`, `src/workdir.ts` - Claude transcript titles, and the checkout an agent last edited or `cd`'d into, shown in place of
  where it started (`sessionDirectory`); `cwd` stays the start directory for resuming.
- `src/session-sort.ts`, `src/session-list.ts` - ordering, directory/task groups with collapsed children, status wording and the cursor.
- `src/app.tsx` - the whole UI and its keys.
- `src/tui.ts` - the shared palette, text-key test and editor hand-off every view uses.
- `src/claude-cloud.ts` - opt-in internal Claude cloud API, existing login, cached reads and safe errors.

- `src/launcher.ts` - open, create and close rules for each place kind, returning an outcome the view follows.
- `src/tmux.ts`, `tmux.conf` - kiln's private tmux server (`tmux -L kiln`), no prefix, one detach key.
- `src/server.ts`, `src/pairing.ts`, `src/phone-links.ts` - localhost phone API, one-use pairing and provider handoffs.
- `src/opencode-web.ts` - `kiln setup` pins OpenCode's service to port 4096 and serves its web UI on the tailnet. Phone links are one-use
  `/opencode/<code>` paths on kiln's server that set OpenCode's sign-in cookie and redirect to the session page.
- `src/setup.ts` - `kiln setup`: idempotent systemd user unit for `kiln serve --local`, tunnel and pairing QR.
- `android/` - native Kotlin/Compose client; CI runs unit tests, lint and builds its APK.
- `src/settings.ts` - `~/.config/kiln/config.toml`; unknown keys are errors.
- `src/skills.ts`, `src/skills-view.tsx`, `src/skills-cli.ts` - shared stores, backed-up conflict repair and the `S` view.
- `src/mailbox.ts`, `src/messages.ts`, `src/msg-cli.ts`, `skills/kiln-agents/` - `kiln msg`: a SQLite mailbox, the caller's name from its agent's
  session id variable, and delivery as a prompt (OpenCode service, Pi extension inbox, Codex `turn/start`, tmux paste for kiln Claude).
  Typing waits for `idle`; the list and phone server flush pending messages on refresh.
- `src/bundled-skills.ts`, `skills/` - embedded helpers synced to the shared user store before the TUI starts.
  Preserve unowned same-name skills and back up edits to managed instructions before upgrades.
- `scripts/` - release, changelog, AUR PKGBUILD rendering, screenshots, standalone builds.
- `scripts/smoke-binary.ts`, `scripts/check-binary-package.sh` - native executable and Arch package checks.
- `scripts/qa-drive.ts`, `scripts/qa-phone.ts` - seeded list and phone app for Bugpatrol (`.bugpatrol/bugpatrol.yml`, `.bugpatrol/android.yml`); never the real sessions or a paired phone.
- `bun scripts/build.ts` builds Linux x64/arm64 into the generated dist directory; install with `--os linux --cpu "*"` first.
  The binaries embed OpenTUI assets and `tmux.conf`; AUR `kiln-agents-bin` needs no Bun.

## Rules

- Commits are signed (`git commit -S`) with the personal email, in Conventional Commits form.
- Activity is a closed set (`working`, `waiting`, `idle`); map each agent's own states onto it with an
  exhaustive switch, never a fallthrough guess. Unknown activity stays unknown; pane output is not working status.
- Anything that can fail at startup (a bad settings file) is reported before the TUI takes the
  screen; nothing prints to the console while it is up.
- README and changelog copy is plain and concrete: no marketing words, no em dashes.
- Quality: load `.agents/skills/sloppatrol-project/SKILL.md` before cleanup, dead-code or refactoring
  work.

Phone changes also require `ANDROID_HOME=/path/to/sdk android/gradlew -p android checkKotlinFormat testDebugUnitTest lintDebug assembleDebug`. Keep credentials out of URLs and logs; phone handoffs accept only verified provider HTTPS links, or a one-use `/opencode/<code>` path the phone resolves against the kiln server it paired with.

Android releases use repository signing secrets and attach a signed APK. CI checks both debug
and release variants; private signing material stays outside the repository.

Prepare release metadata on a PR branch; the release helper updates desktop and Android together.
Its separate tag action requires the merged origin/main commit. Never push main directly.
