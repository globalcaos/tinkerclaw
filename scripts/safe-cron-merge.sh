#!/usr/bin/env bash
# safe-cron-merge.sh — Automated upstream merge pipeline for the OpenClaw fork.
#
# ARCHITECTURE
# ────────────
# Two repos with UNRELATED git histories:
#   FORK  = ~/src/tinkerclaw        (GitHub, public)  — proper upstream ancestry
#   RUNTIME = ~/.openclaw/workspace  (GitLab, private) — runs the gateway, holds personal data
#
# Upstream merges happen in FORK. The result is rsynced to RUNTIME.
# RUNTIME never merges upstream directly (unrelated histories).
# RUNTIME content never reaches GitHub (contains personal data).
#
# PIPELINE
# ────────
#   Gate 0  → Auto-commit dirty repos
#   Gate 1  → Verify clean working tree in FORK
#   Gate 2  → Fetch upstream, check distance
#   Phase 1 → Merge upstream/main in FORK (via merge-upstream.sh)
#   Phase 2 → Fork wiring guardian check
#   Phase 3 → Build in FORK (self-healing retry on failure)
#   Phase 4 → Push FORK to GitHub
#   Phase 5 → Rsync FORK → RUNTIME (via sync-from-tinkerclaw.sh)
#   Phase 6 → Restart gateway
#   Phase 7 → Backup jarvis-brain to GitLab
#   Phase 8 → Sync companion repos (ClawMetry, Mission Control)
#
# FLAGS
# ─────
#   --dry-run       Stop after Gate 2 (report distance, no merge)
#   --no-backup     Skip Phase 7 (jarvis-brain backup)
#   --no-companion  Skip Phase 8 (companion repo sync)
#
# SAFETY INVARIANTS
# ─────────────────
#   • Never `git checkout upstream/main -- .` or `git checkout --theirs`
#   • Never modify source directly — delegates to merge-upstream.sh + apply-fork-wiring.mjs
#   • Never push RUNTIME to GitHub
#   • Abort if unresolved conflicts exceed MAX_CONFLICTS_BEFORE_ABORT

set -euo pipefail

# ── PATH for non-interactive shells (cron) ──
export PATH="$HOME/.local/share/pnpm:$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"

# ══════════════════════════════════════════════════════════════
# Configuration
# ══════════════════════════════════════════════════════════════

readonly FORK_DIR="$HOME/src/tinkerclaw"
readonly RUNTIME_DIR="$HOME/.openclaw/workspace"
readonly BRAIN_DIR="$HOME/.openclaw"           # jarvis-brain (GitLab, private)
readonly ICU_DIR="$HOME/src/jarvis-icu"
readonly CLAWMETRY_DIR="$HOME/src/clawmetry"
readonly MISSION_CONTROL_DIR="$HOME/src/mission-control"

readonly MAX_CONFLICTS_BEFORE_ABORT=5
readonly BUILD_LOG="/tmp/merge-cron-build.log"

# ══════════════════════════════════════════════════════════════
# CLI flags
# ══════════════════════════════════════════════════════════════

dry_run=false
skip_backup=false
skip_companions=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)      dry_run=true ;;
    --no-backup)    skip_backup=true ;;
    --no-companion) skip_companions=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ══════════════════════════════════════════════════════════════
# Logging & error handling
# ══════════════════════════════════════════════════════════════

