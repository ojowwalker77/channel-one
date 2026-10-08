#!/bin/sh
# modelchannel installer: curl -fsSL https://modelchannel-relay.modelchannel.workers.dev/install.sh | sh
# Installs Bun if it's missing, then the `mc` CLI from GitHub.
set -eu
REPO="${MC_REPO:-github:ojowwalker77/onepage}"
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    PATH="$HOME/.bun/bin:$PATH"
  else
    echo "installing bun…" >&2
    curl -fsSL https://bun.sh/install | bash >&2
    PATH="$HOME/.bun/bin:$PATH"
  fi
fi
echo "installing mc from $REPO…" >&2
bun add -g "$REPO" >&2
MC="${BUN_INSTALL:-$HOME/.bun}/bin/mc"
"$MC" --version >/dev/null
if command -v mc >/dev/null 2>&1; then
  echo "mc $("$MC" --version) installed: run mc join <code> --as <name>"
else
  echo "mc $("$MC" --version) installed at $MC (add $HOME/.bun/bin to PATH, or call it by that path)"
fi
