#!/bin/bash
# ChatGPT Conversation Exporter — token path (advanced / headless)
#
# Usage: ./export.sh [-o OUTPUT_DIR] [--limit N] [--full] [--purge] [--dry-run] [--yes]   (index-only is the DEFAULT)
#
# This path talks to chatgpt.com directly with a bearer token you already have.
# It is NOT the recommended path. The browser-relay path (scripts/export-conversations.ts)
# and the bookmarklet (scripts/bookmarklet.js) do the same job using the session cookie
# your browser already holds, so no token is ever handled, pasted or stored.
#
# The token is read from the CHATGPT_ACCESS_TOKEN environment variable, or typed at a
# hidden prompt. It is never accepted as a command-line argument (argv is visible to every
# process on the machine via `ps`, and lands in your shell history).
#
# OFF SWITCH: this script exits immediately, before any network call or file write, if
# CHATGPT_EXPORT_DISABLE=1 is set or ~/.openclaw/chatgpt-export.disabled exists.

set -e

# ---------------------------------------------------------------- off switch
if [ "${CHATGPT_EXPORT_DISABLE:-}" = "1" ] || [ -e "$HOME/.openclaw/chatgpt-export.disabled" ]; then
  echo "⛔ ChatGPT export is disabled on this machine (CHATGPT_EXPORT_DISABLE / ~/.openclaw/chatgpt-export.disabled)."
  echo "   Nothing was fetched and nothing was written."
  exit 0
fi

# ---------------------------------------------------------------- arguments
OUTPUT_DIR=""
LIMIT=0
# DEFAULT IS INDEX-ONLY. Exporting the full text of every conversation is the
# high-consequence path (it can contain credentials, personal, legal and financial
# detail), so it is opt-in via --full and never the thing that happens by accident.
INDEX_ONLY=1
FULL_OPTIN=0
PURGE=0
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: ./export.sh [-o OUTPUT_DIR] [--limit N] [--full] [--purge] [--dry-run] [--yes]   (index-only is the DEFAULT)

  -o, --output DIR   Where to write the export. Default: $HOME/chatgpt-export/<date>
                     The directory is created with mode 700 (you only).
      --limit N      Export only the N most recent conversations.
      --index-only   Write the conversation index (titles, ids, timestamps) and
                     NOTHING else — no message bodies are fetched or saved.
      --dry-run      Count what would be exported, write nothing, exit.
      --yes          Skip the interactive confirmation (for scripted use).

Token: set CHATGPT_ACCESS_TOKEN, or type it at the hidden prompt. Never passed as an argument.
Off switch: CHATGPT_EXPORT_DISABLE=1, or touch ~/.openclaw/chatgpt-export.disabled
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) OUTPUT_DIR="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --index-only) INDEX_ONLY=1; shift ;;
    --full) INDEX_ONLY=0; FULL_OPTIN=1; shift ;;
    --purge) PURGE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1"
      echo ""
      echo "If you were passing an access token here: that is no longer accepted."
      echo "Tokens on the command line are visible in \`ps\` and saved to your shell history."
      echo "Use CHATGPT_ACCESS_TOKEN=... instead, or let the script prompt you for it."
      echo ""
      usage
      exit 1 ;;
  esac
done

OUTPUT_DIR="${OUTPUT_DIR:-$HOME/chatgpt-export/$(date +%Y-%m-%d)}"

# --purge — the cleanup half of an export tool. An export is a plaintext copy of every
# conversation you have ever had; leaving it on disk indefinitely is the real risk, more so
# than the API call that produced it. This deletes it, and it is the documented off-switch.
if [ "$PURGE" -eq 1 ]; then
  ROOT="${OUTPUT_DIR%/*}"
  echo "This will permanently delete exported conversations under:"
  echo "    $ROOT"
  if [ ! -d "$ROOT" ]; then echo "Nothing to delete."; exit 0; fi
  du -sh "$ROOT" 2>/dev/null | sed 's/^/    size: /'
  if [ -t 0 ]; then
    printf "Type PURGE to confirm: " >&2; read -r c
    [ "$c" = "PURGE" ] || { echo "Aborted."; exit 1; }
  else
    echo "Refusing to purge non-interactively." >&2; exit 1
  fi
  rm -rf "${ROOT:?}"
  echo "Deleted. Note: this removes LOCAL copies only — your ChatGPT account is untouched."
  exit 0
