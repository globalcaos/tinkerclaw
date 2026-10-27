#!/usr/bin/env bash
# Install (or remove) a systemd USER timer that refreshes the ask-session catalogue
# every night at 03:40. Persistent=true runs a missed night at the next boot.
#
#   bash install-timer.sh              install or update; safe to run again
#   bash install-timer.sh --uninstall  stop the timer and remove both unit files
#
# The catalogue run is incremental and offline: it never wakes a session and never
# calls a model (no --summarize).
set -euo pipefail

NAME="ask-session-catalog"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="$UNIT_DIR/$NAME.service"
TIMER="$UNIT_DIR/$NAME.timer"
SCRIPT="$(readlink -f "$(dirname "${BASH_SOURCE[0]}")/sessions.py")"
PYTHON="$(command -v python3 || true)"

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -f "$TIMER" || -f "$SERVICE" ]]; then
    systemctl --user disable --now "$NAME.timer" >/dev/null 2>&1 || true
    rm -f "$TIMER" "$SERVICE"
    systemctl --user daemon-reload
    echo "removed $NAME.timer and $NAME.service from $UNIT_DIR"
  else
    echo "nothing to remove: $NAME is not installed in $UNIT_DIR"
  fi
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  echo "usage: $0 [--uninstall]" >&2
  exit 2
fi
if [[ -z "$PYTHON" ]]; then
  echo "python3 not found on PATH" >&2
  exit 1
fi
if [[ ! -f "$SCRIPT" ]]; then
  echo "sessions.py not found next to this script ($SCRIPT)" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

# systemd reads double quotes in ExecStart= and Environment=. Escape what would break
# out of them, plus its % specifiers and $ variables, so any path survives as written.
sd_quote() {
  local v="${1//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//%/%%}"
  [[ "${2:-}" == env ]] || v="${v//\$/\$\$}"  # Environment= does not expand $, ExecStart= does
  printf '"%s"' "$v"
}

# The nightly run must write where the gateway reads: carry a non-default state dir over.
env_line=""
if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
  env_line="Environment=$(sd_quote "OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR" env)
"
fi

service_body="[Unit]
Description=ask-session: refresh the catalogue of past Claude Code sessions

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
${env_line}ExecStart=$(sd_quote "$PYTHON") -I $(sd_quote "$SCRIPT") catalog
"

timer_body="[Unit]
Description=ask-session: nightly catalogue refresh at 03:40

[Timer]
OnCalendar=*-*-* 03:40:00
Persistent=true

[Install]
WantedBy=timers.target
"

changed=0
write_if_different() {
  local path="$1" body="$2"
  if [[ -f "$path" ]] && [[ "$(cat "$path")" == "$(printf '%s' "$body")" ]]; then
    echo "unchanged: $path"
  else
    printf '%s' "$body" > "$path"
    echo "wrote: $path"
    changed=1
  fi
}

write_if_different "$SERVICE" "$service_body"
write_if_different "$TIMER" "$timer_body"

if [[ "$changed" == 1 ]]; then
  systemctl --user daemon-reload
  echo "reloaded the systemd user manager"
fi
systemctl --user enable --now "$NAME.timer" >/dev/null
echo "enabled: $NAME.timer (nightly 03:40, Persistent=true) runs: $PYTHON -I $SCRIPT catalog${OPENCLAW_STATE_DIR:+ (OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR)}"
