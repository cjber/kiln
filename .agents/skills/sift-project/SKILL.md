---
name: sift-project
description: "Project skill for sift in kiln: the exact quality-gate and evidence commands, live roots that must never be deleted as dead code, exclusions, conventions and risk order. Load before running sift or any code-quality, cleanup or dead-code work in this repository."
---

# sift project skill: kiln

kiln is a Bun + TypeScript terminal UI (OpenTUI React) that lists every interactive Claude Code,
Codex and Pi session on a Linux machine and takes you to the one you pick. It runs from source under
Bun (`bin/kiln` execs `src/index.tsx`); the source package is unbundled. `scripts/build.ts` also compiles Linux x64/arm64 binaries
with embedded OpenTUI assets and tmux configuration for `kiln-agents-bin`. Arch users install it from the AUR as
`kiln-agents`: a `v*` tag publishes a PKGBUILD (`scripts/render-aur.ts`) that copies `bin`, `src`,
`node_modules` (production install), `package.json` and `tmux.conf`. No other repository imports it.

## Gate

Run in order from the repository root. All must pass (exit 0) before and after any audit slice.
CI's required `check` job runs exactly this list.

```sh
bun install --frozen-lockfile
bunx biome ci .                            # format + lint; `bunx biome check --write .` fixes
bunx tsc --noEmit -p .                     # strict
bun test                                   # src/*.test.ts
bun scripts/changelog.ts --check           # every tagged version has a CHANGELOG.md entry
python3 .sift/gate.py --base origin/main   # project rules and `sift:` markers
python3 .sift/agents.py check              # AGENTS.md is complete and not stale
```

CI also runs `actionlint` and `zizmor --offline .github` (job `workflows`) and gitleaks over the
history (job `secrets`). Locally, `gitleaks git` scans every local ref, including other worktrees'
branches; pass `--log-opts=HEAD` to scan only this branch.

Biome is pinned exactly in `package.json` (2.5.14) with the `recommended` preset in `biome.json`.

ast-grep pin: not needed while `.sift/rules/` is empty; when the first rule lands, CI installs it
with `uv tool install ast-grep-cli==0.44.1` after a SHA-pinned `astral-sh/setup-uv` step.

## Evidence

On-demand tools for audits. Output is candidates, never verdicts.

```sh
bunx knip@6.38.0                                          # unused files, exports, dependencies
bunx jscpd@5.3.3 src scripts --reporters console --silent # clones
```

Known false positives:

- knip: `knip.json` adds `scripts/*.{ts,tsx}` as entries, since they are run by hand or from
  workflows rather than imported. At setup it reported one candidate: the exported type `Place` in
  `src/sessions.ts`, used only inside that module (unverified).
- jscpd: 0 clones at setup.

## Live roots

Things reached indirectly. The dead-code lens must treat these as referenced.

- `bin/kiln` execs `src/index.tsx`; `package.json` `start` runs the same file.
- `src/cli.ts` `kiln status` is called by kiln's own tmux status bar (`src/tmux.ts` sets
  `status-right` to `#('<kiln>' status)`), so it has no caller in TypeScript.
- `tmux.conf` is imported as text by `src/tmux.ts`, embedded in binaries and written to a private
  temporary file when tmux needs it. It also ships in the source AUR package.
- `scripts/changelog.ts` and `scripts/render-aur.ts` run from `.github/workflows/`;
  `scripts/build.ts` runs in releases; `scripts/release.ts` and `scripts/screenshots.tsx` run by hand (README, AGENTS.md).
- `App`'s `loadSessions` prop exists for `scripts/screenshots.tsx`, which passes demo sessions.
- External formats parsed, not owned: `claude agents --json`, the Codex app-server JSON-RPC over
  `$CODEX_HOME/app-server-control/app-server-control.sock`, `kitty @ ls`, `pgrep`/`/proc`. Fields
  read from them look unused to a reader of kiln alone.
- Persisted data: `~/.config/kiln/config.toml` (`src/settings.ts`); every key is user-facing.

## Model-read text

None. kiln starts and lists agents but sends no prompts or tool descriptions to a model.

## Zones

How each part of the tree is reviewed. Unlisted paths are `production`.

| Path | Zone | Reason |
|---|---|---|
| `src/*.test.ts` | test | `bun test` |
| `scripts/` | script | release, changelog, AUR rendering, screenshots |
| `.github/`, `biome.json`, `knip.json`, `tsconfig.json`, `tmux.conf` | config | `tmux.conf` also ships |
| `README.md`, `CHANGELOG.md`, `AGENTS.md` | docs | user-facing copy |
| `assets/*.png` | generated | `bun scripts/screenshots.tsx` |
| `bun.lock` | generated | `bun install` |
| `.sift/gate.py`, `.sift/agents.py`, `.sift/LICENSE` | vendor | copied from sift; `sift update` replaces them |

## Conventions

- Closed sets are string-literal unions (`Agent`, `Activity`, `Place.kind`), mapped with exhaustive
  `switch`es; an unknown external status becomes `undefined` ("unknown"), never a guess.
- Failures before the TUI starts are printed and exit non-zero (`src/index.tsx`); nothing prints
  while the TUI owns the screen. Settings parsing throws on unknown keys.
- Comments are short doc comments stating why or what a value means; no narration.
- README and changelog copy is plain: no marketing words, no em dashes.

## Risk order

Audit slices from lowest to highest risk:

1. `scripts/`: developer and release tooling.
2. `src/zoxide.ts`, `src/kitty.ts`, `src/cli.ts`: small adapters.
3. `src/settings.ts`: user config parsing; errors are the contract.
4. `src/tmux.ts`, `tmux.conf`: kiln's private tmux server.
5. `src/codex.ts`, `src/sessions.ts`: discovery against other tools' formats.
6. `src/app.tsx`, `src/index.tsx`: the whole UI and key handling.

## Settled

Shapes that look like defects here but are not. Reviewers and verifiers read this before raising a
finding; audits add an entry when verifiers keep dismissing the same shape for the same reason.

- `useLatest` setters in hook dependency lists (`src/app.tsx`): they are memoized with an empty list
  and never change; listing them satisfies Biome's `useExhaustiveDependencies` without effect.

## Anti-patterns

Shapes this codebase has produced more than once and a reviewer confirmed. Check new code against
them. An audit guards a confirmed defect of one of these shapes with `settled:<name>`, which the
ledger checks against these names. An entry leaves when a rule enforces it or it has not recurred in
two audits.

## Project rules and lenses

- Rules already owned elsewhere (not duplicated in `.sift/`): Biome `recommended` preset;
  `tsc` strict; `scripts/changelog.ts --check` (a changelog entry per tag); `release.yml` checks the
  tag is on `main` and matches `package.json`.
- ast-grep rules: `.sift/rules/` (0): none yet
- Script rules: `.sift/scripts/` (0): none yet
- Lenses: `.sift/lenses/`: none yet
