#!/bin/bash
#
# patch-openclaw.sh — wire up before_tool_call hooks in a local OpenClaw checkout.
#
# THIS SCRIPT MODIFIES SOURCE CODE THAT IS NOT PART OF THIS SKILL.
# It edits one TypeScript file in the OpenClaw checkout you point it at, so that
# plugins registering a `before_tool_call` hook can intercept and block tool calls.
#
# It is OPTIONAL. The skill's command classification works without it.
# Nothing runs until you confirm. Nothing is rebuilt unless you ask with --rebuild.
# Undo with ./unpatch-openclaw.sh (or restore the .backup.* file it leaves behind).
#
set -e

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/src/clawdbot-moltbot-openclaw}"
TARGET_REL="src/agents/pi-tool-definition-adapter.ts"
TARGET_FILE="$OPENCLAW_DIR/$TARGET_REL"
PATCH_MARKER="// EXEC-DISPLAY-PATCH: before_tool_call hook"

DRY_RUN=0
ASSUME_YES=0
DO_REBUILD=0
ALLOW_ANY_REPO=0

# The entire change, in one place. It is printed before it is applied and it is
# what gets written — there is no second copy to drift out of sync.
IMPORT_LINE='import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";'
HOOK_SNIPPET=$(cat <<'SNIPPET'
        // EXEC-DISPLAY-PATCH: before_tool_call hook
        const hookRunner = getGlobalHookRunner();
        if (hookRunner) {
          const hookResult = await hookRunner.runBeforeToolCall(
            { toolName: normalizedName, params: params as Record<string, unknown> },
            { toolName: normalizedName }
          );
          if (hookResult?.block) {
            return jsonResult({
              status: "error",
              tool: normalizedName,
              error: hookResult.blockReason ?? "Tool call blocked by plugin hook",
            });
          }
        }
        // END EXEC-DISPLAY-PATCH
SNIPPET
)

usage() {
    cat <<'USAGE'
Usage: patch-openclaw.sh [options]

Edits ONE file in your OpenClaw checkout to enable before_tool_call plugin hooks.

Options:
  --dry-run          Show the target, the exact change, and exit. Touches nothing.
  --yes              Skip the interactive confirmation (for scripted installs).
  --rebuild          Run the checkout's build after patching. OFF by default:
                     a build executes package scripts from that checkout.
  --allow-any-repo   Skip the "does this look like an OpenClaw checkout?" check.
  -h, --help         This text.

Environment:
  OPENCLAW_DIR       Path to the OpenClaw checkout.
                     Default: $HOME/src/clawdbot-moltbot-openclaw

What it changes:
  <OPENCLAW_DIR>/src/agents/pi-tool-definition-adapter.ts
    + one import of getGlobalHookRunner
    + one guarded hook call before tool.execute(), which returns an error result
      when a plugin's before_tool_call hook asks to block.
  A timestamped .backup.<date> copy of that file is written next to it first.

Nothing else on your system is read or written. No network access. No credentials.
Undo: ./unpatch-openclaw.sh
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)        DRY_RUN=1 ;;
        --yes|-y)         ASSUME_YES=1 ;;
        --rebuild)        DO_REBUILD=1 ;;
        --allow-any-repo) ALLOW_ANY_REPO=1 ;;
        -h|--help)        usage; exit 0 ;;
        *) echo "❌ Unknown option: $1"; echo; usage; exit 1 ;;
    esac
    shift
done

echo "🔧 OpenClaw before_tool_call Hook Patcher"
echo "========================================="
echo ""

# --- Validate the target -----------------------------------------------------

if [ ! -d "$OPENCLAW_DIR" ]; then
    echo "❌ OpenClaw directory not found: $OPENCLAW_DIR"
    echo "   Set OPENCLAW_DIR to your OpenClaw source path."
    exit 1
fi

if [ ! -f "$TARGET_FILE" ]; then
    echo "❌ Target file not found: $TARGET_FILE"
    echo "   This does not look like a checkout this patch applies to."
    exit 1
fi

# Refuse to edit a tree that is not recognisably OpenClaw. A typo in OPENCLAW_DIR
# should not end with sed rewriting an unrelated project.
if [ "$ALLOW_ANY_REPO" -eq 0 ]; then
    if [ ! -f "$OPENCLAW_DIR/package.json" ]; then
        echo "❌ No package.json in $OPENCLAW_DIR — refusing to modify an unknown tree."
        echo "   Override with --allow-any-repo if you are certain."
        exit 1
    fi
    if ! grep -Eqi '"name"[[:space:]]*:[[:space:]]*"[^"]*(openclaw|clawdbot|moltbot|tinkerclaw)' \
         "$OPENCLAW_DIR/package.json"; then
        echo "❌ $OPENCLAW_DIR/package.json does not name an OpenClaw-family project."
        echo "   Refusing to modify it. Override with --allow-any-repo if you are certain."
        exit 1
    fi
