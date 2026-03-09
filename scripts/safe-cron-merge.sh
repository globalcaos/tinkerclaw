#!/usr/bin/env bash
# safe-cron-merge.sh — Hardened cron entrypoint for upstream merges.
#
# ARCHITECTURE:
#   ~/src/tinkerclaw (GitHub fork) — where upstream merges happen
#   ~/.openclaw/workspace (GitLab jarvis-brain) — where the gateway runs
#   These have UNRELATED git histories. We merge in tinkerclaw, then
#   rsync source to workspace via sync-from-tinkerclaw.sh.
#
# SAFETY:
#   - NEVER push workspace content to GitHub (contains personal data)
#   - NEVER use `git checkout upstream/main -- .`
#   - NEVER modify source code directly (delegates to merge-upstream.sh + apply-fork-wiring.mjs)
#   - Auto-commits dirty trees before merge (Gate 0)
#   - Aborts if merge has >5 unresolved conflicts
#   - Build in tinkerclaw first, then sync + rebuild in workspace
#   - Post-merge jarvis-brain backup (Phase 7)
#   - Companion repo sync (Phase 8)
#
# Usage: scripts/safe-cron-merge.sh [--dry-run] [--no-backup] [--no-companion]

set -euo pipefail

# Ensure pnpm/node are in PATH for non-interactive shells
export PATH="$HOME/.local/share/pnpm:$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"

WORKSPACE="$HOME/.openclaw/workspace"
TINKERCLAW="$HOME/src/tinkerclaw"
JARVIS_BRAIN="$HOME/.openclaw"
JARVIS_ICU="$HOME/src/jarvis-icu"
CLAWMETRY="$HOME/src/clawmetry"
MISSION_CONTROL="$HOME/src/mission-control"

DRY_RUN=false
NO_BACKUP=false
NO_COMPANION=false
MAX_UNRESOLVED=5
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
auto_commit_repo() {
  local repo_path="$1"
  local label="$2"
  local no_verify="${3:-}"

  if [ ! -d "$repo_path/.git" ]; then
    log "  ⚠️  $label: not a git repo at $repo_path — skipping"
    return 0
  fi

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
  # Push tinkerclaw to GitHub (public, code only)
  # Push other repos to their respective origins
  git -C "$repo_path" push origin main 2>/dev/null || log "  ⚠️  $label: push failed (non-blocking)"
  GATE0_COMMITS="$GATE0_COMMITS $label"
  log "  ✅ $label: committed + pushed"
}

# ─── HELPER: Commit jarvis-brain (workspace parent) ───
commit_jarvis_brain() {
  local msg="$1"
  local label="$2"
  local brain="$JARVIS_BRAIN"
  _BRAIN_COMMITTED=""

  if [ ! -d "$brain/.git" ]; then
    log "  ⚠️  $label: not a git repo at $brain — skipping"
    return 0
  fi

  # workspace/ has its own .git — hide it during parent commit
  local ws_git="$brain/workspace/.git"
  local ws_git_hidden="$brain/workspace/.git_real"

  if [ -d "$ws_git" ]; then
    mv "$ws_git" "$ws_git_hidden"
  fi

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
    git -C "$brain" push origin main 2>/dev/null || log "  ⚠️  $label: push failed (non-blocking)"
    _BRAIN_COMMITTED=1
    log "  ✅ $label: committed + pushed"
  else
    log "  ⚠️  $label: commit failed"
  fi

  _restore_ws_git
}

# ─── HELPER: Sync companion fork repos ───
sync_companion() {
  local repo_path="$1"
  local label="$2"
  local branch="${3:-main}"

  if [ ! -d "$repo_path/.git" ]; then
    log "  ⚠️  $label: not a git repo at $repo_path — skipping"
    return 0
  fi

  log "  $label: syncing..."
  local dirty
  dirty=$(git -C "$repo_path" status --porcelain | grep -cv '^??' || true)
  if [ "$dirty" -gt 0 ]; then
    log "    $dirty dirty tracked files — auto-committing..."
    git -C "$repo_path" add -u
    git -C "$repo_path" commit -m "chore: auto-commit before upstream sync ($(date '+%Y-%m-%d %H:%M'))" || true
  fi

  if ! git -C "$repo_path" fetch upstream 2>/dev/null; then
    log "  ⚠️  $label: upstream fetch failed — skipping"
    return 0
  fi

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

  git -C "$repo_path" push origin "$branch" 2>/dev/null || log "  ⚠️  $label: push failed (non-blocking)"
  log "  ✅ $label: synced $behind commits from upstream"
}

