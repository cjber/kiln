#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  x64|arm64) ;;
  *) printf '%s\n' 'usage: bash scripts/check-binary-package.sh <x64|arm64>' >&2; exit 2 ;;
esac

package_scratch=$(mktemp -d)
trap 'command rm -rf "$package_scratch"' EXIT
version=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
git archive --format=tar.gz --prefix="kiln-$version/" -o "$package_scratch/source.tar.gz" HEAD
cp dist/kiln-linux-x64 dist/kiln-linux-arm64 "$package_scratch/"
bun scripts/render-aur.ts --version "$version" \
  --sha256 "$(sha256sum "$package_scratch/source.tar.gz" | cut -d' ' -f1)" \
  --bin-x64-sha256 "$(sha256sum dist/kiln-linux-x64 | cut -d' ' -f1)" \
  --bin-arm64-sha256 "$(sha256sum dist/kiln-linux-arm64 | cut -d' ' -f1)" \
  --out "$package_scratch/aur"

docker run --rm -i -v "$package_scratch:/work" archlinux:base bash -s <<'ARCH'
set -euo pipefail
pacman -Syu --noconfirm --needed base-devel tmux fzf
useradd -m builder
chown -R builder:builder /work
for directory in /work/aur /work/aur/bin; do
  diff -u <(sed '/^$/d' "$directory/.SRCINFO" | LC_ALL=C sort) \
    <(su builder -c "cd $directory && makepkg --printsrcinfo" | sed '/^$/d' | LC_ALL=C sort)
done

# Substitute only URLs; makepkg still verifies the real source and binary digests.
sed -i \
  -e 's|https://github.com/cjber/kiln/archive/refs/tags/v${pkgver}.tar.gz|file:///work/source.tar.gz|' \
  -e 's|https://github.com/cjber/kiln/releases/download/v${pkgver}/kiln-linux-x64|file:///work/kiln-linux-x64|' \
  -e 's|https://github.com/cjber/kiln/releases/download/v${pkgver}/kiln-linux-arm64|file:///work/kiln-linux-arm64|' \
  /work/aur/bin/PKGBUILD
su builder -c 'cd /work/aur/bin && makepkg --nodeps --force --noconfirm'
pacman -U --noconfirm /work/aur/bin/*.pkg.tar.zst
if command -v bun; then printf '%s\n' 'binary package test must run without Bun' >&2; exit 1; fi
kiln --version
kiln status
trap 'tmux -L kiln-package-smoke kill-server 2>/dev/null || true' EXIT
tmux -L kiln-package-smoke -f /dev/null new-session -d -s list -x 100 -y 20 /usr/bin/kiln
for attempt in {1..50}; do
  if tmux -L kiln-package-smoke capture-pane -p -t list | grep -q 'q quit'; then
    printf '%s\n' 'rendered metadata, makepkg checksums, installed version/status and native TUI passed without Bun'
    exit 0
  fi
  sleep 0.2
done
printf '%s\n' 'installed binary TUI did not start' >&2
exit 1
ARCH
