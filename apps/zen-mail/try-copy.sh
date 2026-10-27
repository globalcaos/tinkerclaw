#!/bin/sh
# Try a Zen Mail change on a COPY of the live data, never on the real list (2026-10-19: four hand-made copies in one
# afternoon; one forgot the fonts and 404'd, one left its test server listening and `pkill -f` is refused by the hook).
#   sh try-copy.sh          copy zen.db + settings + fonts to /tmp/jarvis/zen-copy, serve it on :18897 for 10 min
#   sh try-copy.sh --stop   stop that server and delete the copy (it holds real mail)
# Python against the copy: ZEN_MAIL_DATA=/tmp/jarvis/zen-copy ZEN_MAIL_OPENER=true python3 - <<'EOF' … (from this folder).
# Anything that writes outside ZEN_MAIL_DATA (Outlook drafts, the memory file of remember_fact) is still REAL.
set -eu
APP=$(cd "$(dirname "$0")" && pwd)
SRC="$HOME/.local/share/zen-mail"
DST=/tmp/jarvis/zen-copy
PORT=18897
UNIT=zen-mail-copy
if [ "${1:-}" = "--stop" ]; then
  systemctl --user stop "$UNIT" 2>/dev/null || true
  for f in zen.db zen.db-wal zen.db-shm settings.json fonts/inter.woff2 fonts/serif.woff2 sync.log; do rm -f "$DST/$f"; done
  rmdir "$DST/fonts" "$DST" 2>/dev/null || true
  echo "stopped; copy removed${DST:+ (left: $(ls -A "$DST" 2>/dev/null | tr '\n' ' '))}"
  exit 0
fi
mkdir -p "$DST/fonts"
cp "$SRC/zen.db" "$SRC/settings.json" "$DST/"
cp "$SRC"/fonts/*.woff2 "$DST/fonts/" 2>/dev/null || true
systemctl --user stop "$UNIT" 2>/dev/null || true
systemd-run --user --quiet --unit "$UNIT" -p RuntimeMaxSec=600 --collect \
  --setenv=ZEN_MAIL_DATA="$DST" --setenv=ZEN_MAIL_PORT="$PORT" --setenv=ZEN_MAIL_OPENER=true \
  /usr/bin/python3 -I "$APP/server.py"
sleep 2
echo "copy served on http://127.0.0.1:$PORT/ (unit $UNIT, stops itself in 10 min); data in $DST"
