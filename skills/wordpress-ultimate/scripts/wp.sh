#!/usr/bin/env bash
# WordPress REST API wrapper with draft-by-default safety and explicit consent gates.
# Usage: wp.sh <METHOD> <endpoint> [json_body]
#        wp.sh --login | --logout      (move the app password into/out of your OS keychain)
# Config: WP_URL, WP_USER, WP_APP_PASSWORD  (see "Permissions, Data Flow & Consent" in SKILL.md)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# --- Config loading -----------------------------------------------------------
# ONE loader, shared with wp-upload.sh. This script used to carry its own copy;
# the copies drifted and the drift WAS the bug — the explicit WP_ENV_FILE path was
# validated while the implicit <skill>/.env path got no symlink, ownership or mode
# check at all. Sourcing the shared loader means a fix cannot miss a caller.
# shellcheck source=wp-credentials.sh
. "$SCRIPT_DIR/wp-credentials.sh"

wp_load_env_file "$SKILL_DIR"
wp_require_https
wp_check_allowlist

# --- Keychain management ------------------------------------------------------
# wp-credentials.sh points users at these two commands when it refuses a plain
# file; they have to actually exist or that advice is a dead end.
case "${1:-}" in
  --login)
    : "${WP_USER:?Set WP_USER (env or env file) before --login}"
    echo "Paste the WordPress application password for ${WP_USER} @ ${WP_HOST}, then Ctrl-D:" >&2
    if wp_keychain_set; then
      echo "🔐 Stored in your OS keychain. You can now delete WP_APP_PASSWORD from your env file." >&2
      exit 0
    fi
    echo "❌ No usable OS keychain (install libsecret's secret-tool on Linux)." >&2
    echo "   Keep the password in a 0600 env file instead — it will warn on every use." >&2
    exit 1
    ;;
  --logout)
    : "${WP_USER:?Set WP_USER (env or env file) before --logout}"
    wp_keychain_clear
    echo "🔓 Keychain entry for ${WP_USER} @ ${WP_HOST} cleared (if one existed)." >&2
    echo "   This does NOT revoke the password. Revoke it in WordPress → Users → Profile →" >&2
    echo "   Application Passwords, and remove any WP_APP_PASSWORD line from your env file." >&2
    exit 0
    ;;
esac

wp_resolve_password

METHOD="${1:?Usage: wp.sh <GET|POST|PUT|PATCH|DELETE> <endpoint> [json_body]}"
ENDPOINT="${2:?Missing endpoint}"
BODY="${3:-}"

METHOD=$(printf '%s' "$METHOD" | tr '[:lower:]' '[:upper:]')
case "$METHOD" in
  GET|POST|PUT|PATCH|DELETE) ;;
  *) echo "❌ Unsupported method '$METHOD'. Use GET, POST, PUT, PATCH or DELETE." >&2; exit 1 ;;
esac

# --- Route canonicalisation ---------------------------------------------------
# SAFETY: the consent gates below match on the route, so the route they match MUST
# be the route the server will actually resolve. It used to not be: only ONE leading
# slash was stripped, so `//plugins` reached the gates as `/plugins`, matched no
# case arm, and sailed past WP_ALLOW_ADMIN while the server still routed it to
# /plugins. Percent-encoding (`%70lugins`) and traversal (`posts/../plugins`) had
# the same effect. Three rules close it:
#   1. Split path from query FIRST, so query values are never mangled.
#   2. Normalise the path (all leading slashes, repeated slashes, trailing slash)
#      and send THAT — request and gate see one string.
#   3. Gate on the percent-DECODED path, i.e. on what the server will resolve, and
#      refuse `.` / `..` segments outright rather than trying to resolve them.
REQ_PATH="${ENDPOINT%%\?*}"
if [[ "$ENDPOINT" == *\?* ]]; then QUERY="?${ENDPOINT#*\?}"; else QUERY=""; fi

wp_normalize_path() {
  local p="$1"
  while [[ "$p" == /* ]]; do p="${p#/}"; done
  p="$(printf '%s' "$p" | tr -s '/')"
  while [[ "$p" == */ ]]; do p="${p%/}"; done
  printf '%s' "$p"
}

REQ_PATH="$(wp_normalize_path "$REQ_PATH")"
[[ -n "$REQ_PATH" ]] || { echo "❌ Empty endpoint after normalisation." >&2; exit 1; }

# What the server sees after it percent-decodes. This is the string the gates read.
# A decoded control character (NUL, CR, LF, ...) in the path would be dropped or
# split by the shell here but kept by the server, so gate and server would disagree.
if ! WP_P="$REQ_PATH" python3 -c 'import os,re,sys,urllib.parse; sys.exit(1 if re.search(r"[\x00-\x1f\x7f]", urllib.parse.unquote(os.environ["WP_P"])) else 0)'; then
  echo "❌ Endpoint path contains an encoded control character (e.g. %00): $ENDPOINT" >&2
  exit 1
