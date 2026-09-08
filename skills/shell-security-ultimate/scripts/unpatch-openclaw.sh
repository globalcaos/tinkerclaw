#!/bin/bash
#
# unpatch-openclaw.sh — the off switch.
#
# Removes the before_tool_call hook patch from your OpenClaw checkout, returning
# that file to its unpatched behaviour. Runs with no confirmation prompt on
# purpose: an off switch you have to argue with is not an off switch.
#
# It does NOT rebuild unless you pass --rebuild. A build executes package
# scripts from the target checkout, which is a separate decision from undoing
# a source edit.
#
set -e

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/src/clawdbot-moltbot-openclaw}"
TARGET_REL="src/agents/pi-tool-definition-adapter.ts"
TARGET_FILE="$OPENCLAW_DIR/$TARGET_REL"
PATCH_MARKER="EXEC-DISPLAY-PATCH"

DRY_RUN=0
DO_REBUILD=0

usage() {
    cat <<'USAGE'
Usage: unpatch-openclaw.sh [options]

Removes the before_tool_call hook patch from your OpenClaw checkout.

Options:
  --dry-run    Report whether the patch is present and exit. Touches nothing.
  --rebuild    Rebuild the checkout afterwards. OFF by default: a build runs
               package scripts from that checkout.
  -h, --help   This text.

Environment:
  OPENCLAW_DIR  Path to the OpenClaw checkout.
                Default: $HOME/src/clawdbot-moltbot-openclaw

A timestamped .unpatch-backup.<date> copy is written before anything is removed.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)  DRY_RUN=1 ;;
        --rebuild)  DO_REBUILD=1 ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "❌ Unknown option: $1"; echo; usage; exit 1 ;;
    esac
    shift
done

echo "🔧 OpenClaw Hook Patch Remover"
echo "=============================="
echo ""

if [ ! -f "$TARGET_FILE" ]; then
    echo "❌ Target file not found: $TARGET_FILE"
    echo "   Set OPENCLAW_DIR to your OpenClaw source path."
    exit 1
fi

if ! grep -q "$PATCH_MARKER" "$TARGET_FILE"; then
    echo "✅ Not patched. No changes needed."
    exit 0
fi

echo "Patched file : $TARGET_FILE"

if [ "$DRY_RUN" -eq 1 ]; then
    echo "🔍 Dry run — patch is present, nothing was modified."
    exit 0
fi

BACKUP_FILE="$TARGET_FILE.unpatch-backup.$(date +%Y%m%d_%H%M%S)"
cp "$TARGET_FILE" "$BACKUP_FILE"
echo "Backup       : $BACKUP_FILE"
echo ""
echo "📝 Removing patch..."

# Remove the import line
sed -i '/getGlobalHookRunner.*hook-runner-global/d' "$TARGET_FILE"

# Remove the hook block (from PATCH_MARKER to END PATCH_MARKER)
sed -i '/'"$PATCH_MARKER"'/,/END EXEC-DISPLAY-PATCH/d' "$TARGET_FILE"

echo "   Patch removed"

if grep -q "$PATCH_MARKER" "$TARGET_FILE"; then
    echo "❌ Removal verification failed — restoring backup, file left as it was."
    cp "$BACKUP_FILE" "$TARGET_FILE"
    exit 1
else
    echo "✅ Patch removed successfully"
fi

echo ""
if [ "$DO_REBUILD" -eq 1 ]; then
    echo "🔨 Rebuilding OpenClaw (this executes that checkout's build scripts)..."
    cd "$OPENCLAW_DIR"
    if command -v pnpm >/dev/null 2>&1; then
        pnpm build
    else
        npm run build
    fi
    echo ""
    echo "✅ Done. Restart the gateway to apply:  systemctl --user restart openclaw-gateway"
else
    echo "ℹ️  Source restored; NOT rebuilt. The running gateway keeps the old build"
    echo "   until you rebuild it yourself:"
    echo ""
    echo "     cd $OPENCLAW_DIR && pnpm build   # or: npm run build"
    echo "     systemctl --user restart openclaw-gateway"
fi
