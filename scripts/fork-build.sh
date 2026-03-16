#!/usr/bin/env bash
# FORK: Build gateway and write .buildstamp so run-node.mjs skips rebuild on restart.
#
# Usage:
#   ./scripts/fork-build.sh          # incremental build
#   ./scripts/fork-build.sh --clean  # clear cache first (NOT dist — preserves stamp)
#
# Why this exists: running `npx tsdown` directly doesn't write dist/.buildstamp.
# Without the stamp, every gateway restart triggers a full 2.5 min rebuild.

set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf dist/.cache node_modules/.cache
  echo "[fork-build] Cleared caches"
fi

echo "[fork-build] Building..."
npx tsdown 2>&1 | tail -3

# Write build stamp (same format as run-node.mjs)
HEAD=$(git rev-parse HEAD)
echo "{\"builtAt\":$(date +%s000),\"head\":\"$HEAD\"}" > dist/.buildstamp
echo "[fork-build] Stamp written (HEAD: ${HEAD:0:10})"
