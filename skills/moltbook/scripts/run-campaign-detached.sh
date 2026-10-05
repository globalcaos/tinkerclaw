#!/usr/bin/env bash
# Run the Inbound Marketing Campaign brief as a systemd user unit running headless Claude Code.
# Use when the gateway scheduler cannot run it (e.g. a deferred restart that would kill the run):
# the unit survives the chat turn that started it and any gateway restart.
#   ./run-campaign-detached.sh start    -> launch (refuses if a run is already active)
#   ./run-campaign-detached.sh status   -> unit state + output/report presence
#
# Config (environment, all optional):
#   CAMPAIGN_BRIEF            brief to execute (default: CAMPAIGN.md next to this scripts/ dir)
#   CAMPAIGN_STATE_DIR        output dir (default ~/.openclaw/workspace/memory/moltbook-campaign)
#   CAMPAIGN_REPORT_PATH      where the run writes its report (default $CAMPAIGN_STATE_DIR/campaign-report-<day>.md)
#   CAMPAIGN_REPORT_CONTRACT  a report-format file the run must follow, if your scheduler has one
#   CAMPAIGN_WORKDIR          working directory of the run (default ~/.openclaw/workspace)
#   CAMPAIGN_MODEL            --model for claude (default: the CLI's own default)
#   CAMPAIGN_EFFORT           --effort for claude (default medium)
#   CAMPAIGN_UNIT             systemd unit name (default inbound-campaign-manual)
#   CLAUDE_BIN                claude CLI (default: first `claude` on PATH)
# Every CAMPAIGN_* and MOLTBOOK_* variable is passed into the unit EXCEPT MOLTBOOK_API_KEY:
# a detached run reads the key from the credentials file, so the key never lands in unit properties.
set -euo pipefail
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKILL_DIR=$(dirname "$DIR")
OUT=${CAMPAIGN_STATE_DIR:-$HOME/.openclaw/workspace/memory/moltbook-campaign}
BRIEF=${CAMPAIGN_BRIEF:-$SKILL_DIR/CAMPAIGN.md}
WORKDIR=${CAMPAIGN_WORKDIR:-$HOME/.openclaw/workspace}
EFFORT=${CAMPAIGN_EFFORT:-medium}
UNIT=${CAMPAIGN_UNIT:-inbound-campaign-manual}
CLAUDE_BIN=${CLAUDE_BIN:-$(command -v claude || true)}
DAY=$(date +%F)
REPORT=${CAMPAIGN_REPORT_PATH:-$OUT/campaign-report-$DAY.md}
PROMPT_TEMPLATE=$DIR/campaign-manual-run.prompt.md
PROMPT=$OUT/campaign-manual-run-$DAY.prompt.md

case "${1:-status}" in
  start)
    [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || { echo "claude CLI not found; set CLAUDE_BIN"; exit 1; }
    [ -f "$BRIEF" ] || { echo "brief not found: $BRIEF (set CAMPAIGN_BRIEF)"; exit 1; }
    if systemctl --user is-active --quiet "$UNIT.service"; then echo "already running: $UNIT"; exit 1; fi
    systemctl --user reset-failed "$UNIT.service" 2>/dev/null || true
    mkdir -p "$OUT" "$(dirname "$REPORT")"

    agent=${MOLTBOOK_AGENT_NAME:-the configured Moltbook agent}
    contract=""
    [ -n "${CAMPAIGN_REPORT_CONTRACT:-}" ] && contract=" Follow the report format in $CAMPAIGN_REPORT_CONTRACT."
    p=$(cat "$PROMPT_TEMPLATE")
    p=${p//'{{BRIEF}}'/"$BRIEF"}
    p=${p//'{{REPORT}}'/"$REPORT"}
    p=${p//'{{CONTRACT_LINE}}'/"$contract"}
    p=${p//'{{AGENT}}'/"$agent"}
    p=${p//'{{SKILL_DIR}}'/"$SKILL_DIR"}
    printf '%s\n' "$p" > "$PROMPT"

    envs=(-E "HOME=$HOME" -E "PATH=$(dirname "$CLAUDE_BIN"):/usr/local/bin:/usr/bin:/bin" -E "LANG=C.UTF-8")
    while IFS='=' read -r name _; do
      [ "$name" = MOLTBOOK_API_KEY ] && continue
      envs+=(-E "$name=${!name}")
    done < <(env | grep -E '^(CAMPAIGN|MOLTBOOK)_[A-Z0-9_]*=' || true)

    model_flag=""
    [ -n "${CAMPAIGN_MODEL:-}" ] && model_flag="--model '$CAMPAIGN_MODEL'"

    systemd-run --user --unit="$UNIT" --collect "${envs[@]}" \
      --property=WorkingDirectory="$WORKDIR" \
      /bin/bash -c "'$CLAUDE_BIN' -p \"\$(cat '$PROMPT')\" $model_flag --effort '$EFFORT' \
        --permission-mode bypassPermissions \
        --disallowedTools 'Bash(git push:*)' 'Bash(git commit:*)' 'Bash(rm -rf:*)' 'Bash(openclaw gateway:*)' 'Bash(systemctl --user restart:*)' \
        --output-format json > '$OUT/campaign-manual-run-$DAY.out.json' 2> '$OUT/campaign-manual-run-$DAY.err'"
    echo "started $UNIT at $(date +%T); output -> $OUT/campaign-manual-run-$DAY.out.json; report -> $REPORT"
    ;;
  status)
    systemctl --user show "$UNIT.service" -p ActiveState -p SubState -p ExecMainStartTimestamp 2>/dev/null || true
    ls -la "$OUT/campaign-manual-run-$DAY.out.json" "$REPORT" 2>&1 | cut -c1-160
    ;;
  *) echo "usage: $0 start|status"; exit 2 ;;
esac
