#!/usr/bin/env bash
# tier1-driver.sh — Custom merge driver for TIER1 files.
# Called by git: driver %O %A %B %L %P
# Accepts upstream (theirs), then re-applies fork wiring.
set -euo pipefail

BASE="$1"   # %O
OURS="$2"   # %A — we write result here
THEIRS="$3" # %B
PATH_NAME="${5:-unknown}"

FORK_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WIRING="$HOME/.openclaw/fork-scripts/apply-fork-wiring.mjs"

# Accept upstream version
cp "$THEIRS" "$OURS"

# Re-apply fork wiring if available
if [[ -f "$WIRING" ]]; then
  cd "$FORK_DIR"
  node "$WIRING" 2>/dev/null || true
fi

exit 0
