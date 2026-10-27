#!/usr/bin/env bash
# WordPress media upload wrapper. Needs WP_ALLOW_PUBLISH=1 (the file goes public).
# Usage: WP_ALLOW_PUBLISH=1 wp-upload.sh <file_path> [alt_text]
# Returns: JSON with media ID and URL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# --- Config loading -----------------------------------------------------------
# Same ONE loader wp.sh uses. This script used to carry a second copy of it, and
# that copy gave the implicit <skill>/.env no symlink/ownership/mode check at all.
# shellcheck source=wp-credentials.sh
. "$SCRIPT_DIR/wp-credentials.sh"
wp_bootstrap "$SKILL_DIR"

# OFF SWITCH: an upload is a write, so WP_READONLY=1 stops it before it starts.
if [[ -n "${WP_READONLY:-}" && "${WP_READONLY}" != "0" ]]; then
  echo "🔒 WP_READONLY is set — media upload blocked. Unset WP_READONLY to allow writes." >&2
  exit 1
fi

FILE_PATH="${1:?Usage: wp-upload.sh <file_path> [alt_text]}"
ALT_TEXT="${2:-}"

# SAFETY: an uploaded file is served at a public wp-content/uploads URL the moment
# the upload finishes, whether or not any post uses it. That is publishing, so it
# needs the same per-call consent as wp.sh: WP_ALLOW_PUBLISH=1 in the environment.
if [[ "${WP_ALLOW_PUBLISH:-0}" != "1" ]]; then
  echo "❌ Media upload is gated: the file becomes publicly reachable at ${WP_URL}/wp-content/uploads/… immediately." >&2
  echo "   Confirm with the site owner, then re-run with WP_ALLOW_PUBLISH=1." >&2
  exit 1
fi

if [[ ! -f "$FILE_PATH" ]]; then
  echo "File not found: $FILE_PATH" >&2
  exit 1
fi

FILENAME=$(basename "$FILE_PATH")
# The name goes into a Content-Disposition header (and a curl -F field), so only
# plain filename characters are accepted.
if [[ ! "$FILENAME" =~ ^[A-Za-z0-9._\ -]+$ ]]; then
  echo "❌ File name '$FILENAME' has characters that cannot be sent safely in a header. Rename it (letters, digits, space . _ -)." >&2
  exit 1
fi
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
  # SAFETY: the password goes in a 0600 netrc file, NEVER in `curl -u`. An argv
  # element is world-readable in `ps` for the lifetime of the process, so
  # `-u user:app_password` handed the credential to every other account on the box.
  # wp_netrc_create installs an EXIT/HUP/INT/TERM trap, so the temp file cannot
  # outlive a failed curl.
  wp_netrc_create
  RESPONSE=$(curl -s \
    --netrc-file "$WP_NETRC" \
    -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36" \
    -H "Accept: application/json" \
    -F "file=@${FILE_PATH};type=${MIME};filename=${FILENAME}" \
    "${WP_URL}/wp-json/wp/v2/media")
fi

MEDIA_ID=$(printf '%s' "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id','ERROR'))" 2>/dev/null || echo "ERROR")

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
    # Same rule on the second call — no -u here either.
    [[ -n "${WP_NETRC:-}" ]] || wp_netrc_create
    curl -s -X PUT \
      --netrc-file "$WP_NETRC" \
      -H "Content-Type: application/json" \
      -d "$(WP_ALT="$ALT_TEXT" python3 -c 'import json,os; print(json.dumps({"alt_text": os.environ["WP_ALT"]}))')" \
      "${WP_URL}/wp-json/wp/v2/media/${MEDIA_ID}" > /dev/null
  fi
fi

wp_netrc_cleanup

printf '%s' "$RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(json.dumps({
    'id': d['id'],
    'url': d.get('source_url', ''),
    'title': d.get('title', {}).get('rendered', ''),
    'mime': d.get('mime_type', '')
}, indent=2))
"
