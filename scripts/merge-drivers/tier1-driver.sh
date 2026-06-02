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
# In-repo, self-contained wiring script (resolved relative to this driver so it
# works regardless of cwd). Previously pointed at a non-existent
# $HOME/.openclaw/fork-scripts/ path + swallowed failures with `|| true`, so a
# broken re-wire silently no-op'd at merge time.
DRIVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIRING="$DRIVER_DIR/apply-fork-wiring.mjs"

# Accept upstream version
cp "$THEIRS" "$OURS"

# Re-apply fork wiring. Failure is LOUD: a missing script or a non-zero exit
# means fork wiring was NOT re-applied — surface it and fail the driver so the
# broken merge is visible instead of silently shipping unwired upstream code.
if [[ ! -f "$WIRING" ]]; then
  echo "tier1-driver: FATAL — fork-wiring script not found at $WIRING (cannot re-apply fork wiring for $PATH_NAME)" >&2
  exit 1
fi

cd "$FORK_DIR"
if ! node "$WIRING"; then
  echo "tier1-driver: FATAL — apply-fork-wiring.mjs failed; fork wiring NOT re-applied for $PATH_NAME" >&2
  exit 1
fi

exit 0
