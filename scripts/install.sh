#!/bin/sh
# Install the mc binary to ~/.local/bin (override with PREFIX=/somewhere).
# Needs bun on PATH: https://bun.sh
set -eu
cd "$(dirname "$0")/.."
PREFIX="${PREFIX:-$HOME/.local}"
bun run build
mkdir -p "$PREFIX/bin"
install -m755 dist/mc "$PREFIX/bin/mc"
echo "installed to $PREFIX/bin/mc — make sure it is on your PATH:"
echo "  export PATH=\"\$PREFIX/bin:\$PATH\""
echo "then run:  mc create --as $USER"