# ═══════════════════════════════════════════════════════════════════
# GATE 0: Pre-merge auto-commit (all repos)
# ═══════════════════════════════════════════════════════════════════
log "Gate 0: Auto-committing dirty repos..."
auto_commit_repo "$TINKERCLAW" "tinkerclaw" "--no-verify"
auto_commit_repo "$WORKSPACE" "workspace" "--no-verify"
commit_jarvis_brain "chore: auto-commit before merge ($(date '+%Y-%m-%d %H:%M'))" "jarvis-brain"
[ -n "${_BRAIN_COMMITTED:-}" ] && GATE0_COMMITS="$GATE0_COMMITS jarvis-brain"
auto_commit_repo "$JARVIS_ICU" "jarvis-icu"
if [ -n "$GATE0_COMMITS" ]; then
  log "  Gate 0 committed:$GATE0_COMMITS"
else
  log "  Gate 0: all repos clean"
fi

# ═══════════════════════════════════════════════════════════════════
# GATE 1: Clean working tree in tinkerclaw
# ═══════════════════════════════════════════════════════════════════
log "Gate 1: Checking tinkerclaw working tree..."
cd "$TINKERCLAW"
DIRTY_TRACKED=$(git diff --name-only 2>/dev/null | wc -l)
DIRTY_STAGED=$(git diff --cached --name-only 2>/dev/null | wc -l)
DIRTY_COUNT=$((DIRTY_TRACKED + DIRTY_STAGED))
if [ "$DIRTY_COUNT" -gt 0 ]; then
  escalate "Tinkerclaw has $DIRTY_COUNT dirty tracked files after Gate 0. Run 'git -C $TINKERCLAW status' to inspect."
fi
log "  ✅ Working tree clean (tracked files)"

# ═══════════════════════════════════════════════════════════════════
# GATE 2: Fetch upstream
# ═══════════════════════════════════════════════════════════════════
log "Gate 2: Fetching upstream..."
cd "$TINKERCLAW"
git fetch upstream

BEHIND=$(git rev-list --count HEAD..upstream/main)
log "  Commits behind: $BEHIND"

