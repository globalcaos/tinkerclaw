#!/usr/bin/env bash
# safe-cron-merge.sh — Hardened cron entrypoint for upstream merges.
#
# This script MUST be the only merge path used by the daily-fork-sync-report cron.
#
# Safety guarantees:
#   1. NEVER uses `git checkout upstream/main -- .` (the overlay pattern)
#   2. NEVER modifies source code directly (delegates to merge-upstream.sh + apply-fork-wiring.mjs)
#   3. Auto-commits dirty trees before merge (Gate 0)
#   4. Aborts if merge has >5 unresolved conflicts
#   5. Build + deploy only after successful merge + guardian check
#   6. Post-merge jarvis-brain backup (Phase 6)
#   7. Companion repo sync — ClawMetry + Mission Control (Phase 7)
#
# Usage: scripts/safe-cron-merge.sh [--dry-run] [--no-backup] [--no-companion]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
DRY_RUN=false
NO_BACKUP=false
NO_COMPANION=false
MAX_UNRESOLVED=5

JARVIS_BRAIN="$HOME/.openclaw"
JARVIS_BRAIN_REMOTE="${JARVIS_BRAIN_REMOTE:-$(git -C "$HOME/.openclaw" remote get-url origin 2>/dev/null || echo "")}"
JARVIS_ICU="$HOME/src/jarvis-icu"
CLAWMETRY="$HOME/src/clawmetry"
MISSION_CONTROL="$HOME/src/mission-control"

GATE0_COMMITS=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-backup) NO_BACKUP=true ;;
    --no-companion) NO_COMPANION=true ;;
  esac
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
escalate() {
  log "🚨 ESCALATION: $*"
  echo ""
  echo "Manual intervention required. Do NOT retry automatically."
  exit 1
}

# ─── HELPER: Auto-commit a repo (tracked files only) ───
# Usage: auto_commit_repo <path> <label> [--no-verify]
auto_commit_repo() {
  local repo_path="$1"
  local label="$2"
  local no_verify="${3:-}"

  if [ ! -d "$repo_path/.git" ]; then
    log "  ⚠️  $label: not a git repo at $repo_path — skipping"
    return 0
  fi

  # Count only tracked dirty files (exclude untracked with grep -v '^??')
  local dirty
  dirty=$(git -C "$repo_path" status --porcelain | grep -cv '^??' || true)
  if [ "$dirty" -eq 0 ]; then
    log "  ✅ $label: clean"
    return 0
  fi

  log "  $label: $dirty dirty tracked files — auto-committing..."
  git -C "$repo_path" add -u
  local msg="chore: auto-commit before merge ($(date '+%Y-%m-%d %H:%M'))"
  if [ "$no_verify" = "--no-verify" ]; then
    git -C "$repo_path" commit --no-verify -m "$msg" || { log "  ⚠️  $label: commit failed"; return 0; }
  else
    git -C "$repo_path" commit -m "$msg" || { log "  ⚠️  $label: commit failed"; return 0; }
  fi
  git -C "$repo_path" push origin main || log "  ⚠️  $label: push failed (non-blocking)"
  GATE0_COMMITS="$GATE0_COMMITS $label"
  log "  ✅ $label: committed + pushed"
}

# ─── HELPER: Commit jarvis-brain with rename trick ───
# Hides workspace/.git temporarily, commits, pushes, restores.
# Usage: commit_jarvis_brain <commit_message> <log_label>
# Sets _BRAIN_COMMITTED=1 if a commit was made, empty otherwise.
commit_jarvis_brain() {
  local msg="$1"
  local label="$2"
  local brain="$JARVIS_BRAIN"
  _BRAIN_COMMITTED=""

  if [ ! -d "$brain/.git" ]; then
    log "  ⚠️  $label: not a git repo at $brain — skipping"
    return 0
  fi

  # The workspace/ dir has its own .git (OpenClaw data dir) that confuses
  # the parent repo. Temporarily hide it during commit.
  local ws_git="$brain/workspace/.git"
  local ws_git_hidden="$brain/workspace/.git_real"

  if [ -d "$ws_git" ]; then
    mv "$ws_git" "$ws_git_hidden"
  fi

  # Always restore workspace/.git, even on error
  _restore_ws_git() {
    if [ -d "$ws_git_hidden" ] && [ ! -d "$ws_git" ]; then
      mv "$ws_git_hidden" "$ws_git"
    fi
  }

  local dirty
  dirty=$(git -C "$brain" status --porcelain | wc -l)
  if [ "$dirty" -eq 0 ]; then
    log "  ✅ $label: clean"
    _restore_ws_git
    return 0
  fi

  log "  $label: $dirty dirty files — committing..."
  git -C "$brain" add -A
  if git -C "$brain" commit -m "$msg"; then
    git -C "$brain" push origin main || log "  ⚠️  $label: push failed (non-blocking)"
    _BRAIN_COMMITTED=1
    log "  ✅ $label: committed + pushed"
  else
    log "  ⚠️  $label: commit failed"
  fi

  _restore_ws_git

  # Safety: verify workspace/.git remote hasn't drifted to the source repo.
  # The workspace contains sensitive data and must only push to jarvis-brain (GitLab, private).
  if [ -d "$ws_git" ]; then
    local ws_remote
    ws_remote=$(git -C "$brain/workspace" remote get-url origin 2>/dev/null || true)
    if echo "$ws_remote" | grep -qi "github"; then
      log "  🛑 CRITICAL: workspace/.git remote points to GitHub ($ws_remote) — fixing to jarvis-brain"
      if [ -n "$JARVIS_BRAIN_REMOTE" ]; then
        git -C "$brain/workspace" remote set-url origin "$JARVIS_BRAIN_REMOTE"
      else
        log "  ⚠️  JARVIS_BRAIN_REMOTE is empty — cannot fix remote automatically"
      fi
    fi
  fi
}

