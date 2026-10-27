#!/bin/bash
# pack-publish.sh — publish the Jarvis content pack and get it onto the phone: no APK, no tap.
#
#   bash ~/src/tinkerclaw/scripts/phone-door/pack-publish.sh [--src DIR]
#
# Plan 2026-10-23 "phone app self-update", layer 2. Three steps, each with its own proof:
#   1. pack.mjs publish: zip the pack source, sign it (key in ~/.config/jarvis-pack), write pack.json
#      beside the APK in the door's app/ folder;
#   2. node command jarvis.pack.update (the gateway wakes a sleeping app through Firebase first);
#   3. wait, bounded, for the door's audit line "pack-installed" for this version, and print it.
# Takes seconds, not minutes: no longjob needed. A phone that is off gets the pack at its next start.
set -euo pipefail
export PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH
HERE=$(cd "$(dirname "$0")" && pwd)
PHONE=${JARVIS_PHONE_NODE:-c3aea3e0eca1a3a602db47811e036c385c4c5c92c714d38d770b685f92ce0fe4}
OC="node $HOME/src/tinkerclaw/dist/index.js"
AUDIT=${PHONE_DOOR_DIR:-$HOME/.openclaw/data/phone-door}/audit.jsonl

PTR=$(node "$HERE/pack.mjs" publish "$@")
V=$(printf '%s' "$PTR" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["version"])')
echo "published pack $V ($(printf '%s' "$PTR" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["size"])') bytes)"

$OC nodes invoke --node "$PHONE" --command jarvis.pack.update --invoke-timeout 60000 --timeout 90000 --json 2>&1 | tail -c 400 ||
  echo "the phone did not answer (asleep or off); it takes the pack at its next start or wake"
echo
for _ in $(seq 1 12); do
  LINE=$(grep '"event":"pack-installed"' "$AUDIT" 2>/dev/null | grep "\"version\":$V," | tail -1 || true)
  if [ -n "$LINE" ]; then
    echo "phone: $LINE"
    printf '%s' "$LINE" | grep -q '"status":"active"' && exit 0
    exit 1
  fi
  sleep 5
done
echo "no pack-installed line for $V in the door audit yet" >&2
exit 3
