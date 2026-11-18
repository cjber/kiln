#!/usr/bin/env bash
# Fast local gate for the branch's changed files: biome on them, tsc, then the tests named for them.
set -euo pipefail
base=$(git merge-base origin/main HEAD)
mapfile -t files < <(git diff --name-only --diff-filter=d "$base" -- '*.ts' '*.tsx' '*.js' '*.json')
if [ "${#files[@]}" -gt 0 ]; then bunx biome ci "${files[@]}"; fi
bunx tsc --noEmit -p .
tests=()
for f in "${files[@]}"; do
  case "$f" in
    *.test.ts|*.test.tsx) tests+=("$f") ;;
    src/*.ts|src/*.tsx) for t in "${f%.*}.test.ts" "${f%.*}.test.tsx"; do [ -f "$t" ] && tests+=("$t"); done ;;
  esac
done
if [ "${#tests[@]}" -gt 0 ]; then bun test "${tests[@]}"; fi
bun scripts/changelog.ts --check
