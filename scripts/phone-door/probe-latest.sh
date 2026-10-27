#!/bin/bash
# What does the door hand the app's updater? One call, as a paired device sees it (2026-10-19:
# this took 4 calls by hand, one of which made a stray device: `add` has no --json flag, extra
# words become part of the device NAME). Adds a throwaway device, GETs /door/app/latest.json with
# its token, revokes it. The token is never printed.
# Usage: scripts/phone-door/probe-latest.sh [http://host:port]   (default: this host's tailnet IP :18794)
set -uo pipefail
cd "$(dirname "$0")"
DOOR=${1:-http://$(tailscale ip -4 2>/dev/null | head -1):18794}
NAME=probe-$(date +%s)
OUT=$(node devices.mjs add "$NAME" 2>&1)
T=$(printf '%s\n' "$OUT" | awk '/^token/{print $2}')
[ -n "$T" ] || { echo "could not add a probe device"; exit 1; }
curl -s -m 8 -H "x-jarvis-device: $T" "$DOOR/door/app/latest.json"; echo
node devices.mjs revoke "$NAME" >/dev/null