if [ "$BEHIND" -eq 0 ]; then
  log "  ✅ Already up to date. Nothing to merge."
  # Still sync to workspace in case tinkerclaw has changes not yet in workspace
  WORKSPACE_VERSION=$(grep '"version"' "$WORKSPACE/package.json" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
  TINKERCLAW_VERSION=$(grep '"version"' "$TINKERCLAW/package.json" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
  if [ "$WORKSPACE_VERSION" != "$TINKERCLAW_VERSION" ]; then
    log "  But workspace ($WORKSPACE_VERSION) differs from tinkerclaw ($TINKERCLAW_VERSION) — syncing..."
  else
    echo "RESULT: up-to-date"
    exit 0
  fi
fi

if $DRY_RUN; then
  log "  DRY RUN complete. Would merge $BEHIND commits."
  echo "RESULT: dry-run; $BEHIND commits behind"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════
# PHASE 1: Merge upstream in TINKERCLAW
# ═══════════════════════════════════════════════════════════════════
if [ "$BEHIND" -gt 0 ]; then
  log "Phase 1: Merging $BEHIND upstream commits in tinkerclaw..."
  cd "$TINKERCLAW"

  # Use merge-upstream.sh if it exists in tinkerclaw, otherwise inline
  if [ -f "$TINKERCLAW/scripts/merge-upstream.sh" ]; then
    MERGE_OK=true
    bash "$TINKERCLAW/scripts/merge-upstream.sh" || MERGE_OK=false
  else
    # Inline merge for tinkerclaw (simpler — it has proper git history)
    MERGE_OK=true
    if ! git merge upstream/main --no-edit; then
      MERGE_OK=false
    fi
  fi

  # Check for remaining unresolved conflicts
  REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null | wc -l)
  if [ "$REMAINING" -gt "$MAX_UNRESOLVED" ]; then
    git merge --abort 2>/dev/null || true
    escalate "Merge left $REMAINING unresolved conflicts (max $MAX_UNRESOLVED). Merge aborted in tinkerclaw."
  fi

  if [ "$REMAINING" -gt 0 ]; then
    git merge --abort 2>/dev/null || true
    escalate "$REMAINING unresolved conflicts remain: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ', '). Merge aborted."
  fi

  # Complete the merge if still in progress
  if [ -f "$TINKERCLAW/.git/MERGE_HEAD" ]; then
    git commit --no-edit || escalate "Failed to complete merge commit in tinkerclaw."
  fi

  log "  ✅ Merge complete in tinkerclaw"
fi

# ═══════════════════════════════════════════════════════════════════
# PHASE 2: Guardian check in tinkerclaw
# ═══════════════════════════════════════════════════════════════════
log "Phase 2: Running merge-guardian..."
cd "$TINKERCLAW"
GUARDIAN_EXIT=0
if [ -f "$TINKERCLAW/scripts/merge-guardian.sh" ]; then
  bash "$TINKERCLAW/scripts/merge-guardian.sh" --fix --learn --no-build || GUARDIAN_EXIT=$?
elif [ -f "$WORKSPACE/scripts/merge-guardian.sh" ]; then
  # Guardian might only be in workspace
  cd "$TINKERCLAW"
  bash "$WORKSPACE/scripts/merge-guardian.sh" --fix --learn --no-build || GUARDIAN_EXIT=$?
fi

if [ "$GUARDIAN_EXIT" -gt 3 ]; then
  escalate "Guardian found $GUARDIAN_EXIT issues after --fix. Manual review needed."
fi
log "  Guardian result: $GUARDIAN_EXIT issues"

# ═══════════════════════════════════════════════════════════════════
# PHASE 3: Build in tinkerclaw (with self-healing retry)
# ═══════════════════════════════════════════════════════════════════
log "Phase 3: Building in tinkerclaw..."
cd "$TINKERCLAW"
rm -rf dist/.cache node_modules/.cache

BUILD_LOG="/tmp/merge-cron-build.log"
BUILD_PASS=false

if pnpm build > "$BUILD_LOG" 2>&1; then
  BUILD_PASS=true
  log "  ✅ Build passed (first attempt)"
else
  log "  ⚠️  Build failed. Attempting self-heal..."

  # Re-run wiring + guardian
  if [ -f "$TINKERCLAW/scripts/apply-fork-wiring.mjs" ]; then
    node "$TINKERCLAW/scripts/apply-fork-wiring.mjs" || log "  ⚠️  Wiring script had warnings"
  fi
  if [ -f "$TINKERCLAW/scripts/merge-guardian.sh" ]; then
    bash "$TINKERCLAW/scripts/merge-guardian.sh" --fix --no-build || true
  fi

  # Commit any wiring fixes
  if [ -n "$(git -C "$TINKERCLAW" status --porcelain)" ]; then
    log "  Committing self-heal patches..."
    git -C "$TINKERCLAW" add -u
    git -C "$TINKERCLAW" commit -m "chore(fork): self-heal build after upstream merge" --no-verify || true
  fi

  log "  Retrying build..."
  rm -rf dist/.cache node_modules/.cache
  if pnpm build > "$BUILD_LOG" 2>&1; then
    BUILD_PASS=true
    log "  ✅ Build passed (second attempt, after self-heal)"
  fi
fi

if ! $BUILD_PASS; then
  FAIL_LOG="/tmp/merge-cron-build-fail-$(date +%Y%m%d-%H%M%S).log"
  cp "$BUILD_LOG" "$FAIL_LOG"

  # Classify errors for the escalation message
  CLASSIFIED=""
  TOTAL_TS_ERRORS=$(grep -cE "error TS[0-9]+" "$BUILD_LOG" 2>/dev/null || true)
  TOTAL_TS_ERRORS=${TOTAL_TS_ERRORS:-0}
  UNRESOLVED=$(grep -cE "\[UNRESOLVED_IMPORT\]" "$BUILD_LOG" 2>/dev/null || true)
  UNRESOLVED=${UNRESOLVED:-0}
  TOP_ERRORS=$(grep -E "error TS[0-9]+|\[UNRESOLVED_IMPORT\]" "$BUILD_LOG" 2>/dev/null | head -10)

  escalate "Build failed in tinkerclaw after self-heal. TS errors: $TOTAL_TS_ERRORS, Unresolved imports: $UNRESOLVED. Log: $FAIL_LOG
Top errors:
$TOP_ERRORS"
fi

# ═══════════════════════════════════════════════════════════════════
# PHASE 4: Push tinkerclaw to GitHub
# ═══════════════════════════════════════════════════════════════════
log "Phase 4: Pushing tinkerclaw to origin..."
cd "$TINKERCLAW"
git push origin main 2>/dev/null || log "  ⚠️  Push failed (non-blocking)"
log "  ✅ Pushed"

# ═══════════════════════════════════════════════════════════════════
# PHASE 5: Sync tinkerclaw → workspace
# ═══════════════════════════════════════════════════════════════════
log "Phase 5: Syncing tinkerclaw → workspace..."
if [ -f "$WORKSPACE/scripts/sync-from-tinkerclaw.sh" ]; then
  bash "$WORKSPACE/scripts/sync-from-tinkerclaw.sh"
else
  # Fallback: inline sync of essential dirs
  log "  sync-from-tinkerclaw.sh not found — running inline sync..."

  SYNC_DIRS=(src/ extensions/ vendor/ docs/ git-hooks/)
  SYNC_FILES=(package.json pnpm-lock.yaml tsconfig.json tsconfig.plugin-sdk.dts.json tsdown.config.ts openclaw.mjs CHANGELOG.md FORK_PATCHES.md)

  for dir in "${SYNC_DIRS[@]}"; do
    if [ -d "$TINKERCLAW/$dir" ]; then
      rsync -a --delete "$TINKERCLAW/$dir" "$WORKSPACE/$dir"
    fi
  done
  for f in "${SYNC_FILES[@]}"; do
    if [ -f "$TINKERCLAW/$f" ]; then
      rsync -a "$TINKERCLAW/$f" "$WORKSPACE/$f"
    fi
  done
  if [ -d "$TINKERCLAW/dist" ]; then
    rsync -a --delete "$TINKERCLAW/dist/" "$WORKSPACE/dist/"
  fi

  # Install deps and rebuild in workspace
  cd "$WORKSPACE"
  pnpm install --frozen-lockfile 2>&1 | tail -3 || true
  rm -rf dist/.cache node_modules/.cache
  pnpm build 2>&1 | tail -5 || log "  ⚠️  Workspace build failed"

  # Commit
  git -C "$WORKSPACE" add -u 2>/dev/null || true
  git -C "$WORKSPACE" add -A --ignore-errors 2>/dev/null || true
  local tc_ver
  tc_ver=$(grep '"version"' "$TINKERCLAW/package.json" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
  git -C "$WORKSPACE" commit -m "chore: sync from tinkerclaw ($tc_ver)" --no-verify 2>/dev/null || true
fi
log "  ✅ Workspace synced"

# ═══════════════════════════════════════════════════════════════════
# PHASE 6: Restart gateway
# ═══════════════════════════════════════════════════════════════════
log "Phase 6: Restarting gateway..."
# Use openclaw's own restart mechanism if available
if command -v openclaw >/dev/null 2>&1; then
  openclaw gateway restart 2>/dev/null || {
    log "  openclaw restart failed — falling back to pkill..."
    pkill -USR1 -f openclaw-gateway || pkill -9 -f openclaw-gateway || true
    sleep 3
  }
else
  pkill -USR1 -f openclaw-gateway || pkill -9 -f openclaw-gateway || true
  sleep 3
fi

# Quick health check
sleep 3
if pgrep -f openclaw-gateway > /dev/null 2>&1; then
  log "  ✅ Gateway running"
else
  log "  ⚠️  Gateway may not have restarted — check manually"
fi

# ═══════════════════════════════════════════════════════════════════
# PHASE 7: Post-merge jarvis-brain backup
# ═══════════════════════════════════════════════════════════════════
if $NO_BACKUP; then
  log "Phase 7: Skipped (--no-backup)"
else
  log "Phase 7: Post-merge jarvis-brain backup..."
  commit_jarvis_brain "post-merge backup: $(date '+%Y-%m-%d %H:%M')" "jarvis-brain-backup"
fi

# ═══════════════════════════════════════════════════════════════════
# PHASE 8: Companion repo sync
# ═══════════════════════════════════════════════════════════════════
if $NO_COMPANION; then
  log "Phase 8: Skipped (--no-companion)"
else
  log "Phase 8: Syncing companion repos..."
  sync_companion "$CLAWMETRY" "clawmetry" "main"
  sync_companion "$MISSION_CONTROL" "mission-control" "main"
fi

log "✅ Merge complete. ${BEHIND:-0} upstream commits integrated."
echo "RESULT: merged; ${BEHIND:-0} commits; guardian=$GUARDIAN_EXIT issues; gate0=[${GATE0_COMMITS:-none}]"
