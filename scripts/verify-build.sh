#!/usr/bin/env bash
# verify-build.sh — Quick smoke check that dist/ has all required artifacts.
# Run after pnpm build or any tsdown invocation.
#
# Checks that dist/extensions/ has package.json + openclaw.plugin.json
# for all bundled channel extensions. Catches the "Missing bundled chat
# channel metadata" crash that occurs when runtime-postbuild.mjs fails
# silently (e.g. amazon-bedrock dep staging error blocks metadata copy).
#
# Usage:
#   scripts/verify-build.sh [ROOT_DIR]
#   ROOT_DIR defaults to cwd.
set -euo pipefail

ROOT="${1:-$(pwd)}"
DIST="$ROOT/dist"
issues=0

# Check bundled channel extensions have metadata
CHANNELS=(telegram whatsapp discord irc googlechat slack signal imessage line)
for ch in "${CHANNELS[@]}"; do
  dir="$DIST/extensions/$ch"
  if [[ -d "$dir" ]]; then
    for f in package.json openclaw.plugin.json; do
      if [[ ! -f "$dir/$f" ]]; then
        echo "MISSING: dist/extensions/$ch/$f"
        issues=$((issues + 1))
      fi
    done
  fi
done

# Check CLI entry point exists (lives at repo root, not dist/)
if [[ ! -f "$ROOT/openclaw.mjs" ]]; then
  echo "MISSING: openclaw.mjs entry point at repo root"
  issues=$((issues + 1))
fi

# Check that dist/ has actual compiled output (not just extensions)
js_count=$(find "$DIST" -maxdepth 1 -name '*.js' 2>/dev/null | wc -l || true)
if [[ "${js_count:-0}" -eq 0 ]]; then
  echo "MISSING: no compiled .js files in dist/"
  issues=$((issues + 1))
fi

# Check onlyBuiltDependencies indicator
if ! grep -q 'better-sqlite3' "$ROOT/package.json" 2>/dev/null; then
  echo "WARNING: better-sqlite3 not in package.json dependencies"
fi

if [[ $issues -gt 0 ]]; then
  echo ""
  echo "FAIL: $issues build artifact issues found."
  echo "FIX: Run 'node -e \"import('./scripts/copy-bundled-plugin-metadata.mjs').then(m => m.copyBundledPluginMetadata())\"'"
  exit 1
fi

echo "OK: build artifacts verified"
exit 0
