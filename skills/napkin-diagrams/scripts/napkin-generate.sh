#!/usr/bin/env bash
# napkin-generate.sh — Generate diagrams via Napkin.ai API
# Usage: napkin-generate.sh "text content" output.png [options]
#        napkin-generate.sh --file input.md output.png [options]
# Options: --variations N, --style STYLE, --format FORMAT, --transparent

set -euo pipefail

CRED_FILE="${HOME}/.openclaw/credentials/napkin.env"
API_BASE="https://api.napkin.ai/v1"

# Load token
if [[ ! -f "$CRED_FILE" ]]; then
  echo "❌ Missing credentials: $CRED_FILE" >&2
  echo "   Run: echo 'NAPKIN_API_TOKEN=sk-...' > $CRED_FILE && chmod 600 $CRED_FILE" >&2
  exit 1
fi
source "$CRED_FILE"

if [[ -z "${NAPKIN_API_TOKEN:-}" ]]; then
  echo "❌ NAPKIN_API_TOKEN not set in $CRED_FILE" >&2
  exit 1
fi

# Defaults
VARIATIONS=4
STYLE=""
FORMAT="png"
TRANSPARENT=false
CONTENT=""
OUTPUT=""
FROM_FILE=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) FROM_FILE="$2"; shift 2 ;;
    --variations) VARIATIONS="$2"; shift 2 ;;
    --style) STYLE="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    --transparent) TRANSPARENT=true; shift ;;
    *)
      if [[ -z "$CONTENT" && -z "$FROM_FILE" ]]; then
        CONTENT="$1"
      elif [[ -z "$OUTPUT" ]]; then
        OUTPUT="$1"
      fi
      shift ;;
  esac
done

# Read from file if specified
if [[ -n "$FROM_FILE" ]]; then
  CONTENT=$(cat "$FROM_FILE")
fi

if [[ -z "$CONTENT" ]]; then
  echo "❌ No content provided. Use: napkin-generate.sh \"text\" output.png" >&2
  exit 1
fi

if [[ -z "$OUTPUT" ]]; then
  echo "❌ No output path provided." >&2
  exit 1
fi

OUTPUT_DIR=$(dirname "$OUTPUT")
OUTPUT_BASE=$(basename "$OUTPUT" ".${FORMAT}")
mkdir -p "$OUTPUT_DIR"

# Build request JSON
REQUEST_JSON=$(python3 -c "
import json, sys
content = sys.stdin.read()
req = {
    'content': content[:5000],
    'format': '$FORMAT',
    'number_of_visuals': $VARIATIONS,
    'transparent_background': True if '' == 'true' else False
}
style = '$STYLE'
if style:
    req['style'] = style
print(json.dumps(req))
" <<< "$CONTENT")

# Submit request
echo "▸ Submitting to Napkin API..."
RESPONSE=$(curl -s -X POST "$API_BASE/visual" \
  -H "Authorization: Bearer $NAPKIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_JSON")

REQUEST_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

if [[ -z "$REQUEST_ID" ]]; then
  echo "❌ Failed to create request: $RESPONSE" >&2
  exit 1
fi

echo "▸ Request ID: $REQUEST_ID"

# Poll for completion
echo "▸ Waiting for generation..."
for i in $(seq 1 30); do
  sleep 3
  STATUS_RESPONSE=$(curl -s -H "Authorization: Bearer $NAPKIN_API_TOKEN" \
    "$API_BASE/visual/${REQUEST_ID}/status")
  STATUS=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','unknown'))" 2>/dev/null)

  if [[ "$STATUS" == "completed" ]]; then
    CREDITS=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('credits',{}).get('consumed','?'))" 2>/dev/null)
    echo "▸ Completed! Credits used: $CREDITS"

    # Download all variations
    NUM_FILES=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('generated_files',[])))" 2>/dev/null)

    for idx in $(seq 0 $(($NUM_FILES - 1))); do
      FILE_URL=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['generated_files'][$idx]['url'])" 2>/dev/null)
      FILE_W=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['generated_files'][$idx]['width'])" 2>/dev/null)
      FILE_H=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['generated_files'][$idx]['height'])" 2>/dev/null)

      if [[ $NUM_FILES -eq 1 ]]; then
        OUT_PATH="${OUTPUT}"
      else
        OUT_PATH="${OUTPUT_DIR}/${OUTPUT_BASE}-${idx}.${FORMAT}"
      fi

      curl -s -H "Authorization: Bearer $NAPKIN_API_TOKEN" "$FILE_URL" -o "$OUT_PATH"
      echo "  ✅ ${OUT_PATH} (${FILE_W}×${FILE_H})"
    done

    echo "▸ Done! $NUM_FILES variation(s) saved."
    exit 0

  elif [[ "$STATUS" == "failed" ]]; then
    echo "❌ Generation failed: $STATUS_RESPONSE" >&2
    exit 1
  fi
done

echo "❌ Timeout waiting for generation (90s)" >&2
exit 1
