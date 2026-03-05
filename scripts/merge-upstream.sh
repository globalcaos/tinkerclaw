#!/usr/bin/env bash
# Deterministic upstream merge for the OpenClaw fork.
# Usage: scripts/merge-upstream.sh
#
# Strategy:
# 1. Fetch upstream/main
# 2. Attempt merge
# 3. For TIER 1 conflict files, accept upstream version + re-apply fork wiring
# 4. Auto-resolve package.json (accept upstream)
# 5. Report remaining conflicts

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "🔄 Fetching upstream..."
git fetch upstream

BEHIND=$(git rev-list --count HEAD..upstream/main)
echo "📊 $BEHIND commits behind upstream/main"

if [ "$BEHIND" -eq 0 ]; then
  echo "✅ Already up to date!"
  exit 0
fi

# Backup fork-only directories (these never conflict, but be safe)
FORK_DIRS=("src/fork" "src/memory" "src/agents/pi-extensions" "src/agents/tools" "src/whatsapp-history")
BACKUP_DIR="/tmp/openclaw-merge-backup-$(date +%s)"
mkdir -p "$BACKUP_DIR"
for d in "${FORK_DIRS[@]}"; do
  if [ -d "$d" ]; then
    cp -r "$d" "$BACKUP_DIR/$(echo "$d" | tr '/' '_')"
  fi
done
echo "📦 Fork directories backed up to $BACKUP_DIR"

# Attempt merge
echo "🔀 Merging upstream/main..."
if git merge upstream/main --no-edit; then
  echo "✅ Clean merge! No conflicts."
  echo "Run: pnpm build && pnpm test"
  exit 0
fi

echo "⚠️  Conflicts detected. Resolving known patterns..."

# TIER 1: Files where we accept upstream + re-wire fork hooks
TIER1_ACCEPT_UPSTREAM=(
  "src/agents/pi-embedded-runner/run/attempt.ts"
  "src/agents/system-prompt.ts"
  "src/web/auto-reply/monitor/process-message.ts"
  "src/agents/openclaw-tools.ts"
  "src/agents/pi-embedded-subscribe.tools.ts"
  "src/agents/pi-embedded-subscribe.handlers.tools.ts"
  "src/agents/pi-embedded-runner/system-prompt.ts"
  "src/agents/pi-embedded-runner/run.ts"
  "src/gateway/server-methods/sessions.ts"
  "src/web/outbound.ts"
  "src/web/auto-reply/monitor.ts"
  "src/agents/pi-embedded-subscribe.types.ts"
  "tsdown.config.ts"
)

RESOLVED=0
for f in "${TIER1_ACCEPT_UPSTREAM[@]}"; do
  if git diff --name-only --diff-filter=U 2>/dev/null | grep -qF "$f"; then
    echo "  ⚡ Resolving $f → accept upstream"
    git checkout --theirs "$f"
    git add "$f"
    ((RESOLVED++))
  fi
done

# Package files: accept upstream versions
for f in package.json pnpm-lock.yaml; do
  if git diff --name-only --diff-filter=U 2>/dev/null | grep -qF "$f"; then
    echo "  📦 Resolving $f → accept upstream"
    git checkout --theirs "$f"
    git add "$f"
    ((RESOLVED++))
  fi
done

# README: accept upstream
if git diff --name-only --diff-filter=U 2>/dev/null | grep -qF "README.md"; then
  echo "  📝 Resolving README.md → accept upstream"
  git checkout --theirs README.md
  git add README.md
  ((RESOLVED++))
fi

echo "  ✅ Auto-resolved $RESOLVED files"

# Restore fork directories if they were clobbered
for d in "${FORK_DIRS[@]}"; do
  BACKUP_NAME="$BACKUP_DIR/$(echo "$d" | tr '/' '_')"
  if [ -d "$BACKUP_NAME" ] && [ ! -d "$d" ]; then
    echo "  🔧 Restoring $d from backup"
    cp -r "$BACKUP_NAME" "$d"
    git add "$d"
  fi
done

# Re-apply fork wiring to TIER 1 files
if [ -f scripts/apply-fork-wiring.mjs ]; then
  echo "🔌 Re-applying fork hook wiring..."
  node scripts/apply-fork-wiring.mjs
  for f in "${TIER1_ACCEPT_UPSTREAM[@]}"; do
    git add "$f" 2>/dev/null || true
  done
fi

# Restore fork dependencies in package.json if upstream wiped them
if [ -f package.json ] && ! grep -q '"better-sqlite3"' package.json; then
  echo "  🔧 Restoring fork dependencies (better-sqlite3, bindings) to package.json..."
  node -e "
    const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
    pkg.dependencies = pkg.dependencies || {};
    if (!pkg.dependencies['better-sqlite3']) pkg.dependencies['better-sqlite3'] = '^12.6.2';
    if (!pkg.dependencies['bindings']) pkg.dependencies['bindings'] = '^1.5.0';
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  git add package.json
fi

# Report remaining conflicts
REMAINING=$(git diff --name-only --diff-filter=U 2>/dev/null | wc -l)
if [ "$REMAINING" -gt 0 ]; then
  echo ""
  echo "⚠️  $REMAINING unresolved conflicts remain:"
  git diff --name-only --diff-filter=U
  echo ""
  echo "Resolve manually, then: git add <files> && git merge --continue"
else
  echo ""
  echo "✅ All conflicts resolved!"
  echo "Run: pnpm build && pnpm test"
  echo "Then: git merge --continue"
fi
