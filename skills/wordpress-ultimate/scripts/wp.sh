#!/usr/bin/env bash
# WordPress REST API wrapper with draft-by-default safety and explicit consent gates.
# Usage: wp.sh <METHOD> <endpoint> [json_body]
# Config: WP_URL, WP_USER, WP_APP_PASSWORD  (see "Permissions, Data Flow & Consent" in SKILL.md)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# --- Config loading -----------------------------------------------------------
# Exactly TWO locations, both explicit. There is deliberately NO walk up the
# parent directories: whichever .env was found first used to become authoritative
# for WP_URL/WP_USER/WP_APP_PASSWORD, so anything that could drop a file in a
# parent directory could redirect your credentials to a host it controls.
#   1. $WP_ENV_FILE  — an explicit path (also how you switch between sites)
#   2. <skill>/.env  — the skill's own directory
# Only keys matching WP_[A-Z0-9_]+ are imported; every other line is ignored, so
# an env file cannot inject PATH, LD_PRELOAD or anything else into this process.
ENV_FILE=""
if [[ -n "${WP_ENV_FILE:-}" ]]; then
  # WP_ENV_FILE names the file holding your WordPress password, so it is TRUSTED
  # INPUT and is validated as such. A relative path would resolve against whatever
  # directory the caller happened to be in, and a world-writable or other-owned
  # file could be swapped to redirect WP_URL to an attacker's host and harvest the
  # credentials we are about to send.
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

# Validate required vars
: "${WP_URL:?Set WP_URL in .env}"
: "${WP_USER:?Set WP_USER in .env}"
: "${WP_APP_PASSWORD:?Set WP_APP_PASSWORD in .env}"

# HTTPS is mandatory. Credentials never leave over plaintext HTTP.
case "$WP_URL" in
  https://*) ;;
  *) echo "❌ WP_URL must be https:// (got: $WP_URL). Refusing to send credentials." >&2; exit 1 ;;
esac

# Host allowlist is always on. Default = the host of WP_URL itself, so a swapped
# URL cannot silently retarget the password. Extra hosts via WP_ALLOWED_HOSTS.
WP_HOST="${WP_URL#https://}"; WP_HOST="${WP_HOST%%/*}"; WP_HOST="${WP_HOST%%:*}"
WP_ALLOWED_HOSTS="${WP_ALLOWED_HOSTS:-$WP_HOST}"
if [[ ",${WP_ALLOWED_HOSTS// /}," != *",${WP_HOST},"* ]]; then
  echo "❌ WP_URL host '$WP_HOST' is not in WP_ALLOWED_HOSTS. Refusing to send credentials." >&2
  exit 1
fi

METHOD="${1:?Usage: wp.sh <GET|POST|PUT|PATCH|DELETE> <endpoint> [json_body]}"
ENDPOINT="${2:?Missing endpoint}"
BODY="${3:-}"

# Normalize
METHOD=$(echo "$METHOD" | tr '[:lower:]' '[:upper:]')
# Canonicalize before any gate: strip leading slashes, collapse //, lowercase.
ENDPOINT="${ENDPOINT#/}"
ENDPOINT="$(printf '%s' "$ENDPOINT" | tr -s '/' )"
ROUTE="${ENDPOINT%%\?*}"
ROUTE="$(printf '%s' "$ROUTE" | tr '[:upper:]' '[:lower:]')"
QUERY="${ENDPOINT#"${ENDPOINT%%\?*}"}"
URL="${WP_URL}/wp-json/wp/v2/${ENDPOINT}"

# --- OFF SWITCH ---------------------------------------------------------------
# WP_READONLY=1 (env, or in your .env file) makes this script incapable of
# changing anything: GET still works, every other method stops here.
if [[ -n "${WP_READONLY:-}" && "${WP_READONLY}" != "0" && "$METHOD" != "GET" ]]; then
  echo "🔒 WP_READONLY is set — $METHOD $ROUTE blocked. Unset WP_READONLY to allow writes." >&2
  exit 1
fi

# --- SAFETY: draft by default, publishing needs explicit consent ---------------
# New posts/pages are forced to draft. Going live — on create OR on update — needs
# WP_ALLOW_PUBLISH=1. This is the code behind the "draft-only safety" claim.
BODY_STATUS=""
if [[ -n "$BODY" ]]; then
  BODY_STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
fi

if [[ "$METHOD" == "POST" && ("$ROUTE" == "posts" || "$ROUTE" == "pages") ]]; then
  if [[ -z "$BODY" ]]; then
    BODY='{"status":"draft"}'
  elif [[ "$BODY_STATUS" != "publish" ]]; then
    BODY=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); d['status']='draft'; print(json.dumps(d))")
  fi
fi