fi

if [ -d "$OPENCLAW_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    if ! git -C "$OPENCLAW_DIR" diff --quiet -- "$TARGET_REL" 2>/dev/null; then
        echo "⚠️  $TARGET_REL already has uncommitted changes in git."
        echo "   Commit or stash them first so you can tell this patch apart from your work."
        echo ""
    fi
fi

if grep -q "$PATCH_MARKER" "$TARGET_FILE"; then
    echo "✅ Already patched! No changes needed."
    exit 0
fi

# --- Show exactly what will happen, then ask ---------------------------------

echo "Target checkout : $OPENCLAW_DIR"
echo "File to modify  : $TARGET_REL"
echo "Backup          : $TARGET_REL.backup.<timestamp> (written before any edit)"
echo "Rebuild after   : $( [ "$DO_REBUILD" -eq 1 ] && echo 'YES (--rebuild given)' || echo 'no — pass --rebuild to opt in' )"
echo ""
echo "The change: one import, plus a guarded hook call before tool.execute() that"
echo "returns an error result when a plugin's before_tool_call hook asks to block."
echo ""
echo "Exactly these lines are inserted, and nothing else:"
echo ""
echo "  after the first logger import ->"
printf '    %s\n' "$IMPORT_LINE"
echo ""
echo "  immediately before 'return await tool.execute(...)' ->"
printf '%s\n' "$HOOK_SNIPPET" | sed 's/^/    /'
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
    echo "🔍 Dry run — nothing was modified."
    exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
    REPLY=""
    if [ -t 0 ]; then
        printf "Modify this file? Type 'yes' to continue: "
        read -r REPLY
    elif { exec 3</dev/tty; } 2>/dev/null; then
        printf "Modify this file? Type 'yes' to continue: "
        read -r REPLY <&3
        exec 3<&-
    else
        echo "❌ Not an interactive terminal and --yes was not given."
        echo "   Refusing to modify source code without explicit consent."
        exit 1
    fi
    if [ "$REPLY" != "yes" ]; then
        echo ""
        echo "Aborted. Nothing was modified."
        exit 1
    fi
fi

# --- Apply -------------------------------------------------------------------

echo ""
echo "📝 Patching $TARGET_FILE..."

BACKUP_FILE="$TARGET_FILE.backup.$(date +%Y%m%d_%H%M%S)"
cp "$TARGET_FILE" "$BACKUP_FILE"
echo "   Backup: $BACKUP_FILE"

# Insert the import after the FIRST logger import, and the hook block immediately
# before the FIRST tool.execute call. Both come from the same two constants that
# were printed above (the preview only adds a display indent), so the text you
# were shown cannot drift from the text that gets written.
SNIPPET_TMP="$(mktemp)"
printf '%s\n' "$HOOK_SNIPPET" > "$SNIPPET_TMP"
PATCHED_TMP="$(mktemp)"
trap 'rm -f "$SNIPPET_TMP" "$PATCHED_TMP"' EXIT

awk -v import_line="$IMPORT_LINE" -v snippet_file="$SNIPPET_TMP" '
    !hook_done && /return await tool\.execute\(toolCallId, params, signal, onUpdate\);/ {
        while ((getline l < snippet_file) > 0) print l
        close(snippet_file)
        hook_done = 1
    }
    { print }
    !import_done && /^import.*logger.*$/ { print import_line; import_done = 1 }
' "$TARGET_FILE" > "$PATCHED_TMP"

cat "$PATCHED_TMP" > "$TARGET_FILE"

echo "   Patch applied"

if grep -q "$PATCH_MARKER" "$TARGET_FILE"; then
    echo "✅ Patch verified"
else
    echo "❌ Patch verification failed — restoring backup"
    cp "$BACKUP_FILE" "$TARGET_FILE"
    exit 1
fi

# --- Rebuild, only if asked --------------------------------------------------

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
    echo "ℹ️  Source patched; NOT rebuilt. A build runs package scripts from that"
    echo "   checkout, so it is your call. When you are ready:"
    echo ""
    echo "     cd $OPENCLAW_DIR && pnpm build   # or: npm run build"
    echo "     systemctl --user restart openclaw-gateway"
fi

echo ""
echo "Note: this patch only lets plugins block tool calls. It does not block anything"
echo "by itself — you still need a plugin that registers a before_tool_call hook."
echo "To undo:  ./unpatch-openclaw.sh"