fi


# ---------------------------------------------------------------- token
# A bearer token in the environment is readable by every child process and tends to
# end up in shell history, CI logs and crash dumps. Prefer the hidden TTY prompt;
# the env var is still honoured for automation but warns that it is the weaker path.
TOKEN=""
if [ -t 0 ]; then
  printf "ChatGPT access token (input hidden, press Enter to fall back to CHATGPT_ACCESS_TOKEN): " >&2
  read -rs TOKEN; printf "\n" >&2
fi
if [ -z "$TOKEN" ] && [ -n "${CHATGPT_ACCESS_TOKEN:-}" ]; then
  echo "⚠️  Using CHATGPT_ACCESS_TOKEN from the environment — visible to child processes." >&2
  TOKEN="$CHATGPT_ACCESS_TOKEN"
fi
if [ -z "$TOKEN" ]; then
  if [ -t 0 ]; then
    printf "ChatGPT access token (input hidden): " >&2
    read -rs TOKEN
    printf "\n" >&2
  fi
fi

if [ -z "$TOKEN" ]; then
  echo "No token available. Set CHATGPT_ACCESS_TOKEN or run this from an interactive terminal."
  echo "Prefer the no-token paths: scripts/export-conversations.ts (browser relay) or scripts/bookmarklet.js."
  exit 1
fi

