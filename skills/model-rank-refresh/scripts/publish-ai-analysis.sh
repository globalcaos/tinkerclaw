#!/usr/bin/env bash
# publish-ai-analysis.sh — regenerate the AI-analysis page on thetinkerzone.com
# from the LIVE Tinker panels. One command, fails closed.
#
# FORK 2026-09-04 (the operator): the website holds the only copy of the smart x cost
# chart and the model dossier; the panels are just the renderer. Run this after
# any refresh that changes model data, so the public page is never behind.
#
#   publish-ai-analysis.sh [--dry-run]
#
# Exit 0 = the page now serves the freshly rendered panels.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${AI_ANALYSIS_OUT:-$HOME/.openclaw/workspace/artifacts/ai-analysis}"

echo "[ai-analysis] exporting live panels -> $OUT"
node "$HERE/export-ai-analysis.mjs" --out "$OUT" >/tmp/ai-analysis-export.json
python3 -c "
import json;d=json.load(open('/tmp/ai-analysis-export.json'))
print('[ai-analysis] chart %d models / %d vendors · dossier %d rows'
      % (d['figures']['models'], d['figures']['vendors'], d['dossier']['rows']))
"

echo "[ai-analysis] publishing to thetinkerzone.com"
python3 "$HERE/publish_ai_analysis.py" "$OUT" "$@"
