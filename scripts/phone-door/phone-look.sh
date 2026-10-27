#!/bin/bash
# Look at the Tinker page on the paired phone, in one call. (2026-10-20: this lived as a hand-built
# /tmp/jarvis/look/bin/look.sh that vanished with /tmp twice, 10-19 evening and 10-20 morning, and was
# rebuilt each time.) Runs JavaScript in the page, prints its result, and/or saves a screenshot.
#   phone-look.sh --eval '<js expression>'          print the result only
#   phone-look.sh --eval-file gest.js               same, JS from a file
#   phone-look.sh --shot out.jpg [--eval '<js>']    eval first (if given), then screenshot
# The phone = the first paired node that offers jarvis.tinker.eval (override: PHONE_NODE=<nodeId>).
# Synthetic PointerEvents dispatched this way exercise touch handlers without moving the architect's screen;
# never navigate or switch his view to set up a test while he is using the phone.
set -uo pipefail
OC=(node "$HOME/src/tinkerclaw/dist/index.js")
JS=""; SHOT=""
while [ $# -gt 0 ]; do case "$1" in
  --eval) JS=$2; shift 2;; --eval-file) JS=$(cat "$2"); shift 2;; --shot) SHOT=$2; shift 2;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done
[ -n "$JS$SHOT" ] || { sed -n 2,9p "$0"; exit 2; }
N=${PHONE_NODE:-$("${OC[@]}" nodes list --json 2>/dev/null | python3 -I -c '
import json,sys
for n in json.load(sys.stdin).get("paired",[]):
  if "jarvis.tinker.eval" in (n.get("commands") or []): print(n["nodeId"]); break')}
[ -n "$N" ] || { echo "no paired node offers jarvis.tinker.eval (phone app not paired?)" >&2; exit 1; }
if [ -n "$JS" ]; then
  P=$(python3 -I -c 'import json,sys;print(json.dumps({"javaScript":sys.argv[1]}))' "$JS")
  "${OC[@]}" nodes invoke --node "$N" --command jarvis.tinker.eval --params "$P" --invoke-timeout 20000 --json 2>&1 \
    | python3 -I -c '
import json,sys
raw=sys.stdin.read()
try:
  d=json.loads(raw); p=d.get("payload",d); p=json.loads(p) if isinstance(p,str) else p
  print(p.get("result",p) if isinstance(p,dict) else p)
except Exception: print(raw[:1500]); sys.exit(1)'
  [ -n "$SHOT" ] && sleep 1
fi
if [ -n "$SHOT" ]; then
  T=${TMPDIR:-/tmp}/jarvis/phone-look/shot.json; mkdir -p "$(dirname "$T")"
  "${OC[@]}" nodes invoke --node "$N" --command jarvis.screenshot \
    --params '{"maxWidth":540,"quality":75}' --invoke-timeout 30000 --json > "$T" 2>&1
  python3 -I -c '
import json,base64,sys
d=json.load(open(sys.argv[1])); p=d.get("payload") or {}
p=json.loads(p) if isinstance(p,str) else p
open(sys.argv[2],"wb").write(base64.b64decode(p["base64"])); print("saved",sys.argv[2])' "$T" "$SHOT"
fi
