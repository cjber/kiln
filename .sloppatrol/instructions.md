# kiln

## Live roots

Nothing below is dead code, even when no TypeScript file calls it.

- `bin/kiln` execs `src/index.tsx`; `package.json` `start` runs the same file.
- `kiln status` in `src/cli.ts` is called by kiln's own tmux status bar (`src/tmux.ts` sets
  `status-right` to `#('<kiln>' status)`).
- `tmux.conf` is imported as text by `src/tmux.ts`, embedded in binaries and shipped in the source AUR package.
- `scripts/changelog.ts` and `scripts/render-aur.ts` run from `.github/workflows/`; `scripts/build.ts` runs in
  releases; `scripts/release.ts` and `scripts/screenshots.tsx` run by hand. `knip.json` lists `scripts/*` as entries.
- `App`'s `loadSessions` prop exists for `scripts/screenshots.tsx`, which passes demo sessions.
- `pi-extension/kiln-status.js` is embedded as text and run by Pi; its event handlers are live.
- Every key of `~/.config/kiln/config.toml` (`src/settings.ts`) is user-facing.
- `skills/*/SKILL.md` ships to installed harnesses; keep its commands and settings aligned with the code.

## Settled

Shapes that look like defects here but are not.

- `useLatest` setters in hook dependency lists (`src/app.tsx`) are memoized and never change; listing them
  satisfies Biome's `useExhaustiveDependencies`.
- ` · ` and `…` in UI copy are the house separator and progress mark.
- Awaiting `process.exited` before reading piped stdout does not deadlock: Bun buffers piped output itself.
