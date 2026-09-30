# AGENTS.md

kiln is a Bun + TypeScript terminal UI (OpenTUI React) that lists every interactive Claude Code,
Codex and Pi session on a Linux machine and takes you to the one you pick. Arch users install it
from the AUR as `kiln-agents`, which a `v*` tag publishes.

## Commands

```sh
bun install --frozen-lockfile
bunx biome ci .
bunx tsc --noEmit -p .
bun test
bun scripts/changelog.ts --check
python3 .sift/gate.py --base origin/main
python3 .sift/agents.py check
```

CI runs the same, plus actionlint, zizmor and gitleaks over the workflows and history.
`bun scripts/screenshots.tsx 2>/dev/null` re-renders `assets/*.png` from the real UI; run it after a
visible change. Every version needs a `CHANGELOG.md` entry (prose, bold-lead bullets) before its tag.

## Layout

- `src/sessions.ts` - discovery: `claude agents --json`, the Codex daemon (`src/codex.ts`), `pgrep`
  for the rest, then each process's place (kiln's tmux, a kitty window, background, elsewhere).
- `src/cloud.ts` - cached read-only Codex Cloud tasks; CLI refresh is asynchronous, at most every 60 s.
- `src/session-sort.ts` - list ordering, preserving parent/child groups.
- `src/app.tsx` - the whole UI and its keys.
- `src/tmux.ts`, `tmux.conf` - kiln's private tmux server (`tmux -L kiln`), no prefix, one detach key.
- `src/settings.ts` - `~/.config/kiln/config.toml`; unknown keys are errors.
- `prototypes/` - opt-in Pi socket extension and its protocol test; no automatic installation.
- `scripts/` - release, changelog, AUR PKGBUILD rendering, screenshots, standalone builds.
- `bun scripts/build.ts` builds Linux x64/arm64 into the generated dist directory; install with `--os linux --cpu "*"` first.
  The binaries embed OpenTUI assets and `tmux.conf`; AUR `kiln-agents-bin` needs no Bun.

## Rules

- Commits are signed (`git commit -S`) with the personal email, in Conventional Commits form.
- Activity is a closed set (`working`, `waiting`, `idle`); map each agent's own states onto it with an
  exhaustive switch, never a fallthrough guess.
- Anything that can fail at startup (a bad settings file) is reported before the TUI takes the
  screen; nothing prints to the console while it is up.
- README and changelog copy is plain and concrete: no marketing words, no em dashes.
- Quality: load `.agents/skills/sift-project/SKILL.md` before cleanup, dead-code or refactoring
  work.
