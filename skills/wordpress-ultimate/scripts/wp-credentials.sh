#!/usr/bin/env bash
# Shared credential handling for wp.sh and wp-upload.sh.
#
# This file exists because the two scripts used to carry their own copy of the
# loader. The copies drifted, and the drift WAS the bug: the explicit
# WP_ENV_FILE path was validated while the implicit <skill>/.env path was not.
# One loader, sourced by both, means a fix cannot miss a caller.
#
# Order of precedence for the application password:
#   1. WP_APP_PASSWORD already in the environment  (explicit, ephemeral)
#   2. OS keychain                                 (preferred at rest)
#   3. WP_ENV_FILE / <skill>/.env                  (plain file — WARNED fallback)

# --- portable stat -------------------------------------------------------------
# GNU coreutils and BSD/macOS disagree on stat's flags. The previous version used
# `stat -c` only, so on macOS the ownership check could never succeed and a valid
# WP_ENV_FILE was rejected outright. A safety control that only ever fails is not
# a safety control.
wp_stat_owner() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1" 2>/dev/null || echo ""; }
wp_stat_mode()  { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo ""; }

# --- secret-file validation ----------------------------------------------------
# Applied to EVERY file we are willing to read a password out of, named or
# implicit. A file holding your WordPress password is trusted input: if another
# local user can rewrite it, they can point WP_URL at a host they control and
# collect the credential we are about to send.
wp_validate_secret_file() {
  local f="$1" label="$2" owner perm
  if [[ -L "$f" ]]; then
    echo "❌ $label must not be a symlink ($f) — refusing to read credentials from it." >&2; exit 1
  fi
  if [[ ! -f "$f" ]]; then
    echo "❌ $label=$f does not exist" >&2; exit 1
  fi
  owner="$(wp_stat_owner "$f")"
  if [[ -z "$owner" || "$owner" != "$(id -u)" ]]; then
    echo "❌ $label must be owned by you ($f) — refusing to read credentials from it." >&2; exit 1
  fi
  perm="$(wp_stat_mode "$f")"
  if [[ -z "$perm" || "${perm: -2}" != "00" ]]; then
    echo "❌ $label is group/world readable or writable (mode ${perm:-unknown}). Run: chmod 600 $f" >&2; exit 1
  fi
}

