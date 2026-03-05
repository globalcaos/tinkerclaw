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
log "Phase 2: Running merge-guardian.sh --fix --learn --no-build..."
GUARDIAN_EXIT=0
bash scripts/merge-guardian.sh --fix --learn --no-build || GUARDIAN_EXIT=$?

if [ "$GUARDIAN_EXIT" -gt 3 ]; then
  escalate "Guardian found $GUARDIAN_EXIT issues after --fix. Manual review needed."
fi
log "  Guardian result: $GUARDIAN_EXIT issues"

# ─── PHASE 3: Build (with self-healing retry) ───
log "Phase 3: Building..."
rm -rf dist/.cache node_modules/.cache

BUILD_LOG="/tmp/merge-cron-build.log"
BUILD_PASS=false

if pnpm build > "$BUILD_LOG" 2>&1; then
  BUILD_PASS=true
  log "  ✅ Build passed (first attempt)"
else
  log "  ⚠️  Build failed. Classifying errors and attempting self-heal..."

  # ─── Classify build errors against the 8 playbook categories ───
  KNOWN_ERRORS=0
  UNKNOWN_ERRORS=0
  CLASSIFIED=""

  if grep -q '__filename is not defined' "$BUILD_LOG" 2>/dev/null; then
    CLASSIFIED="$CLASSIFIED [1:__filename_ESM]"
    ((KNOWN_ERRORS++)) || true
  fi
  if grep -q "Cannot find.*fork/" "$BUILD_LOG" 2>/dev/null; then
    CLASSIFIED="$CLASSIFIED [2:wrong_import_depth]"
    ((KNOWN_ERRORS++)) || true
  fi
  if grep -q "has no exported member.*MessageKey" "$BUILD_LOG" 2>/dev/null; then
    CLASSIFIED="$CLASSIFIED [3:MessageKey_missing]"
    ((KNOWN_ERRORS++)) || true
  fi
  if grep -q "syncFullHistory.*does not exist" "$BUILD_LOG" 2>/dev/null; then
    CLASSIFIED="$CLASSIFIED [4:syncFullHistory_type]"
    ((KNOWN_ERRORS++)) || true
  fi
  if grep -q "not assignable to type.*ActiveWebListener" "$BUILD_LOG" 2>/dev/null; then
    CLASSIFIED="$CLASSIFIED [5:ActiveWebListener_cast]"
    ((KNOWN_ERRORS++)) || true
  fi
  if grep -q "authProfileId.*does not exist" "$BUILD_LOG" 2>/dev/null; then
    CLASSIFIED="$CLASSIFIED [6:authProfileId_missing]"
    ((KNOWN_ERRORS++)) || true
  fi
  if grep -q "Cannot find name.*forkAttemptHooks\|fork/attempt-hooks" "$BUILD_LOG" 2>/dev/null; then
    CLASSIFIED="$CLASSIFIED [7:fork_hooks_wiped]"
    ((KNOWN_ERRORS++)) || true
  fi
  if grep -q "Cannot find module.*better-sqlite3" "$BUILD_LOG" 2>/dev/null; then
    CLASSIFIED="$CLASSIFIED [8:missing_deps]"
    ((KNOWN_ERRORS++)) || true
  fi

  # Count unclassified TS errors
  TOTAL_TS_ERRORS=$(grep -cE "error TS[0-9]+" "$BUILD_LOG" 2>/dev/null || echo 0)
  UNKNOWN_ERRORS=$((TOTAL_TS_ERRORS - KNOWN_ERRORS))
  if [ "$UNKNOWN_ERRORS" -lt 0 ]; then UNKNOWN_ERRORS=0; fi

  log "  Error classification: ${KNOWN_ERRORS} known${CLASSIFIED}, ${UNKNOWN_ERRORS} unknown"

  # ─── Self-heal: re-run wiring + guardian, then retry build ───
  log "  Re-running apply-fork-wiring.mjs..."
  node scripts/apply-fork-wiring.mjs || log "  ⚠️  Wiring script had warnings"

  log "  Re-running merge-guardian.sh --fix --no-build..."
  bash scripts/merge-guardian.sh --fix --no-build || true

  # Commit any wiring fixes before rebuilding
  if [ -n "$(git status --porcelain)" ]; then
    log "  Committing self-heal patches..."
    git add -u
    git commit -m "chore(fork): self-heal build after upstream merge

Applied by safe-cron-merge.sh auto-recovery.
Classified errors:${CLASSIFIED:-" none"}
" --no-verify || true
  fi

  log "  Retrying build..."
  rm -rf dist/.cache node_modules/.cache
  if pnpm build > "$BUILD_LOG" 2>&1; then
    BUILD_PASS=true
    log "  ✅ Build passed (second attempt, after self-heal)"
  fi
fi

if ! $BUILD_PASS; then
  # Save build log for postmortem
  FAIL_LOG="/tmp/merge-cron-build-fail-$(date +%Y%m%d-%H%M%S).log"
  cp "$BUILD_LOG" "$FAIL_LOG"

  # Extract top errors for the escalation message
  TOP_ERRORS=$(grep -E "error TS[0-9]+" "$BUILD_LOG" 2>/dev/null | head -10)

  escalate "Build failed after self-heal retry. Errors:${CLASSIFIED:-" unclassified"}. Unknown: ${UNKNOWN_ERRORS:-?}. Log: $FAIL_LOG
Top errors:
$TOP_ERRORS"
fi

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
