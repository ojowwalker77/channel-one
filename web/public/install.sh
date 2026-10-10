#!/bin/sh
# Installs kiwi, the Kiwi Init command line, for macOS and Linux.
#
# What it does, in order:
#   1. picks the build for this computer (macOS or Linux, Intel or ARM)
#   2. downloads it from this project's GitHub release, built from the public source
#   3. checks its SHA-256 against the release's SHA256SUMS before installing
#   4. puts it at ~/.kiwi/bin/kiwi (nothing outside your home folder, no sudo)
# SHA256SUMS comes from the same release as the binary. It catches a bad
# download, not a release that was swapped. The `gh attestation verify`
# line at the end is printed for you to run; this script does not run it.
# Read the source: https://github.com/ojowwalker77/channels
set -eu

REPO="ojowwalker77/channels"
VERSION="${KIWI_VERSION:-latest}"
DIR="${KIWI_INSTALL:-$HOME/.kiwi/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "kiwi: $os isn't supported by this script. On Windows, in PowerShell: irm https://channels.kiwiinit.com/install.ps1 | iex" >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "kiwi: no build for $arch" >&2; exit 1 ;;
esac
asset="kiwi-$os-$arch"
if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"; else base="https://github.com/$REPO/releases/download/$VERSION"; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset ($VERSION) from github.com/$REPO"
curl -fsSL "$base/$asset" -o "$tmp/kiwi"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

want=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/kiwi" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/kiwi" | cut -d' ' -f1); fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  echo "kiwi: checksum doesn't match the release; not installing" >&2
  exit 1
fi

# ~/.kiwi is private to this account. bin stays 0755 inside that parent.
# A symlink is left alone: chmod would follow it.
if [ -z "${KIWI_INSTALL:-}" ]; then
  if [ ! -e "$HOME/.kiwi" ]; then
    mkdir -m 700 "$HOME/.kiwi"
  elif [ -d "$HOME/.kiwi" ] && [ ! -L "$HOME/.kiwi" ]; then
    chmod 700 "$HOME/.kiwi"
  fi
fi
mkdir -p "$DIR"
mv "$tmp/kiwi" "$DIR/kiwi"
chmod 755 "$DIR/kiwi"
echo "Installed kiwi $("$DIR/kiwi" --version) at $DIR/kiwi (checksum verified)"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "To run it as plain \`kiwi\`, add this to your shell profile: export PATH=\"$DIR:\$PATH\"" ;;
esac
echo "Check where it came from: gh attestation verify $DIR/kiwi --repo $REPO"