# --- env file loading ----------------------------------------------------------
# Exactly TWO locations, both explicit, and NO walk up the parent directories:
#   1. $WP_ENV_FILE  — an explicit absolute path (also how you switch sites)
#   2. <skill>/.env  — the skill's own directory
# Only keys matching WP_[A-Z0-9_]+ are imported, so an env file cannot inject
# PATH, LD_PRELOAD or anything else. Variables already present in the environment
# WIN over the file: what you passed explicitly cannot be overridden by a file
# someone else may have written.
WP_ENV_FILE_USED=""
wp_load_env_file() {
  local skill_dir="$1" env_file="" key value
  if [[ -n "${WP_ENV_FILE:-}" ]]; then
    [[ "$WP_ENV_FILE" = /* ]] || { echo "❌ WP_ENV_FILE must be an ABSOLUTE path (got: $WP_ENV_FILE)" >&2; exit 1; }
    wp_validate_secret_file "$WP_ENV_FILE" "WP_ENV_FILE"
    env_file="$WP_ENV_FILE"
  elif [[ -e "$skill_dir/.env" || -L "$skill_dir/.env" ]]; then
    # The implicit file gets the IDENTICAL checks. It used to get none.
    wp_validate_secret_file "$skill_dir/.env" "<skill>/.env"
    env_file="$skill_dir/.env"
  fi
  [[ -n "$env_file" ]] || return 0
  WP_ENV_FILE_USED="$env_file"
  while IFS='=' read -r key value; do
    key="$(printf '%s' "${key:-}" | tr -d '[:space:]')"
    [[ "$key" =~ ^WP_[A-Z0-9_]+$ ]] || continue
    # Consent flags are per call. A WP_ALLOW_* line in a file would be standing
    # consent that nobody gives at the moment of the write, so it is ignored.
    if [[ "$key" == WP_ALLOW_* ]]; then
      echo "⚠️  Ignoring $key in $env_file — consent flags are only read from the command's own environment." >&2
      continue
    fi
    [[ -n "${!key:-}" ]] && continue   # environment wins over file
    value="${value%$'\r'}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key"="$value"
  done < "$env_file"
}

# --- destination validation ----------------------------------------------------
# Both run BEFORE the password is resolved, so a bad destination is rejected
# while the secret is still at rest.
#
# WP_URL is parsed with a real URL parser, and the request is sent to a URL REBUILT
# from the parsed parts — never to the raw string. The previous version cut the
# host out with shell substring ops, so `https://allowed.example:443@evil.example`
# passed the allowlist as `allowed.example` while the HTTP client connected to
# `evil.example` and handed it the password. Userinfo, query, fragment, backslashes,
# whitespace, control characters and percent-escapes in the authority are refused.
wp_require_https() {
  : "${WP_URL:?Set WP_URL (env, keychain-independent) or in your env file}"
  local parsed
  parsed="$(WP_URL_RAW="$WP_URL" python3 - <<'PY_URL'
import os, re, sys, urllib.parse
raw = os.environ["WP_URL_RAW"]
def die(msg):
    sys.stderr.write("❌ WP_URL rejected: %s (got: %r). Refusing to send credentials.\n" % (msg, raw))
    sys.exit(1)
if re.search(r"[\x00-\x20\x7f\\]", raw):
    die("contains whitespace, a control character or a backslash")
try:
    u = urllib.parse.urlsplit(raw)
    port = u.port
except ValueError as e:
    die("unparseable (%s)" % e)
if u.scheme != "https":
    die("must be https://")
if "@" in u.netloc or u.username is not None or u.password is not None:
    die("must not contain user information ('@')")
if "%" in u.netloc:
    die("must not contain percent-escapes in the host")
if u.query or u.fragment or "?" in raw or "#" in raw:
    die("must not contain a query string or fragment")
host = (u.hostname or "").rstrip(".").lower()
if not host or not re.fullmatch(r"[a-z0-9.\-]+|[0-9a-f:.]+", host) or ".." in host:
    die("has no valid hostname")
path = u.path.rstrip("/")
if path and not re.fullmatch(r"(/[A-Za-z0-9._~\-]+)+", path):
    die("path may only contain letters, digits and . _ ~ - segments")
if any(seg in (".", "..") for seg in path.split("/")):
    die("path must not contain . or .. segments")
netloc = ("[%s]" % host) if ":" in host else host
if port is not None:
    netloc += ":%d" % port
print(host)
print("https://" + netloc + path)
PY_URL
)" || exit 1
  WP_HOST="${parsed%%$'\n'*}"
  WP_URL="${parsed#*$'\n'}"
  export WP_HOST WP_URL
}

# WP_ALLOWED_HOSTS is a comma-separated list of exact hostnames (case-insensitive,
# trailing dot ignored). Unset, the only allowed host is the one parsed from WP_URL.
wp_check_allowlist() {
  local entry allowed="${WP_ALLOWED_HOSTS:-$WP_HOST}" ok=0
  local IFS=','
  for entry in $allowed; do
    entry="$(printf '%s' "$entry" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    entry="${entry#[}"; entry="${entry%]}"; entry="${entry%.}"
    [[ -n "$entry" && "$entry" == "$WP_HOST" ]] && { ok=1; break; }
  done
  if [[ $ok -ne 1 ]]; then
    echo "❌ WP_URL host '$WP_HOST' is not in WP_ALLOWED_HOSTS. Refusing to send credentials." >&2
    exit 1
  fi
}

# --- OS keychain ---------------------------------------------------------------
# libsecret (secret-tool) on Linux, Keychain Services (security) on macOS.
# Absent on a machine with neither, which is why the file fallback survives.
WP_KEYCHAIN_SERVICE="wordpress-ultimate"
wp_keychain_kind() {
  if command -v secret-tool >/dev/null 2>&1; then echo "secret-tool"
  elif command -v security  >/dev/null 2>&1 && [[ "$(uname -s)" == "Darwin" ]]; then echo "security"
  else echo "none"; fi
}

wp_keychain_get() {
  case "$(wp_keychain_kind)" in
    secret-tool) secret-tool lookup service "$WP_KEYCHAIN_SERVICE" host "$WP_HOST" account "$WP_USER" 2>/dev/null || true ;;
    security)    security find-generic-password -s "${WP_KEYCHAIN_SERVICE}:${WP_HOST}" -a "$WP_USER" -w 2>/dev/null || true ;;
    *)           printf '' ;;
  esac
}

# Password arrives on STDIN, never on argv.
wp_keychain_set() {
  case "$(wp_keychain_kind)" in
    secret-tool) secret-tool store --label="WordPress app password (${WP_HOST})" \
                   service "$WP_KEYCHAIN_SERVICE" host "$WP_HOST" account "$WP_USER" ;;
    security)    security add-generic-password -U -s "${WP_KEYCHAIN_SERVICE}:${WP_HOST}" -a "$WP_USER" -w ;;
    *)           return 1 ;;
  esac
}

wp_keychain_clear() {
  case "$(wp_keychain_kind)" in
    secret-tool) secret-tool clear service "$WP_KEYCHAIN_SERVICE" host "$WP_HOST" account "$WP_USER" 2>/dev/null || true; return 0 ;;
    security)    security delete-generic-password -s "${WP_KEYCHAIN_SERVICE}:${WP_HOST}" -a "$WP_USER" >/dev/null 2>&1 || true; return 0 ;;
    *)           return 0 ;;
  esac
}

# --- password resolution -------------------------------------------------------
WP_SECRET_SOURCE=""
wp_resolve_password() {
  : "${WP_USER:?Set WP_USER in your env file}"
  if [[ -n "${WP_APP_PASSWORD:-}" ]]; then
    # Set in the environment, or imported from the env file by wp_load_env_file.
    if [[ -n "$WP_ENV_FILE_USED" ]] && grep -qE '^[[:space:]]*WP_APP_PASSWORD[[:space:]]*=' "$WP_ENV_FILE_USED" 2>/dev/null; then
      WP_SECRET_SOURCE="file"
      echo "⚠️  Your WordPress application password is sitting in a plain file ($WP_ENV_FILE_USED)." >&2
      echo "   It is mode 0600 and owned by you, but a file is not a keychain. Move it with:" >&2
      echo "     scripts/wp.sh --login        (stores it in your OS keychain)" >&2
      echo "   Then delete the WP_APP_PASSWORD line from that file." >&2
    else
      WP_SECRET_SOURCE="env"
    fi
    export WP_APP_PASSWORD
    return 0
  fi
  local pw; pw="$(wp_keychain_get)"
  if [[ -n "$pw" ]]; then
    WP_APP_PASSWORD="$pw"; export WP_APP_PASSWORD; WP_SECRET_SOURCE="keychain"; return 0
  fi
  echo "❌ No WordPress application password for ${WP_USER} @ ${WP_HOST}." >&2
  echo "   Store one in your OS keychain:  scripts/wp.sh --login" >&2
  echo "   Or set WP_APP_PASSWORD in your env file (0600, owned by you)." >&2
  exit 1
}

# Load config, validate the destination, then resolve the secret. One call.
wp_bootstrap() {
  wp_load_env_file "$1"
  wp_require_https
  wp_check_allowlist
  wp_resolve_password
}

# --- netrc for the plain-curl fallback -----------------------------------------
# Keeps the password off argv. The trap is the point: without it, a signal or a
# curl failure between create and delete leaves a credential file behind, which
# is exactly what the previous version did.
WP_NETRC=""
wp_netrc_cleanup() {
  if [[ -n "${WP_NETRC:-}" ]]; then rm -f -- "$WP_NETRC"; WP_NETRC=""; fi
  return 0
}
trap wp_netrc_cleanup EXIT HUP INT TERM

wp_netrc_create() {
  WP_NETRC="$(mktemp "${TMPDIR:-/tmp}/wp-netrc.XXXXXXXXXX")" || { echo "❌ could not create a temporary credential file" >&2; exit 1; }
  chmod 600 "$WP_NETRC" || { echo "❌ could not restrict the temporary credential file" >&2; exit 1; }
  printf 'machine %s\nlogin %s\npassword %s\n' \
    "$WP_HOST" "$WP_USER" "${WP_APP_PASSWORD// /}" > "$WP_NETRC" \
    || { echo "❌ could not write the temporary credential file" >&2; exit 1; }
}