fi
ROUTE="$(printf '%s' "$REQ_PATH" \
  | python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.unquote(sys.stdin.read()))' 2>/dev/null \
  || printf '%s' "$REQ_PATH")"
ROUTE="$(wp_normalize_path "$ROUTE")"
ROUTE="$(printf '%s' "$ROUTE" | tr '[:upper:]' '[:lower:]')"

case "/$ROUTE/" in
  */../*|*/./*)
    echo "❌ Endpoint contains a relative path segment ('.' or '..'): $ENDPOINT" >&2
    echo "   Refusing — the server would resolve it to a different route than the safety gates see." >&2
    exit 1 ;;
esac

URL="${WP_URL}/wp-json/wp/v2/${REQ_PATH}${QUERY}"

# --- SAFETY: the method and route the gates see are the ones WordPress uses ------
# WordPress lets a query string override both: `?_method=DELETE` turns a GET into a
# DELETE, and `?rest_route=/wp/v2/plugins` re-routes any /wp-json/ URL. Either one
# made the server act on a different method or route than every gate below had
# checked, so `GET "posts/42?_method=DELETE&force=true"` slipped past WP_READONLY and
# the permanent-delete block. The method is already an explicit argument and the
# route is the path, so both parameters are refused outright. Keys are compared the
# way PHP builds $_GET: percent/plus-decoded, leading spaces dropped, '.' and ' '
# turned into '_', and anything from '[' on stripped. PHP also takes the key with
# strlen(), so it ends at the first NUL: `_method%00=DELETE` is $_GET['_method'].
# Rather than chase every C-string quirk, any key or value holding a decoded control
# character (NUL, CR, LF, ...) is refused outright, and the key is cut at NUL too.
# The same parse extracts every `status` and `force` value for the gates below.
QUERY_INFO="$(WP_QUERY="${QUERY#\?}" python3 - <<'PY_Q'
import os, re, sys, urllib.parse
q = os.environ["WP_QUERY"]
CTRL = re.compile(r"[\x00-\x1f\x7f]")
def php_key(k):
    if "\0" in k:
        k = k[:k.index("\0")]
    k = k.lstrip(" ")
    if "[" in k:
        k = k[:k.index("[")]
    return re.sub(r"[ .]", "_", k).lower()
status, force = [], []
for k, v in urllib.parse.parse_qsl(q, keep_blank_values=True):
    if CTRL.search(k) or CTRL.search(v):
        sys.stderr.write("❌ Query parameter %r is refused: it contains a control character (e.g. %%00). PHP cuts a key at NUL, so the server could read a different parameter than the safety gates checked.\n" % k)
        sys.exit(2)
    key = php_key(k)
    if key in ("_method", "rest_route"):
        sys.stderr.write("❌ Query parameter '%s' is refused: it makes WordPress use a different %s than the safety gates checked. Pass the method as the first argument and the route as the endpoint.\n" % (k, "method" if key == "_method" else "route"))
        sys.exit(2)
    if key == "status":
        status.extend(s.strip().lower() for s in v.split(","))
    if key == "force":
        force.append(v.strip().lower())
print(",".join(status))
print(",".join(force))
print("end")  # command substitution strips trailing newlines; keep line 2 intact
PY_Q
)" || exit 1
{ IFS= read -r QS_LINE; IFS= read -r QF_LINE; } <<<"$QUERY_INFO"
IFS=',' read -r -a QUERY_STATUS <<<"$QS_LINE"
IFS=',' read -r -a QUERY_FORCE <<<"$QF_LINE"

# --- OFF SWITCH ---------------------------------------------------------------
# WP_READONLY=1 (env, or in your .env file) makes this script incapable of
# changing anything: GET still works, every other method stops here.
if [[ -n "${WP_READONLY:-}" && "${WP_READONLY}" != "0" && "$METHOD" != "GET" ]]; then
  echo "🔒 WP_READONLY is set — $METHOD $ROUTE blocked. Unset WP_READONLY to allow writes." >&2
  exit 1
fi

# Body fields the gates read. A body that is not a JSON object is refused on writes,
# because the gates could not tell what it asks for.
BODY_STATUS=""; BODY_FORCE=""
if [[ -n "$BODY" && "$METHOD" != "GET" ]]; then
  BODY_INFO="$(printf '%s' "$BODY" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if not isinstance(d, dict): sys.exit(1)
f = d.get("force", "")
print(str(d.get("status", "")).strip().lower())
print(("true" if f is True else "false" if f is False else str(f)).strip().lower())
print("end")
' 2>/dev/null)" || { echo "❌ The JSON body must be a single JSON object." >&2; exit 1; }
  { IFS= read -r BODY_STATUS; IFS= read -r BODY_FORCE; } <<<"$BODY_INFO"
fi

# WordPress reads a boolean as false only for "", "0" and "false"; anything else is true.
wp_truthy() { local v; for v in "$@"; do [[ -z "$v" || "$v" == "0" || "$v" == "false" ]] || return 0; done; return 1; }

# --- SAFETY: block permanent delete -------------------------------------------
# WordPress DELETE without force moves a post/page/comment to Trash (recoverable).
# force=true is the permanent, unrecoverable delete and stays blocked for every
# method and every truthy spelling, in the query string AND the JSON body.
if [[ "$METHOD" != "GET" ]] && wp_truthy "$BODY_FORCE" "${QUERY_FORCE[@]}"; then
  echo "❌ Permanent DELETE (force) blocked by safety policy. Drop force= to trash instead (recoverable)." >&2
  exit 1
fi

# --- SAFETY: route policy for every write -------------------------------------
# GET is always free. For every other method the route decides which consent the
# call needs. Routes the script does not know are treated as site administration,
# so a new or custom endpoint fails closed instead of open.
#   free                 POST posts | POST pages (forced to draft below)
#                        POST categories | POST tags (a new, empty term)
#   WP_ALLOW_PUBLISH=1   anything else on posts, pages, comments, media, categories,
#                        tags: editing, trashing, uploading, moderating
#   WP_ALLOW_ADMIN=1     plugins, themes, users, settings, and every other route
NEED=""
if [[ "$METHOD" != "GET" ]]; then
  case "$METHOD $ROUTE" in
    "POST posts"|"POST pages"|"POST categories"|"POST tags") NEED="" ;;
    *" plugins"|*" plugins/"*|*" themes"|*" themes/"*|*" users"|*" users/"*|*" settings"|*" settings/"*) NEED="admin" ;;
    *" posts/"*|*" pages/"*|*" comments"|*" comments/"*|*" media"|*" media/"*|*" categories/"*|*" tags/"*) NEED="publish" ;;
    *) NEED="admin" ;;
  esac
fi

# Going live on ANY route — status publish or future (scheduled), in the body OR the
# query string, since WordPress reads either — needs WP_ALLOW_PUBLISH=1 too.
GOES_LIVE=0
if [[ "$METHOD" != "GET" ]]; then
  for st in "$BODY_STATUS" "${QUERY_STATUS[@]}"; do
    [[ "$st" == "publish" || "$st" == "future" ]] && GOES_LIVE=1
  done
fi

if [[ "$NEED" == "admin" && "${WP_ALLOW_ADMIN:-0}" != "1" ]]; then
  echo "❌ $METHOD $ROUTE is a site-administration write and is gated." >&2
  echo "   Installing a plugin or theme runs code on the site; users/settings writes" >&2
  echo "   change who can do what; routes this script does not know are treated the same." >&2
  echo "   Re-run with WP_ALLOW_ADMIN=1 once the site owner has agreed to this specific change." >&2
  exit 1
fi
if [[ ( "$NEED" == "publish" || $GOES_LIVE -eq 1 ) && "${WP_ALLOW_PUBLISH:-0}" != "1" ]]; then
  if [[ $GOES_LIVE -eq 1 ]]; then
    echo "❌ Publishing is gated. This would put content live at ${WP_URL}." >&2
  else
    echo "❌ $METHOD $ROUTE changes what visitors can see (editing live posts/pages, media, comments or terms) and is gated." >&2
  fi
  echo "   Confirm with the site owner, then re-run with WP_ALLOW_PUBLISH=1." >&2
  exit 1
fi
[[ $GOES_LIVE -eq 1 ]] && echo "⚠️  WP_ALLOW_PUBLISH=1 — status=publish/future. Content goes live." >&2

# --- SAFETY: draft by default --------------------------------------------------
# New posts/pages are written with status=draft unless the call carries publish or
# future AND passed the WP_ALLOW_PUBLISH gate above.
if [[ "$METHOD" == "POST" && ("$ROUTE" == "posts" || "$ROUTE" == "pages") && $GOES_LIVE -eq 0 ]]; then
  if [[ -z "$BODY" ]]; then
    BODY='{"status":"draft"}'
  else
    BODY=$(printf '%s' "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); d['status']='draft'; print(json.dumps(d))")
  fi
fi

# Dry run: print the gate decision and the exact URL without sending anything.
if [[ -n "${WP_DRY_RUN:-}" && "${WP_DRY_RUN}" != "0" ]]; then
  echo "DRY RUN: $METHOD $URL"
  echo "ROUTE: $ROUTE"
  exit 0
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
  # Password stays in a 0600 netrc file, never on argv. wp_netrc_create installs an
  # EXIT/HUP/INT/TERM trap, so a curl failure under `set -e` cannot leave the
  # credential file behind — which is exactly what the previous version did.
  wp_netrc_create
  CURL_ARGS=(-s -X "$METHOD" --netrc-file "$WP_NETRC" -H "Content-Type: application/json")
  [[ -n "$BODY" && "$METHOD" != "GET" ]] && CURL_ARGS+=(-d "$BODY")
  RESPONSE=$(curl "${CURL_ARGS[@]}" "$URL")
  wp_netrc_cleanup
fi

# Pretty print if python3 available
printf '%s\n' "$RESPONSE" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RESPONSE"
