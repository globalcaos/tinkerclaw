#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

# Package managers need both a lockfile AND package.json. Without package.json,
# pnpm-lock.yaml alone (e.g. a stale or cross-repo symlink — the jarvis-brain
# workspace symlinks tinkerclaw's lockfile but has no package.json of its own)
# leads pnpm into ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE and breaks pre-commit.
# Fall through to npx which can run ad-hoc without a local package.
if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && [[ -f "$ROOT_DIR/package.json" ]] && command -v pnpm >/dev/null 2>&1; then
  exec pnpm exec "$tool" "$@"
fi

if { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; } && [[ -f "$ROOT_DIR/package.json" ]] && command -v bun >/dev/null 2>&1; then
  exec bunx --bun "$tool" "$@"
fi

if [[ -f "$ROOT_DIR/package.json" ]] && command -v npm >/dev/null 2>&1; then
  exec npm exec -- "$tool" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx "$tool" "$@"
fi

echo "Missing package manager: pnpm, bun, or npm required." >&2
exit 1
