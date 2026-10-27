#!/bin/sh
# Register the Tinkerclaw local helper with Chrome for the Browser Relay plugin (FORK 2026-10-15).
# Run on the machine where Chrome runs (the architect's laptop), not on the gateway's machine.
#   sh install.sh [extension-id]     default: the unpacked relay's id on the architect's laptop
set -eu
ID="${1:-bdocoajkojgompbciinnhdkfagggaedj}"
HERE="$(cd "$(dirname "$0")" && pwd)"
chmod 755 "$HERE/tinkerclaw_local.py"
for DIR in "$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts"; do
  [ -d "$(dirname "$DIR")" ] || continue
  mkdir -p "$DIR"
  cat > "$DIR/com.tinkerclaw.local.json" <<JSON
{
  "name": "com.tinkerclaw.local",
  "description": "Tinkerclaw local helper: open files with their app, play Jarvis's voice",
  "path": "$HERE/tinkerclaw_local.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON
  echo "registered: $DIR/com.tinkerclaw.local.json"
done
