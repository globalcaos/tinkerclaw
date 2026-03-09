#!/usr/bin/env bash
# sync-from-tinkerclaw.sh — Rsync source from the GitHub fork into the workspace.
#
# ARCHITECTURE
# ────────────
# FORK     = ~/src/tinkerclaw        (GitHub, public)  — source of truth for code
# RUNTIME  = ~/.openclaw/workspace   (GitLab, private) — runs the gateway
#
# This script copies code FROM fork TO runtime. One-way only.
# Personal files in runtime (memory/, bank/, SOUL.md, etc.) are never touched.
# Runtime content never flows back to the fork.
#
# WHAT GETS SYNCED
# ────────────────
# Directories (with --delete to prune stale files):
#   src/, extensions/, vendor/, docs/, git-hooks/, dist/
#
# Individual files (config/tooling):
#   package.json, pnpm-lock.yaml, tsconfig*.json, tsdown.config.ts,
#   vitest*.config.ts, openclaw.mjs, CHANGELOG.md, FORK_PATCHES.md, etc.
#
# WHAT IS PRESERVED (never overwritten)
# ──────────────────────────────────────
# memory/, bank/, data/, avatars/, skills/, .agents/, tinker-ui/
# SOUL.md, USER.md, MEMORY.md, IDENTITY.md, VOICE.md, TOOLS.md, AGENTS.md, etc.
# *.db, *.sqlite, .env*
#
# FLAGS
# ─────
#   --no-build  Skip the workspace rebuild (useful when caller builds separately)
#   --dry-run   Show what would change without modifying files

set -euo pipefail

export PATH="$HOME/.local/share/pnpm:$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"

# ── Configuration ──

readonly FORK_DIR="$HOME/src/tinkerclaw"
readonly RUNTIME_DIR="$HOME/.openclaw/workspace"

skip_build=false
dry_run=false

for arg in "$@"; do
  case "$arg" in
    --no-build) skip_build=true ;;
    --dry-run)  dry_run=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

log()      { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
log_ok()   { log "  ✅ $*"; }
log_warn() { log "  ⚠️  $*"; }

# ── Preflight checks ──

if [ ! -d "$FORK_DIR/.git" ]; then
  echo "ERROR: Fork repo not found at $FORK_DIR"
  exit 1
fi

if [ ! -d "$RUNTIME_DIR" ]; then
  echo "ERROR: Runtime dir not found at $RUNTIME_DIR"
  exit 1
fi

fork_head=$(cd "$FORK_DIR" && git log --oneline -1)
fork_version=$(grep '"version"' "$FORK_DIR/package.json" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
runtime_version=$(grep '"version"' "$RUNTIME_DIR/package.json" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')

log "Fork HEAD:        $fork_head"
log "Fork version:     $fork_version"
log "Runtime version:  $runtime_version"

# ── Directories to sync (with --delete to remove stale files) ──

readonly SYNC_DIRS=(
  src/
  extensions/
  vendor/
  docs/
  git-hooks/
)

# ── Individual files to sync (config, tooling, entrypoint) ──

readonly SYNC_FILES=(
  package.json
  pnpm-lock.yaml
  tsconfig.json
  tsconfig.plugin-sdk.dts.json
  tsdown.config.ts
  vitest.config.ts
  vitest.unit.config.ts
  vitest.e2e.config.ts
  vitest.channels.config.ts
  vitest.extensions.config.ts
  vitest.gateway.config.ts
  vitest.live.config.ts
  vitest.scoped-config.ts
  openclaw.mjs
  CHANGELOG.md
  FORK_PATCHES.md
  zizmor.yml
  knip.config.ts
)

# ── Rsync ──

rsync_base_opts=(-a --delete)
$dry_run && rsync_base_opts+=(--dry-run -v) && log "DRY RUN — no files will be changed"

log "Syncing source from fork → runtime..."

for dir in "${SYNC_DIRS[@]}"; do
  if [ -d "$FORK_DIR/$dir" ]; then
    log "  $dir"
    rsync "${rsync_base_opts[@]}" "$FORK_DIR/$dir" "$RUNTIME_DIR/$dir"
  fi
done

for f in "${SYNC_FILES[@]}"; do
  [ -f "$FORK_DIR/$f" ] && rsync -a "$FORK_DIR/$f" "$RUNTIME_DIR/$f"
done

# Sync pre-built dist/ (avoids redundant rebuild if fork already built)
if [ -d "$FORK_DIR/dist" ]; then
  log "  dist/"
  rsync "${rsync_base_opts[@]}" "$FORK_DIR/dist/" "$RUNTIME_DIR/dist/"
fi

# ── Install dependencies if lockfile changed ──

if [ ! -d "$RUNTIME_DIR/node_modules" ] \
   || [ "$RUNTIME_DIR/pnpm-lock.yaml" -nt "$RUNTIME_DIR/node_modules/.modules.yaml" ]; then
  log "Installing dependencies..."
  cd "$RUNTIME_DIR"
  pnpm install --frozen-lockfile 2>&1 | tail -3
fi

# ── Build ──

if ! $skip_build && ! $dry_run; then
  log "Building in runtime..."
  cd "$RUNTIME_DIR"
  rm -rf dist/.cache node_modules/.cache

  if pnpm build 2>&1 | tail -10; then
    log_ok "Build passed"
  else
    log_warn "Build failed — check output above"
    exit 1
  fi
fi

# ── Commit changes in runtime ──

if ! $dry_run; then
  cd "$RUNTIME_DIR"
  git add -u 2>/dev/null || true
  git add -A --ignore-errors 2>/dev/null || true

  staged_count=$(git diff --cached --name-only | wc -l)
  if [ "$staged_count" -gt 0 ]; then
    log "Committing $staged_count changed files..."
    git commit --no-verify \
      -m "chore: sync from tinkerclaw ($fork_version)

Source: $fork_head" || true
    log_ok "Committed"
  else
    log "No changes to commit"
  fi
fi

log "Done. Runtime now at version $fork_version"
