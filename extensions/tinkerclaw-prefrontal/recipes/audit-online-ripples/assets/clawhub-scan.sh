#!/bin/bash
slugs="jarvis-voice whatsapp-ultimate youtube-ultimate chatgpt-exporter-ultimate token-panel-ultimate shell-security-ultimate token-efficiency-guide subagent-overseer computational-humor fork-and-skill-scanner-ultimate outlook-hack memory-bench-pioneer smart-model-router model-prompt-adapter owntracks-location agent-sensei-ultimate agent-superpowers tinker-command-center wordpress-ultimate"
declare -A SRC=( [smart-model-router]="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/workspace/skills/model-router/SKILL.md" )
roots="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/workspace/skills ${TINKERCLAW_DIR:-$HOME/src/tinkerclaw}/skills"
localver(){ local s="$1" f="${SRC[$s]}"
  if [ -z "$f" ]; then for r in $roots; do for c in "$r/$s/SKILL.md" "$r/${s%-ultimate}/SKILL.md" "$r/$s/README.md" "$r/$s/GUIDE.md" "$r/$s/BUDGET_README.md"; do [ -f "$c" ] && { f="$c"; break 2; }; done; done; fi
  [ -z "$f" ] && { echo "?"; return; }
  local v; v=$(grep -aioP '(?<=^version:\s)["'\'']?\K[0-9][0-9.]*' "$f" 2>/dev/null | head -1); echo "${v:-no-ver}"
}
pubver(){ clawhub inspect "$1" 2>/dev/null | grep -oP '(?<=Latest: )\S+'; }
# clawhub.ai is a React server-components app: downloads/installs/stars AND the public
# moderation verdict ship INLINE in the page HTML as `$R[n]` blobs. No auth, no relay.
# --compressed AND grep -a are both mandatory (gzip + NUL bytes) or this silently returns
# nothing. The 2026-07-27 cron concluded these were "not scrape-accessible" and reported
# "unchanged from state" for 6 weeks while ~1000 downloads accrued.
# See reference_clawhub_stats_are_in_page_html.
page(){ curl -s --compressed --max-time 20 "https://clawhub.ai/globalcaos/skills/$1" 2>/dev/null; }
audit(){ printf '%s' "$1" | grep -aoP 'security-audit-sidebar-verdict" data-status="\K[^"]+' | head -1; }
stats(){ printf '%s' "$1" | grep -aoP 'stats:\$R\[[0-9]+\]=\{\K[^}]+' | head -1; }
field(){ printf '%s' "$1" | grep -oP "$2:\\K[0-9]+" | head -1; }
# SAFE | CAUTION | DO_NOT_INSTALL — this is what a visitor reads above the install button.
recommend(){ printf '%s' "$1" | grep -aoP 'recommendation:"\K[A-Z_]+' | head -1; }
# NB: a bare `severity:"` grep hits the first PER-FINDING severity (often MEDIUM) and
# silently understates the verdict. Anchor on the rollup object that carries
# recommendation+score so this column matches what the page shows.
severity(){ printf '%s' "$1" | grep -aoP 'recommendation:"[A-Z_]+",scannerVersion:"[^"]*",score:[0-9]+,severity:"\K[A-Z]+' | head -1; }
echo "SLUG|PUB|LOCAL|AUDIT|RECOMMEND|SEVERITY|DOWNLOADS|INSTALLS|STARS"
for s in $slugs; do
  p=$(pubver "$s"); [ -z "$p" ] && { sleep 2; p=$(pubver "$s"); }
  l=$(localver "$s")
  h=$(page "$s"); [ -z "$h" ] && { sleep 1; h=$(page "$s"); }
  a=$(audit "$h"); [ -z "$a" ] && a="?"
  st=$(stats "$h")
  echo "$s|${p:-MISS}|$l|$a|$(recommend "$h")|$(severity "$h")|$(field "$st" downloads)|$(field "$st" installs)|$(field "$st" stars)"
  sleep 1
done
echo "---TINKERZONE---"
# thetinkerzone sits behind Cloudflare's JA3 wall — plain curl gets a 403 "Just a moment..." challenge
# and reads UNREACHABLE forever. curl_cffi impersonate=chrome clears it (see reference_tinkerzone_publish_cf_walled).
python3 -c "
from curl_cffi import requests
try:
    r=requests.get('https://thetinkerzone.com/wp-json/wp/v2/posts?categories=29&status=publish&per_page=100&_fields=id',impersonate='chrome',timeout=30)
    print('paperposts',len(r.json()))
except Exception:
    print('paperposts UNREACHABLE')
" 2>/dev/null || echo "paperposts UNREACHABLE"
echo "---README---"
grep -aoiE 'papers?-[0-9]+' "${TINKERCLAW_DIR:-$HOME/src/tinkerclaw}/README.md" 2>/dev/null | head -1