if [[ "$BODY_STATUS" == "publish" && "$METHOD" != "GET" ]]; then
  if [[ "${WP_ALLOW_PUBLISH:-0}" != "1" ]]; then
    echo "❌ Publishing is gated. This would put content live at ${WP_URL} immediately." >&2
    echo "   Confirm with the site owner, then re-run with WP_ALLOW_PUBLISH=1." >&2
    exit 1
  fi
  echo "⚠️  WP_ALLOW_PUBLISH=1 — status=publish. Content goes live immediately." >&2
fi

# Editing an already-live post/page without sending status=publish still changes
# public content. PUT/PATCH on posts|pages therefore needs the same opt-in.
if [[ "$METHOD" == "PUT" || "$METHOD" == "PATCH" ]]; then
  case "$ROUTE" in
    posts|posts/*|pages|pages/*)
      if [[ "${WP_ALLOW_PUBLISH:-0}" != "1" ]]; then
        echo "❌ Editing live posts/pages is gated (a PUT/PATCH without status still changes public content)." >&2
        echo "   Re-run with WP_ALLOW_PUBLISH=1 once the site owner has agreed." >&2
        exit 1
      fi
      ;;
  esac
fi

# --- SAFETY: site administration needs explicit consent ------------------------
# Installing/activating a plugin or theme is arbitrary code execution on the site;
# users/settings changes are privilege and configuration changes. Reading them is
# free, writing them needs WP_ALLOW_ADMIN=1.
case "$ROUTE" in
  plugins|plugins/*|themes|themes/*|users|users/*|settings|settings/*)
    if [[ "$METHOD" != "GET" && "${WP_ALLOW_ADMIN:-0}" != "1" ]]; then
      echo "❌ $METHOD $ROUTE is a site-administration write and is gated." >&2
      echo "   Installing a plugin or theme runs code on the site; users/settings writes" >&2
      echo "   change who can do what. Re-run with WP_ALLOW_ADMIN=1 once the site owner" >&2
      echo "   has agreed to this specific change." >&2
      exit 1
    fi
    ;;
esac

# --- SAFETY: block permanent delete -------------------------------------------
# WordPress DELETE without force moves a post/page/comment to Trash (recoverable),
# and is the only way to trash on installs whose REST status enum omits "trash"
# (some WooCommerce/SureCart sites reject PUT {"status":"trash"} as
# rest_invalid_param). force=true is the permanent, unrecoverable delete and stays
# blocked — in the query string AND in the JSON body, since WP reads either.
if [[ "$METHOD" == "DELETE" ]]; then
  BODY_FORCE=""
  if [[ -n "$BODY" ]]; then
    BODY_FORCE=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('force',''))" 2>/dev/null || echo "")
  fi
  QUERY_LC="$(printf '%s' "$QUERY" | python3 -c 'import sys,urllib.parse; print(urllib.parse.unquote(sys.stdin.read()).lower())' 2>/dev/null || echo "$QUERY")"
  if [[ "$QUERY_LC" == *"force=true"* || "$QUERY_LC" == *"force=1"* \
     || "$BODY_FORCE" == "True" || "$BODY_FORCE" == "true" || "$BODY_FORCE" == "1" || "$BODY_FORCE" == "yes" ]]; then
    echo "❌ Permanent DELETE (force) blocked by safety policy. Drop force= to trash instead (recoverable)." >&2
    exit 1
  fi
fi

# Execute. Some sites sit behind Cloudflare, which challenges plain curl's TLS/JA3
# fingerprint ("Just a moment..." 403). curl_cffi impersonates Chrome's handshake
# and passes; fall back to plain curl when it is not installed.
if python3 -c "import curl_cffi" 2>/dev/null; then
  RESPONSE=$(WP_METHOD="$METHOD" WP_URL_FULL="$URL" WP_BODY="$BODY" \
    WP_AUTH_USER="$WP_USER" WP_AUTH_PW="$WP_APP_PASSWORD" python3 - <<'PY'
import os
from curl_cffi import requests
m=os.environ["WP_METHOD"]; url=os.environ["WP_URL_FULL"]; body=os.environ.get("WP_BODY","")
auth=(os.environ["WP_AUTH_USER"], os.environ["WP_AUTH_PW"].replace(" ",""))
kw=dict(impersonate="chrome", auth=auth, headers={"Content-Type":"application/json"}, timeout=60)
if body and m!="GET": kw["data"]=body.encode()
print(requests.request(m, url, **kw).text)
PY
)
else
  # Password stays in a 0600 netrc file, never on argv.
  NETRC=$(mktemp); chmod 600 "$NETRC"
  printf 'machine %s\nlogin %s\npassword %s\n' "$WP_HOST" "$WP_USER" "${WP_APP_PASSWORD// /}" > "$NETRC"
  CURL_ARGS=(-s -X "$METHOD" --netrc-file "$NETRC" -H "Content-Type: application/json")
  [[ -n "$BODY" && "$METHOD" != "GET" ]] && CURL_ARGS+=(-d "$BODY")
  RESPONSE=$(curl "${CURL_ARGS[@]}" "$URL")
  rm -f "$NETRC"
fi

# Pretty print if python3 available
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
