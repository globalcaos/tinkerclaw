#!/usr/bin/env bash
# safe-cron-merge.sh — Hardened cron entrypoint for upstream merges.
#
# This script MUST be the only merge path used by the daily-fork-sync-report cron.
#
# Safety guarantees:
#   1. NEVER uses `git checkout upstream/main -- .` (the overlay pattern)
#   2. NEVER modifies source code directly (delegates to merge-upstream.sh + apply-fork-wiring.mjs)
#   3. Aborts if working tree is dirty
#   4. Aborts if merge has >5 unresolved conflicts
#   5. Build + deploy only after successful merge + guardian check
#
# Usage: scripts/safe-cron-merge.sh [--dry-run]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
DRY_RUN=false
MAX_UNRESOLVED=5

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
  esac
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
escalate() {
  log "🚨 ESCALATION: $*"
  echo ""
  echo "Manual intervention required. Do NOT retry automatically."
  exit 1
}

# ─── GATE 1: Clean working tree ───
log "Gate 1: Checking working tree..."
DIRTY_COUNT=$(git status --porcelain | wc -l)
if [ "$DIRTY_COUNT" -gt 0 ]; then
  escalate "Working tree has $DIRTY_COUNT dirty files. Refusing to merge. Run 'git status' to inspect."
fi
log "  ✅ Working tree clean"

# ─── GATE 2: Fetch upstream ───
log "Gate 2: Fetching upstream..."
git fetch upstream

BEHIND=$(git rev-list --count HEAD..upstream/main)
log "  Commits behind: $BEHIND"

if [ "$BEHIND" -eq 0 ]; then
  log "  ✅ Already up to date. Nothing to do."
  echo "RESULT: up-to-date"
  exit 0
fi

if $DRY_RUN; then
  log "  DRY RUN complete. Would merge $BEHIND commits."
  echo "RESULT: dry-run; $BEHIND commits behind"
  exit 0
fi

# ─── PHASE 1: Merge via the proper script ───
log "Phase 1: Running merge-upstream.sh..."
MERGE_OK=true
if ! bash scripts/merge-upstream.sh; then
  MERGE_OK=false
fi

# Check for remaining unresolved conflicts
REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null | wc -l)
if [ "$REMAINING" -gt "$MAX_UNRESOLVED" ]; then
  git merge --abort 2>/dev/null || true
  escalate "merge-upstream.sh left $REMAINING unresolved conflicts (max $MAX_UNRESOLVED). Merge aborted."
fi

# If there are remaining conflicts within the threshold, still escalate
# The cron should NOT resolve conflicts manually
if [ "$REMAINING" -gt 0 ]; then
  git merge --abort 2>/dev/null || true
  escalate "$REMAINING unresolved conflicts remain. Files: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ', '). Merge aborted."
fi

# Complete the merge if still in progress
if [ -f "$REPO_ROOT/.git/MERGE_HEAD" ]; then
  git commit --no-edit || escalate "Failed to complete merge commit."
fi

# ─── PHASE 2: Guardian check ───
log "Phase 2: Running merge-guardian.sh --fix --learn..."
GUARDIAN_EXIT=0
bash scripts/merge-guardian.sh --fix --learn || GUARDIAN_EXIT=$?

if [ "$GUARDIAN_EXIT" -gt 3 ]; then
  escalate "Guardian found $GUARDIAN_EXIT issues after --fix. Manual review needed."
fi
log "  Guardian result: $GUARDIAN_EXIT issues"

# ─── PHASE 3: Build ───
log "Phase 3: Building..."
rm -rf dist/.cache node_modules/.cache
if ! pnpm build 2>&1; then
  escalate "Build failed after merge. Do NOT deploy."
fi
log "  ✅ Build passed"

# ─── PHASE 4: Deploy ───
log "Phase 4: Restarting gateway..."
pkill -9 -f openclaw-gateway || true
sleep 2
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
sleep 3

# Quick health check
if ! pgrep -f openclaw-gateway > /dev/null; then
  escalate "Gateway failed to start after deploy. Check /tmp/openclaw-gateway.log"
fi
log "  ✅ Gateway running"

# ─── PHASE 5: Push ───
log "Phase 5: Pushing to origin..."
git push origin main
log "  ✅ Pushed"

log "✅ Merge complete. $BEHIND upstream commits integrated."
echo "RESULT: merged; $BEHIND commits; guardian=$GUARDIAN_EXIT issues"
