#!/usr/bin/env bash
# Render board.html the way the Tinker chat iframe wraps it, plus one forced-open tooltip.
# Usage: check.sh board.html outdir   -> outdir/full.png outdir/hover.png (then LOOK at both)
set -eu
b=$1; o=$2; mkdir -p "$o"
base="<!doctype html><html><head><meta charset='utf-8'><style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;max-width:100%;overflow-x:hidden}body{padding:8px;font-family:system-ui;overflow-wrap:anywhere;word-break:break-word}body>*{width:100%}table{width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse}td,th{overflow-wrap:anywhere;word-break:break-word}</style></head><body>"
{ echo "$base"; cat "$b"; echo "</body></html>"; } > "$o/sim.html"
sed -e '0,/class="tip/s//class="force tip/' -e 's#</style></head>#.force.tip{display:block}</style></head>#' "$o/sim.html" > "$o/sim-hover.html"
grep -q '<script' "$b" || { echo "FAIL: no <script> — the chat will strip the <style> and the hovers"; exit 1; }
google-chrome --headless --disable-gpu --hide-scrollbars --window-size=950,1600 --screenshot="$o/full.png" "file://$o/sim.html" 2>/dev/null
google-chrome --headless --disable-gpu --hide-scrollbars --window-size=950,450 --screenshot="$o/hover.png" "file://$o/sim-hover.html" 2>/dev/null
echo "OK: look at $o/full.png and $o/hover.png before sending"