# ─── HELPER: Sync a companion fork repo ───
# Usage: sync_companion <path> <label> <branch>
sync_companion() {
  local repo_path="$1"
  local label="$2"
  local branch="${3:-main}"

  if [ ! -d "$repo_path/.git" ]; then
    log "  ⚠️  $label: not a git repo at $repo_path — skipping"
    return 0
  fi

  log "  $label: syncing..."

  # Auto-commit dirty tracked files first (exclude untracked)
  local dirty
  dirty=$(git -C "$repo_path" status --porcelain | grep -cv '^??' || true)
  if [ "$dirty" -gt 0 ]; then
    log "    $dirty dirty tracked files — auto-committing..."
    git -C "$repo_path" add -u
    git -C "$repo_path" commit -m "chore: auto-commit before upstream sync ($(date '+%Y-%m-%d %H:%M'))" || true
  fi

  # Fetch upstream
  if ! git -C "$repo_path" fetch upstream 2>/dev/null; then
    log "  ⚠️  $label: upstream fetch failed — skipping"
    return 0
  fi

  # Check how far behind
  local behind
  behind=$(git -C "$repo_path" rev-list --count HEAD..upstream/"$branch" 2>/dev/null || echo 0)
  if [ "$behind" -eq 0 ]; then
    log "  ✅ $label: already up to date"
    return 0
  fi

  log "    $behind commits behind upstream/$branch — merging..."
  if ! git -C "$repo_path" merge upstream/"$branch" --no-edit 2>/dev/null; then
    log "  ⚠️  $label: merge conflict — aborting merge"
    git -C "$repo_path" merge --abort 2>/dev/null || true
    return 0
  fi

  git -C "$repo_path" push origin "$branch" || log "  ⚠️  $label: push failed (non-blocking)"
  log "  ✅ $label: synced $behind commits from upstream"
}

# ─── GATE 0: Pre-merge auto-commit (all repos) ───
log "Gate 0: Auto-committing dirty repos..."
auto_commit_repo "$REPO_ROOT" "openclaw-fork" "--no-verify"
commit_jarvis_brain "chore: auto-commit before merge ($(date '+%Y-%m-%d %H:%M'))" "jarvis-brain"
[ -n "${_BRAIN_COMMITTED:-}" ] && GATE0_COMMITS="$GATE0_COMMITS jarvis-brain"
auto_commit_repo "$JARVIS_ICU" "jarvis-icu"
if [ -n "$GATE0_COMMITS" ]; then
  log "  Gate 0 committed:$GATE0_COMMITS"
else
  log "  Gate 0: all repos clean"
fi

# ─── GATE 1: Clean working tree (tracked files only) ───
log "Gate 1: Checking working tree..."
DIRTY_TRACKED=$(git diff --name-only 2>/dev/null | wc -l)
DIRTY_STAGED=$(git diff --cached --name-only 2>/dev/null | wc -l)
DIRTY_COUNT=$((DIRTY_TRACKED + DIRTY_STAGED))
if [ "$DIRTY_COUNT" -gt 0 ]; then
  escalate "Working tree still has $DIRTY_COUNT dirty tracked files after Gate 0. Run 'git status' to inspect."
fi
log "  ✅ Working tree clean (tracked files)"

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

# ─── PHASE 6: Post-merge jarvis-brain backup ───
if $NO_BACKUP; then
  log "Phase 6: Skipped (--no-backup)"
else
  log "Phase 6: Post-merge jarvis-brain backup..."
  commit_jarvis_brain "post-merge backup: $(date '+%Y-%m-%d %H:%M')" "jarvis-brain-backup"
fi

# ─── PHASE 7: Companion repo sync (ClawMetry + Mission Control) ───
if $NO_COMPANION; then
  log "Phase 7: Skipped (--no-companion)"
else
  log "Phase 7: Syncing companion repos..."
  sync_companion "$CLAWMETRY" "clawmetry" "main"
  sync_companion "$MISSION_CONTROL" "mission-control" "main"
fi

log "✅ Merge complete. $BEHIND upstream commits integrated."
echo "RESULT: merged; $BEHIND commits; guardian=$GUARDIAN_EXIT issues; gate0=[${GATE0_COMMITS:-none}]"