# ---------------------------------------------------------------- consent
# --yes is a convenience for the SAFE path only. A full-content export always
# requires a human at the keyboard: the previous behaviour let a scripted caller
# pass --yes and silently dump every conversation to disk.
if [ "$INDEX_ONLY" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  if [ ! -t 0 ]; then
    echo "❌ --full needs an interactive terminal. Refusing to export message content non-interactively." >&2
    echo "   Run it yourself, or use the default index-only mode which is safe to script." >&2
    exit 1
  fi
  echo ""
  echo "⚠️  --full will write the COMPLETE TEXT of every conversation to $OUTPUT_DIR."
  echo "    That can include credentials, personal, medical, legal and proprietary content."
  printf "    Type the word EXPORT to continue: " >&2
  read -r _confirm
  [ "$_confirm" = "EXPORT" ] || { echo "Aborted."; exit 1; }
fi

if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo ""
  echo "⚠️  About to export your ChatGPT history to this machine, in plaintext."
  echo ""
  echo "    Destination : $OUTPUT_DIR   (created mode 700)"
  if [ "$INDEX_ONLY" -eq 1 ]; then
    echo "    Contents    : conversation index only — titles, ids, timestamps. No message text."
  else
    echo "    Contents    : index.json + one .json and one .md per conversation,"
    echo "                  containing the FULL text of every message, both sides."
  fi
  echo "    Network     : chatgpt.com only, authenticated with your token."
  echo ""
  echo "    Your conversations may contain passwords, API keys, health, legal, financial or"
  echo "    proprietary information. Once written here they are ordinary files: readable by"
  echo "    anything running as you, picked up by backups, and synced by anything watching"
  echo "    this directory. Do not point this at Dropbox/Drive/iCloud."
  echo ""
  printf "Type 'export' to continue, anything else to abort: "
  read -r REPLY
  if [ "$REPLY" != "export" ]; then
    echo "Aborted. Nothing was fetched and nothing was written."
    exit 0
  fi
fi

# ---------------------------------------------------------------- conversation list
# Never put the bearer token on argv: `ps` and shell history would see it.
AUTH_HDR=$(mktemp)
chmod 600 "$AUTH_HDR"
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$AUTH_HDR"
trap 'rm -f "$AUTH_HDR"' EXIT

chatgpt_get() {
  curl -s "$1" -H "Content-Type: application/json" -H @"$AUTH_HDR"
}

echo "📋 Fetching conversation list..."
OFFSET=0
PAGE=100
ALL_IDS=""
INDEX_JSON="[]"

while true; do
  RESP=$(chatgpt_get "https://chatgpt.com/backend-api/conversations?offset=$OFFSET&limit=$PAGE")

  COUNT=$(echo "$RESP" | jq '.items | length')
  INDEX_JSON=$(jq -s '.[0] + .[1]' <(echo "$INDEX_JSON") <(echo "$RESP" | jq '.items'))

  IDS=$(echo "$RESP" | jq -r '.items[].id')
  ALL_IDS="$ALL_IDS $IDS"

  if [ "$COUNT" -lt "$PAGE" ]; then
    break
  fi

  OFFSET=$((OFFSET + PAGE))
  sleep 0.2
done

if [ "$LIMIT" -gt 0 ]; then
  ALL_IDS=$(echo "$ALL_IDS" | tr ' ' '\n' | grep -v '^$' | head -n "$LIMIT")
fi

TOTAL_IDS=$(echo "$ALL_IDS" | wc -w)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "🔍 Dry run: $TOTAL_IDS conversations would be exported to $OUTPUT_DIR"
  echo "   Nothing was written."
  exit 0
fi

# ---------------------------------------------------------------- output dir
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"
echo "$INDEX_JSON" > "$OUTPUT_DIR/index.json"
chmod 600 "$OUTPUT_DIR/index.json"
echo "📁 Output directory: $OUTPUT_DIR (mode 700)"

if [ "$INDEX_ONLY" -eq 1 ]; then
  echo "🎉 Index written: $OUTPUT_DIR/index.json ($TOTAL_IDS conversations listed)."
  echo "   --index-only was set, so no message content was fetched or saved."
  exit 0
fi

mkdir -p "$OUTPUT_DIR/conversations"
chmod 700 "$OUTPUT_DIR/conversations"

echo "📥 Fetching $TOTAL_IDS conversations..."

EXPORTED=0
ERRORS=0

for ID in $ALL_IDS; do
  EXPORTED=$((EXPORTED + 1))

  CONV=$(chatgpt_get "https://chatgpt.com/backend-api/conversation/$ID")

  if echo "$CONV" | jq -e '.detail' > /dev/null 2>&1; then
    echo "❌ [$EXPORTED/$TOTAL_IDS] Error fetching $ID"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  TITLE=$(echo "$CONV" | jq -r '.title // "Untitled"')
  SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | cut -c1-50)

  # Save JSON
  echo "$CONV" > "$OUTPUT_DIR/conversations/${ID}.json"

  # Convert to Markdown
  {
    echo "# $TITLE"
    echo ""
    echo "**ID:** $ID"
    echo "**Created:** $(echo "$CONV" | jq -r '.create_time')"
    echo ""
    echo "---"
    echo ""

    # Extract messages (simplified - just text parts)
    echo "$CONV" | jq -r '
      .mapping | to_entries[] |
      select(.value.message.content.parts != null) |
      select(.value.message.author.role != "system") |
      {
        role: .value.message.author.role,
        content: (.value.message.content.parts | map(select(type == "string")) | join("\n")),
        time: .value.message.create_time
      } |
      select(.content != "")
    ' | jq -s 'sort_by(.time)' | jq -r '.[] |
      if .role == "user" then "## You\n\n\(.content)\n\n---\n"
      else "## ChatGPT\n\n\(.content)\n\n---\n" end'
  } > "$OUTPUT_DIR/conversations/${ID}_${SLUG}.md"

  chmod 600 "$OUTPUT_DIR/conversations/${ID}.json" "$OUTPUT_DIR/conversations/${ID}_${SLUG}.md"

  printf "✅ [%d/%d] %s\r" "$EXPORTED" "$TOTAL_IDS" "$TITLE"

  # Rate limit
  sleep 0.1
done

echo ""
echo ""
echo "🎉 Export complete!"
echo "   📁 $OUTPUT_DIR"
echo "   ✅ Exported: $((EXPORTED - ERRORS))"
echo "   ❌ Errors: $ERRORS"
echo ""
echo "   These files are plaintext copies of your conversations. Keep them off synced"
echo "   folders, and delete the directory when you no longer need it:"
echo "     rm -rf \"$OUTPUT_DIR\""