log()      { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
log_ok()   { log "  ✅ $*"; }
log_warn() { log "  ⚠️  $*"; }

escalate() {
  log "🚨 ESCALATION: $*"
  echo ""
  echo "Manual intervention required. Do NOT retry automatically."
  exit 1
}

# ══════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════

# Count tracked dirty files (excludes untracked '??')
count_dirty_tracked() {
  git -C "$1" status --porcelain | grep -cv '^??' || true
}

# Auto-commit tracked changes in a repo and push.
# Usage: auto_commit_repo <path> <label> [--no-verify]
auto_commit_repo() {
  local repo_path="$1" label="$2" verify_flag="${3:-}"
  local commit_flags=()

  if [ ! -d "$repo_path/.git" ]; then
    log_warn "$label: not a git repo ($repo_path) — skipping"
    return 0
  fi

  local dirty_count
  dirty_count=$(count_dirty_tracked "$repo_path")
  if [ "$dirty_count" -eq 0 ]; then
    log_ok "$label: clean"
    return 0
  fi

  log "  $label: $dirty_count dirty tracked files — auto-committing..."
  git -C "$repo_path" add -u

  [ "$verify_flag" = "--no-verify" ] && commit_flags+=(--no-verify)
  local msg="chore: auto-commit before merge ($(date '+%Y-%m-%d %H:%M'))"

  if ! git -C "$repo_path" commit "${commit_flags[@]}" -m "$msg"; then
    log_warn "$label: commit failed"
    return 0
  fi

  git -C "$repo_path" push origin main 2>/dev/null \
    || log_warn "$label: push failed (non-blocking)"

  gate0_commits+=("$label")
  log_ok "$label: committed + pushed"
}

# Commit jarvis-brain (the workspace parent repo).
# Temporarily hides workspace/.git to avoid confusing the parent repo.
# Sets brain_committed=true on success.
commit_jarvis_brain() {
  local msg="$1" label="$2"
  brain_committed=false

  if [ ! -d "$BRAIN_DIR/.git" ]; then
    log_warn "$label: not a git repo ($BRAIN_DIR) — skipping"
    return 0
  fi

  local ws_git="$BRAIN_DIR/workspace/.git"
  local ws_git_hidden="$BRAIN_DIR/workspace/.git_real"

  # Hide nested .git so parent repo doesn't see it as a submodule
  [ -d "$ws_git" ] && mv "$ws_git" "$ws_git_hidden"

  # Restore on exit (even on error)
  restore_nested_git() {
    [ -d "$ws_git_hidden" ] && [ ! -d "$ws_git" ] && mv "$ws_git_hidden" "$ws_git"
  }
  trap 'restore_nested_git' RETURN

  local dirty_count
  dirty_count=$(git -C "$BRAIN_DIR" status --porcelain | wc -l)
  if [ "$dirty_count" -eq 0 ]; then
    log_ok "$label: clean"
    return 0
  fi

  log "  $label: $dirty_count dirty files — committing..."
  git -C "$BRAIN_DIR" add -A

  if git -C "$BRAIN_DIR" commit -m "$msg"; then
    git -C "$BRAIN_DIR" push origin main 2>/dev/null \
      || log_warn "$label: push failed (non-blocking)"
    brain_committed=true
    log_ok "$label: committed + pushed"
  else
    log_warn "$label: commit failed"
  fi
}

# Sync a companion fork repo (fetch upstream, merge, push).
# Usage: sync_companion <path> <label> [<branch>]
sync_companion() {
  local repo_path="$1" label="$2" branch="${3:-main}"

  if [ ! -d "$repo_path/.git" ]; then
    log_warn "$label: not a git repo ($repo_path) — skipping"
    return 0
  fi

  log "  $label: syncing..."

  # Auto-commit dirty tracked files first
  local dirty_count
  dirty_count=$(count_dirty_tracked "$repo_path")
  if [ "$dirty_count" -gt 0 ]; then
    log "    $dirty_count dirty tracked files — auto-committing..."
    git -C "$repo_path" add -u
    git -C "$repo_path" commit \
      -m "chore: auto-commit before upstream sync ($(date '+%Y-%m-%d %H:%M'))" || true
  fi

  if ! git -C "$repo_path" fetch upstream 2>/dev/null; then
    log_warn "$label: upstream fetch failed — skipping"
    return 0
  fi

  local commits_behind
  commits_behind=$(git -C "$repo_path" rev-list --count "HEAD..upstream/$branch" 2>/dev/null || echo 0)
  if [ "$commits_behind" -eq 0 ]; then
    log_ok "$label: already up to date"
    return 0
  fi

  log "    $commits_behind commits behind upstream/$branch — merging..."
  if ! git -C "$repo_path" merge "upstream/$branch" --no-edit 2>/dev/null; then
    log_warn "$label: merge conflict — aborting"
    git -C "$repo_path" merge --abort 2>/dev/null || true
    return 0
  fi

  git -C "$repo_path" push origin "$branch" 2>/dev/null \
    || log_warn "$label: push failed (non-blocking)"
  log_ok "$label: synced $commits_behind commits from upstream"
}

# Extract package.json version from a repo.
get_pkg_version() {
  grep '"version"' "$1/package.json" | head -1 | sed 's/.*"\([^"]*\)".*/\1/'
}

# Count unresolved merge conflicts in CWD.
count_unresolved_conflicts() {
  git diff --name-only --diff-filter=U 2>/dev/null | wc -l
}

# ══════════════════════════════════════════════════════════════
# Gate 0 — Pre-merge auto-commit (all repos)
# ══════════════════════════════════════════════════════════════

log "Gate 0: Auto-committing dirty repos..."
gate0_commits=()

auto_commit_repo "$FORK_DIR"    "tinkerclaw" "--no-verify"
auto_commit_repo "$RUNTIME_DIR" "workspace"  "--no-verify"

commit_jarvis_brain "chore: auto-commit before merge ($(date '+%Y-%m-%d %H:%M'))" "jarvis-brain"
$brain_committed && gate0_commits+=("jarvis-brain")

auto_commit_repo "$ICU_DIR" "jarvis-icu"

if [ ${#gate0_commits[@]} -gt 0 ]; then
  log "  Gate 0 committed: ${gate0_commits[*]}"
else
  log "  Gate 0: all repos clean"
fi

# ══════════════════════════════════════════════════════════════
# Gate 1 — Clean working tree in FORK
# ══════════════════════════════════════════════════════════════

log "Gate 1: Checking tinkerclaw working tree..."
cd "$FORK_DIR"

dirty_tracked=$(git diff --name-only 2>/dev/null | wc -l)
dirty_staged=$(git diff --cached --name-only 2>/dev/null | wc -l)
dirty_total=$((dirty_tracked + dirty_staged))

if [ "$dirty_total" -gt 0 ]; then
  escalate "Tinkerclaw has $dirty_total dirty tracked files after Gate 0. Run: git -C $FORK_DIR status"
fi
log_ok "Working tree clean"

# ══════════════════════════════════════════════════════════════
# Gate 2 — Fetch upstream & check distance
# ══════════════════════════════════════════════════════════════

log "Gate 2: Fetching upstream..."
cd "$FORK_DIR"
git fetch upstream

commits_behind=$(git rev-list --count HEAD..upstream/main)
log "  Commits behind: $commits_behind"

if [ "$commits_behind" -eq 0 ]; then
  log_ok "Already up to date with upstream."

  # Still sync to runtime if versions diverge
  fork_version=$(get_pkg_version "$FORK_DIR")
  runtime_version=$(get_pkg_version "$RUNTIME_DIR")

  if [ "$runtime_version" != "$fork_version" ]; then
    log "  Runtime ($runtime_version) differs from fork ($fork_version) — will sync."
  else
    echo "RESULT: up-to-date"
    exit 0
  fi
fi

if $dry_run; then
  log "  DRY RUN — would merge $commits_behind commits."
  echo "RESULT: dry-run; $commits_behind commits behind"
  exit 0
fi

# ══════════════════════════════════════════════════════════════
# Phase 1 — Merge upstream in FORK
# ══════════════════════════════════════════════════════════════

if [ "$commits_behind" -gt 0 ]; then
  log "Phase 1: Merging $commits_behind upstream commits in tinkerclaw..."
  cd "$FORK_DIR"

  if [ -f "$FORK_DIR/scripts/merge-upstream.sh" ]; then
    bash "$FORK_DIR/scripts/merge-upstream.sh" || true
  else
    git merge upstream/main --no-edit || true
  fi

  unresolved=$(count_unresolved_conflicts)

  if [ "$unresolved" -gt "$MAX_CONFLICTS_BEFORE_ABORT" ]; then
    git merge --abort 2>/dev/null || true
    escalate "Merge left $unresolved unresolved conflicts (max $MAX_CONFLICTS_BEFORE_ABORT). Aborted."
  fi

  if [ "$unresolved" -gt 0 ]; then
    git merge --abort 2>/dev/null || true
    escalate "$unresolved unresolved conflicts: $(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ', ')"
  fi

  # Finalize merge commit if still in progress
  if [ -f "$FORK_DIR/.git/MERGE_HEAD" ]; then
    git commit --no-edit || escalate "Failed to finalize merge commit."
  fi

  log_ok "Merge complete in tinkerclaw"
fi

# ══════════════════════════════════════════════════════════════
# Phase 2 — Fork wiring guardian
# ══════════════════════════════════════════════════════════════

log "Phase 2: Running merge guardian..."
cd "$FORK_DIR"
guardian_issues=0

if [ -f "$FORK_DIR/scripts/merge-guardian.sh" ]; then
  bash "$FORK_DIR/scripts/merge-guardian.sh" --fix --learn --no-build || guardian_issues=$?
elif [ -f "$RUNTIME_DIR/scripts/merge-guardian.sh" ]; then
  bash "$RUNTIME_DIR/scripts/merge-guardian.sh" --fix --learn --no-build || guardian_issues=$?
fi

if [ "$guardian_issues" -gt 3 ]; then
  escalate "Guardian found $guardian_issues issues after --fix. Manual review needed."
fi
log "  Guardian result: $guardian_issues issue(s)"

# ══════════════════════════════════════════════════════════════
# Phase 3 — Build in FORK (with self-healing retry)
# ══════════════════════════════════════════════════════════════

log "Phase 3: Building in tinkerclaw..."
cd "$FORK_DIR"
rm -rf dist/.cache node_modules/.cache

build_passed=false

if pnpm build > "$BUILD_LOG" 2>&1; then
  build_passed=true
  log_ok "Build passed (first attempt)"
else
  log_warn "Build failed. Attempting self-heal..."

  # Re-apply fork wiring and retry
  [ -f "$FORK_DIR/scripts/apply-fork-wiring.mjs" ] \
    && node "$FORK_DIR/scripts/apply-fork-wiring.mjs" || log_warn "Wiring script had warnings"
  [ -f "$FORK_DIR/scripts/merge-guardian.sh" ] \
    && bash "$FORK_DIR/scripts/merge-guardian.sh" --fix --no-build || true

  # Commit any self-heal patches
  if [ -n "$(git -C "$FORK_DIR" status --porcelain)" ]; then
    log "  Committing self-heal patches..."
    git -C "$FORK_DIR" add -u
    git -C "$FORK_DIR" commit --no-verify \
      -m "chore(fork): self-heal build after upstream merge" || true
  fi

  log "  Retrying build..."
  rm -rf dist/.cache node_modules/.cache
  if pnpm build > "$BUILD_LOG" 2>&1; then
    build_passed=true
    log_ok "Build passed (second attempt, after self-heal)"
  fi
fi

if ! $build_passed; then
  fail_log="/tmp/merge-cron-build-fail-$(date +%Y%m%d-%H%M%S).log"
  cp "$BUILD_LOG" "$fail_log"

  ts_errors=$(grep -cE "error TS[0-9]+" "$BUILD_LOG" 2>/dev/null || true)
  ts_errors=${ts_errors:-0}
  import_errors=$(grep -cE "\[UNRESOLVED_IMPORT\]" "$BUILD_LOG" 2>/dev/null || true)
  import_errors=${import_errors:-0}
  top_errors=$(grep -E "error TS[0-9]+|\[UNRESOLVED_IMPORT\]" "$BUILD_LOG" 2>/dev/null | head -10)

  escalate "Build failed after self-heal. TS: $ts_errors, imports: $import_errors. Log: $fail_log
$top_errors"
fi

# ══════════════════════════════════════════════════════════════
# Phase 4 — Push FORK to GitHub
# ══════════════════════════════════════════════════════════════

log "Phase 4: Pushing tinkerclaw to GitHub..."
cd "$FORK_DIR"
git push origin main 2>/dev/null || log_warn "Push failed (non-blocking)"
log_ok "Pushed"

# ══════════════════════════════════════════════════════════════
# Phase 5 — Sync FORK → RUNTIME
# ══════════════════════════════════════════════════════════════

log "Phase 5: Syncing tinkerclaw → workspace..."

if [ -f "$RUNTIME_DIR/scripts/sync-from-tinkerclaw.sh" ]; then
  bash "$RUNTIME_DIR/scripts/sync-from-tinkerclaw.sh"
else
  log_warn "sync-from-tinkerclaw.sh not found — running inline fallback..."

  sync_dirs=(src/ extensions/ vendor/ docs/ git-hooks/)
  sync_files=(package.json pnpm-lock.yaml tsconfig.json tsconfig.plugin-sdk.dts.json
              tsdown.config.ts openclaw.mjs CHANGELOG.md FORK_PATCHES.md)

  for dir in "${sync_dirs[@]}"; do
    [ -d "$FORK_DIR/$dir" ] && rsync -a --delete "$FORK_DIR/$dir" "$RUNTIME_DIR/$dir"
  done
  for f in "${sync_files[@]}"; do
    [ -f "$FORK_DIR/$f" ] && rsync -a "$FORK_DIR/$f" "$RUNTIME_DIR/$f"
  done
  [ -d "$FORK_DIR/dist" ] && rsync -a --delete "$FORK_DIR/dist/" "$RUNTIME_DIR/dist/"

  cd "$RUNTIME_DIR"
  pnpm install --frozen-lockfile 2>&1 | tail -3 || true
  rm -rf dist/.cache node_modules/.cache
  pnpm build 2>&1 | tail -5 || log_warn "Workspace build failed"

  git -C "$RUNTIME_DIR" add -A --ignore-errors 2>/dev/null || true
  sync_version=$(get_pkg_version "$FORK_DIR")
  git -C "$RUNTIME_DIR" commit --no-verify \
    -m "chore: sync from tinkerclaw ($sync_version)" 2>/dev/null || true
fi

log_ok "Workspace synced"

# ══════════════════════════════════════════════════════════════
# Phase 6 — Restart gateway
# ══════════════════════════════════════════════════════════════

log "Phase 6: Restarting gateway..."

if command -v openclaw >/dev/null 2>&1; then
  openclaw gateway restart 2>/dev/null || {
    log_warn "openclaw restart failed — falling back to signal..."
    pkill -USR1 -f openclaw-gateway 2>/dev/null || true
  }
else
  pkill -USR1 -f openclaw-gateway 2>/dev/null || true
fi

sleep 5
if pgrep -f openclaw-gateway > /dev/null 2>&1; then
  log_ok "Gateway running"
else
  log_warn "Gateway may not have restarted — check manually"
fi

# ══════════════════════════════════════════════════════════════
# Phase 7 — Jarvis-brain backup
# ══════════════════════════════════════════════════════════════

if $skip_backup; then
  log "Phase 7: Skipped (--no-backup)"
else
  log "Phase 7: Backing up jarvis-brain..."
  commit_jarvis_brain "post-merge backup: $(date '+%Y-%m-%d %H:%M')" "jarvis-brain-backup"
fi

# ══════════════════════════════════════════════════════════════
# Phase 8 — Companion repo sync
# ══════════════════════════════════════════════════════════════

if $skip_companions; then
  log "Phase 8: Skipped (--no-companion)"
else
  log "Phase 8: Syncing companion repos..."
  sync_companion "$CLAWMETRY_DIR"        "clawmetry"        "main"
  sync_companion "$MISSION_CONTROL_DIR"  "mission-control"  "main"
fi

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════

log "✅ Merge complete. ${commits_behind:-0} upstream commits integrated."
echo "RESULT: merged; ${commits_behind:-0} commits; guardian=${guardian_issues} issues; gate0=[${gate0_commits[*]:-none}]"
