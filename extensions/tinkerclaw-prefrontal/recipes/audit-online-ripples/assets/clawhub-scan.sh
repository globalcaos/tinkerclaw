#!/bin/bash
slugs="jarvis-voice whatsapp-ultimate youtube-ultimate chatgpt-exporter-ultimate token-panel-ultimate shell-security-ultimate token-efficiency-guide subagent-overseer computational-humor fork-and-skill-scanner-ultimate outlook-hack memory-bench-pioneer smart-model-router model-prompt-adapter owntracks-location agent-sensei-ultimate agent-superpowers tinker-command-center wordpress-ultimate"
declare -A SRC=( [smart-model-router]="/home/user/.openclaw/workspace/skills/model-router/SKILL.md" )
roots="/home/user/.openclaw/workspace/skills /home/user/src/tinkerclaw/skills"
localver(){ local s="$1" f="${SRC[$s]}"
  if [ -z "$f" ]; then for r in $roots; do for c in "$r/$s/SKILL.md" "$r/${s%-ultimate}/SKILL.md" "$r/$s/README.md" "$r/$s/GUIDE.md" "$r/$s/BUDGET_README.md"; do [ -f "$c" ] && { f="$c"; break 2; }; done; done; fi
  [ -z "$f" ] && { echo "?"; return; }
  local v; v=$(grep -aioP '(?<=^version:\s)["'\'']?\K[0-9][0-9.]*' "$f" 2>/dev/null | head -1); echo "${v:-no-ver}"
}
pubver(){ clawhub inspect "$1" 2>/dev/null | grep -oP '(?<=Latest: )\S+'; }
audit(){ curl -s --compressed --max-time 15 "https://clawhub.ai/globalcaos/skills/$1" 2>/dev/null | grep -aoP 'security-audit-sidebar-verdict" data-status="\K[^"]+' | head -1; }
echo "SLUG|PUB|LOCAL|AUDIT"
for s in $slugs; do
  p=$(pubver "$s"); [ -z "$p" ] && { sleep 2; p=$(pubver "$s"); }
  l=$(localver "$s")
  a=$(audit "$s"); [ -z "$a" ] && { sleep 1; a=$(audit "$s"); }; [ -z "$a" ] && a="?"
  echo "$s|${p:-MISS}|$l|$a"
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
grep -aoiE 'papers?-[0-9]+' /home/user/src/tinkerclaw/README.md 2>/dev/null | head -1
