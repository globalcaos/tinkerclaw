#!/usr/bin/env bash
# WordPress media upload wrapper
# Usage: wp-upload.sh <file_path> [alt_text]
# Returns: JSON with media ID and URL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# --- Config loading -----------------------------------------------------------
# Same pinned rules as wp.sh: exactly two explicit locations, no walk up the parent
# directories, and only WP_[A-Z0-9_]+ keys are imported from the file.
ENV_FILE=""
if [[ -n "${WP_ENV_FILE:-}" ]]; then
  [[ "$WP_ENV_FILE" = /* ]] || { echo "❌ WP_ENV_FILE must be an ABSOLUTE path (got: $WP_ENV_FILE)" >&2; exit 1; }
  [[ -f "$WP_ENV_FILE" ]] || { echo "❌ WP_ENV_FILE=$WP_ENV_FILE does not exist" >&2; exit 1; }
  [[ -L "$WP_ENV_FILE" ]] && { echo "❌ WP_ENV_FILE must not be a symlink" >&2; exit 1; }
  if [[ "$(stat -c '%u' "$WP_ENV_FILE" 2>/dev/null)" != "$(id -u)" ]]; then
    echo "❌ WP_ENV_FILE must be owned by you — refusing to read credentials from it." >&2; exit 1
  fi
  ENV_PERM="$(stat -c '%a' "$WP_ENV_FILE" 2>/dev/null)"
  if [[ "${ENV_PERM: -2}" != "00" ]]; then
    echo "❌ WP_ENV_FILE is group/world readable or writable (mode $ENV_PERM). Run: chmod 600 $WP_ENV_FILE" >&2; exit 1
  fi
  ENV_FILE="$WP_ENV_FILE"
elif [[ -f "$SKILL_DIR/.env" ]]; then
  ENV_FILE="$SKILL_DIR/.env"
fi
if [[ -n "$ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    key=$(echo "${key:-}" | xargs)
    [[ "$key" =~ ^WP_[A-Z0-9_]+$ ]] || continue
    value="${value%$'\r'}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key"="$value"
  done < "$ENV_FILE"
fi

: "${WP_URL:?Set WP_URL in .env}"
: "${WP_USER:?Set WP_USER in .env}"
: "${WP_APP_PASSWORD:?Set WP_APP_PASSWORD in .env}"

case "$WP_URL" in
  https://*) ;;
  *) echo "❌ WP_URL must be https:// (got: $WP_URL). Refusing to send credentials." >&2; exit 1 ;;
esac
WP_HOST="${WP_URL#https://}"; WP_HOST="${WP_HOST%%/*}"; WP_HOST="${WP_HOST%%:*}"
WP_ALLOWED_HOSTS="${WP_ALLOWED_HOSTS:-$WP_HOST}"
if [[ ",${WP_ALLOWED_HOSTS// /}," != *",${WP_HOST},"* ]]; then
  echo "❌ WP_URL host '$WP_HOST' is not in WP_ALLOWED_HOSTS. Refusing to send credentials." >&2
  exit 1
fi

# OFF SWITCH: an upload is a write, so WP_READONLY=1 stops it before it starts.
if [[ -n "${WP_READONLY:-}" && "${WP_READONLY}" != "0" ]]; then
  echo "🔒 WP_READONLY is set — media upload blocked. Unset WP_READONLY to allow writes." >&2
  exit 1
fi

FILE_PATH="${1:?Usage: wp-upload.sh <file_path> [alt_text]}"
ALT_TEXT="${2:-}"

if [[ ! -f "$FILE_PATH" ]]; then
  echo "File not found: $FILE_PATH" >&2
  exit 1
fi

FILENAME=$(basename "$FILE_PATH")
MIME=$(file --mime-type -b "$FILE_PATH")

# Transport. Two walls stack on this endpoint and each needs a different answer:
#   1. Mod_Security/WAF rejects a raw octet-stream body for some types (PDF: "406
#      Not Acceptable"); a browser UA + Accept header help clear it.
#   2. Cloudflare challenges plain curl's TLS/JA3 fingerprint outright ("Just a
#      moment..." 403) outright on Cloudflare-fronted sites.
# Same fix, same shape as wp.sh: impersonate Chrome when curl_cffi imports.
if python3 -c "import curl_cffi" 2>/dev/null; then
  RESPONSE=$(WP_FILE="$FILE_PATH" WP_NAME="$FILENAME" WP_MIME="$MIME" \
    WP_URL_FULL="${WP_URL}/wp-json/wp/v2/media" \
    WP_AUTH_USER="$WP_USER" WP_AUTH_PW="$WP_APP_PASSWORD" python3 - <<'PY_UP'
import os
from curl_cffi import requests

auth = (os.environ["WP_AUTH_USER"], os.environ["WP_AUTH_PW"].replace(" ", ""))
name, mime = os.environ["WP_NAME"], os.environ["WP_MIME"]
r = requests.post(
    os.environ["WP_URL_FULL"], auth=auth, impersonate="chrome",
    headers={
        "Content-Disposition": 'attachment; filename="%s"' % name,
        "Content-Type": mime,
        "Accept": "application/json",
    },
    data=open(os.environ["WP_FILE"], "rb").read(), timeout=300,
)
print(r.text)
PY_UP
)
else
  RESPONSE=$(curl -s \
    -u "${WP_USER}:${WP_APP_PASSWORD}" \
    -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36" \
    -H "Accept: application/json" \
    -F "file=@${FILE_PATH};type=${MIME};filename=${FILENAME}" \
    "${WP_URL}/wp-json/wp/v2/media")
fi

MEDIA_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id','ERROR'))" 2>/dev/null || echo "ERROR")

if [[ "$MEDIA_ID" == "ERROR" ]]; then
  echo "Upload failed:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

# Set alt text if provided — same transport, or the PUT dies at the same wall.
if [[ -n "$ALT_TEXT" ]]; then
  if python3 -c "import curl_cffi" 2>/dev/null; then
    WP_ALT="$ALT_TEXT" \
      WP_URL_FULL="${WP_URL}/wp-json/wp/v2/media/${MEDIA_ID}" \
      WP_AUTH_USER="$WP_USER" WP_AUTH_PW="$WP_APP_PASSWORD" python3 - <<'PY_ALT' > /dev/null
import os
from curl_cffi import requests

auth = (os.environ["WP_AUTH_USER"], os.environ["WP_AUTH_PW"].replace(" ", ""))
requests.post(os.environ["WP_URL_FULL"], auth=auth, impersonate="chrome",
              json={"alt_text": os.environ["WP_ALT"]}, timeout=120)
PY_ALT
  else
    curl -s -X PUT \
      -u "${WP_USER}:${WP_APP_PASSWORD}" \
      -H "Content-Type: application/json" \
      -d "$(WP_ALT="$ALT_TEXT" python3 -c 'import json,os; print(json.dumps({"alt_text": os.environ["WP_ALT"]}))')" \
      "${WP_URL}/wp-json/wp/v2/media/${MEDIA_ID}" > /dev/null
  fi
fi

echo "$RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(json.dumps({
    'id': d['id'],
    'url': d.get('source_url', ''),
    'title': d.get('title', {}).get('rendered', ''),
    'mime': d.get('mime_type', '')
}, indent=2))
"
