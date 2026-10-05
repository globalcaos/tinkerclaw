#!/usr/bin/env bash
# Focused tests for wordpress-ultimate safety gates. Runs against a COPY of the
# scripts in a throwaway skill dir — the real skill's .env is never read.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d /tmp/wp-skill.XXXXXX)
mkdir -p "$T/scripts"
cp "$SRC/scripts/wp.sh" "$SRC/scripts/wp-upload.sh" "$SRC/scripts/wp-credentials.sh" "$T/scripts/"
printf 'WP_URL=https://example.com\nWP_ALLOW_ADMIN=1\nWP_USER=t@example.com\nWP_APP_PASSWORD=aaaa bbbb cccc dddd\n' > "$T/.env"
chmod 600 "$T/.env"
WP="$T/scripts/wp.sh"
pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail+1)); }

run(){ local desc="$1" expect="$2" want="$3"; shift 4
  local out rc
  out=$(WP_DRY_RUN=1 "$WP" "$@" 2>&1); rc=$?
  if [[ "$expect" == block ]]; then
    if [[ $rc -eq 0 ]]; then no "$desc" "expected refusal, exited 0: $out"; return; fi
  else
    if [[ $rc -ne 0 ]]; then no "$desc" "expected success, exited $rc: $out"; return; fi
  fi
  if [[ -n "$want" && ! "$out" =~ $want ]]; then no "$desc" "output missing /$want/: $out"; return; fi
  ok "$desc"
}

echo "== route canonicalisation: the gate must see what the server will resolve =="
run "POST //plugins BLOCKED (was a bypass: gate saw '/plugins')" block "site-administration write" -- POST "//plugins" '{"slug":"x"}'
run "POST ///plugins BLOCKED"                        block "site-administration write" -- POST "///plugins" '{"slug":"x"}'
run "POST %70lugins BLOCKED (percent-encoded)"       block "site-administration write" -- POST "%70lugins" '{"slug":"x"}'
run "POST PLUGINS BLOCKED (case)"                    block "site-administration write" -- POST "PLUGINS" '{"slug":"x"}'
run "POST plugins/ BLOCKED (trailing slash)"         block "site-administration write" -- POST "plugins/" '{"slug":"x"}'
run "POST posts/../plugins REFUSED (traversal)"      block "relative path segment"      -- POST "posts/../plugins" '{"slug":"x"}'
run "POST plugins BLOCKED (baseline regression)"     block "site-administration write" -- POST "plugins" '{"slug":"x"}'
run "POST //users BLOCKED"                           block "site-administration write" -- POST "//users" '{"x":1}'
run "PUT //settings BLOCKED"                         block "site-administration write" -- PUT  "//settings" '{"x":1}'

echo "== admin reads stay free, and the URL is normalised =="
run "GET plugins allowed"                            allow "wp-json/wp/v2/plugins"      -- GET "plugins"
run "GET //plugins normalises the sent URL"          allow "wp/v2/plugins"              -- GET "//plugins"
out=$(WP_DRY_RUN=1 "$WP" GET "//plugins" 2>&1)
if [[ "$out" == *"wp/v2//plugins"* ]]; then no "no double slash in sent URL" "$out"; else ok "no double slash in sent URL"; fi

echo "== publish / draft / delete gates (regression) =="
run "POST posts status=publish gated"                block "Publishing is gated"        -- POST "posts" '{"title":"x","status":"publish"}'
run "PUT posts/42 gated"                             block "changes what visitors"     -- PUT  "posts/42" '{"title":"x"}'
run "PUT //posts/42 gated (was a bypass)"            block "changes what visitors"     -- PUT  "//posts/42" '{"title":"x"}'
run "DELETE posts/42?force=true blocked"             block "Permanent DELETE"           -- DELETE "posts/42?force=true"
run "DELETE posts/42?force=TRUE blocked (case)"      block "Permanent DELETE"           -- DELETE "posts/42?force=TRUE"
run "DELETE posts/42 (trash) gated without flag"     block "changes what visitors"      -- DELETE "posts/42"
out=$(WP_DRY_RUN=1 WP_ALLOW_PUBLISH=1 "$WP" DELETE "posts/42" 2>&1)
if [[ $? -eq 0 ]]; then ok "DELETE posts/42 (trash) allowed with WP_ALLOW_PUBLISH=1"; else no "DELETE posts/42 (trash) allowed with flag" "$out"; fi
out=$(WP_DRY_RUN=1 WP_ALLOW_PUBLISH=1 "$WP" POST posts '{"title":"x"}' 2>&1)
if [[ $? -eq 0 ]]; then ok "POST posts allowed with flag"; else no "POST posts allowed with flag" "$out"; fi

echo "== method override / route override: WordPress must act on what the gates checked =="
run "GET posts/42?_method=DELETE&force=true REFUSED"  block "_method"   -- GET "posts/42?_method=DELETE&force=true"
run "GET posts/42?%5fmethod=DELETE REFUSED (encoded)" block "refused"   -- GET "posts/42?%5fmethod=DELETE&force=true"
run "GET posts/42?_METHOD=DELETE REFUSED (case)"      block "refused"   -- GET "posts/42?_METHOD=DELETE"
run "GET posts/42?.method=DELETE REFUSED (PHP . -> _)" block "refused"  -- GET "posts/42?.method=DELETE"
run "GET posts/42?_method[]=DELETE REFUSED (array)"   block "refused"   -- GET "posts/42?_method%5B%5D=DELETE"
run "GET settings?_method=PUT REFUSED"                block "refused"   -- GET "settings?_method=PUT"
run "GET plugins?_method=POST REFUSED"                block "refused"   -- GET "plugins?_method=POST"
run "GET posts/42?_method=PUT REFUSED"                block "refused"   -- GET "posts/42?_method=PUT"
out=$(WP_DRY_RUN=1 WP_READONLY=1 "$WP" GET "posts/42?_method=DELETE&force=true" 2>&1); rc=$?
if [[ $rc -ne 0 ]]; then ok "WP_READONLY=1 + GET ?_method=DELETE refused"; else no "WP_READONLY=1 + GET ?_method=DELETE refused" "$out"; fi
run "GET posts?rest_route=/wp/v2/plugins REFUSED"     block "different route" -- GET "posts?rest_route=/wp/v2/plugins"
run "GET ?_method%00=DELETE&force%00=true REFUSED (NUL key)" block "control character" -- GET "posts/42?_method%00=DELETE&force%00=true"
run "GET ?_method%00x=DELETE REFUSED (NUL mid-key)"     block "control character" -- GET "posts/42?_method%00x=DELETE"
run "GET ?rest_route%00=/wp/v2/plugins REFUSED (NUL)"   block "control character" -- GET "posts?rest_route%00=/wp/v2/plugins"
run "GET ?x=a%0Ab REFUSED (control char in value)"      block "control character" -- GET "posts?x=a%0Ab"
run "GET posts%00/42 REFUSED (control char in path)"    block "control character" -- GET "posts%00/42"
out=$(WP_DRY_RUN=1 WP_READONLY=1 "$WP" GET "posts/42?_method%00=DELETE&force%00=true" 2>&1); rc=$?
if [[ $rc -ne 0 ]]; then ok "WP_READONLY=1 + GET ?_method%00=DELETE refused"; else no "WP_READONLY=1 + GET ?_method%00=DELETE refused" "$out"; fi
out=$(WP_DRY_RUN=1 WP_ALLOW_PUBLISH=1 "$WP" DELETE "posts/42?force%00=true" 2>&1); rc=$?
if [[ $rc -ne 0 ]]; then ok "WP_ALLOW_PUBLISH=1 DELETE ?force%00=true refused"; else no "WP_ALLOW_PUBLISH=1 DELETE ?force%00=true refused" "$out"; fi
run "POST posts?rest.route=/wp/v2/plugins REFUSED"    block "different route" -- POST "posts?rest.route=/wp/v2/plugins" '{}'
run "PROPFIND refused (unknown method)"               block "Unsupported method" -- PROPFIND "posts"

echo "== publish via query string / other routes / scheduled =="
run "POST posts/42?status=publish gated"             block "Publishing is gated"  -- POST "posts/42?status=publish" '{"title":"x"}'
run "POST posts/42 (update via POST) gated"          block "changes what visitors" -- POST "posts/42" '{"title":"x"}'
run "POST posts status=future gated"                 block "Publishing is gated"  -- POST "posts" '{"title":"x","status":"future"}'
run "POST categories status=publish gated (any route)" block "Publishing is gated" -- POST "categories" '{"name":"x","status":"publish"}'
run "POST comments gated"                            block "changes what visitors" -- POST "comments" '{"post":1,"content":"x"}'
run "POST media gated"                               block "changes what visitors" -- POST "media" '{}'
run "PUT categories/3 gated"                         block "changes what visitors" -- PUT "categories/3" '{"name":"x"}'
run "POST templates/x gated as admin (unknown route)" block "site-administration"  -- POST "templates/x" '{}'
run "POST categories free"                           allow ""                      -- POST "categories" '{"name":"x"}'
out=$(WP_DRY_RUN=1 "$WP" POST posts '{"title":"x","status":"pending"}' 2>&1)
if [[ $? -eq 0 ]]; then ok "POST posts status=pending allowed (forced to draft)"; else no "POST posts pending allowed" "$out"; fi
out=$(WP_DRY_RUN=1 WP_ALLOW_PUBLISH=1 "$WP" PUT "posts/42?status=draft&context=edit" '{"title":"x"}' 2>&1)
if [[ $? -eq 0 ]]; then ok "PUT posts/42?status=draft with flag allowed (no false force)"; else no "PUT posts/42?status=draft allowed" "$out"; fi
run "body that is not a JSON object refused"         block "JSON object"           -- POST "posts" '["status","publish"]'

echo "== permanent delete: every truthy spelling =="
for q in "force=yes" "force=on" "force=2" "force%3Dtrue" "force[]=1" "force=0&force=1"; do
  run "DELETE posts/42?$q blocked"                   block "" -- DELETE "posts/42?$q"
done
out=$(WP_DRY_RUN=1 WP_ALLOW_PUBLISH=1 "$WP" DELETE "posts/42?force=true" 2>&1); rc=$?
if [[ $rc -ne 0 && "$out" == *"Permanent DELETE"* ]]; then ok "force=true blocked even with WP_ALLOW_PUBLISH=1"; else no "force=true blocked with flag" "$out"; fi
out=$(WP_DRY_RUN=1 WP_ALLOW_PUBLISH=1 "$WP" DELETE "posts/42" '{"force":true}' 2>&1); rc=$?
if [[ $rc -ne 0 && "$out" == *"Permanent DELETE"* ]]; then ok "JSON force:true blocked"; else no "JSON force:true blocked" "$out"; fi
out=$(WP_DRY_RUN=1 WP_ALLOW_PUBLISH=1 "$WP" DELETE "posts/42?force=false" 2>&1); rc=$?
if [[ $rc -eq 0 ]]; then ok "force=false (trash) allowed with flag"; else no "force=false allowed" "$out"; fi

echo "== consent flags in the env file are ignored (per call only) =="
out=$(WP_DRY_RUN=1 "$WP" POST plugins '{"slug":"x"}' 2>&1); rc=$?
if [[ $rc -ne 0 && "$out" == *"Ignoring WP_ALLOW_ADMIN"* ]]; then ok "WP_ALLOW_ADMIN=1 in .env does not unlock admin writes"; else no "WP_ALLOW_ADMIN in .env ignored" "rc=$rc $out"; fi

echo "== destination parsing: the allowlist checks the host the client will connect to =="
dest(){ local desc="$1" expect="$2" url="$3" allow="$4" out rc
  out=$(WP_DRY_RUN=1 WP_URL="$url" WP_ALLOWED_HOSTS="$allow" "$WP" GET posts 2>&1); rc=$?
  if [[ "$expect" == block && $rc -ne 0 ]] || [[ "$expect" == allow && $rc -eq 0 ]]; then ok "$desc"; else no "$desc" "rc=$rc $out"; fi
}
dest "userinfo host confusion refused"   block 'https://allowed.example:443@evil.example' allowed.example
dest "userinfo without port refused"     block 'https://allowed.example@evil.example'     allowed.example
dest "suffix host not allowed"           block 'https://allowed.example.evil.example'     allowed.example
dest "backslash refused"                 block 'https://allowed.example\@evil.example'    allowed.example
dest "percent-escaped host refused"      block 'https://allowed%2eexample'                allowed.example
dest "query in WP_URL refused"           block 'https://allowed.example/?x=@evil.example' allowed.example
dest "http refused"                      block 'http://allowed.example'                   allowed.example
dest "trailing dot + uppercase accepted" allow 'https://ALLOWED.EXAMPLE./'                allowed.example
dest "allowlist entry case/dot ignored"  allow 'https://allowed.example'                  'other.example, Allowed.Example.'
dest "IPv6 literal accepted"             allow 'https://[::1]:8443/wp'                    '[::1]'
out=$(WP_DRY_RUN=1 WP_URL='https://ALLOWED.EXAMPLE.:8443/blog/' WP_ALLOWED_HOSTS=allowed.example "$WP" GET posts 2>&1)
if [[ "$out" == *"GET https://allowed.example:8443/blog/wp-json/wp/v2/posts"* ]]; then ok "request URL rebuilt from parsed parts"; else no "request URL rebuilt" "$out"; fi

echo "== media upload is gated (file goes public) =="
touch "$T/pic.png"
out=$("$T/scripts/wp-upload.sh" "$T/pic.png" 2>&1); rc=$?
if [[ $rc -ne 0 && "$out" == *"Media upload is gated"* ]]; then ok "wp-upload.sh refuses without WP_ALLOW_PUBLISH=1"; else no "wp-upload.sh gated" "rc=$rc $out"; fi

echo "== query strings survive normalisation =="
out=$(WP_DRY_RUN=1 "$WP" GET 'posts?search=a//b&per_page=5' 2>&1)
if [[ "$out" == *'search=a//b&per_page=5'* ]]; then ok "query value 'a//b' not mangled"; else no "query value 'a//b' not mangled" "$out"; fi

echo "== off switch =="
out=$(WP_DRY_RUN=1 WP_READONLY=1 "$WP" POST posts '{"t":1}' 2>&1); rc=$?
if [[ $rc -ne 0 && "$out" == *"WP_READONLY is set"* ]]; then ok "WP_READONLY=1 blocks POST"; else no "WP_READONLY=1 blocks POST" "$out"; fi
out=$(WP_DRY_RUN=1 WP_READONLY=1 "$WP" GET posts 2>&1); rc=$?
if [[ $rc -eq 0 ]]; then ok "WP_READONLY=1 still allows GET"; else no "WP_READONLY=1 still allows GET" "$out"; fi

echo "== implicit <skill>/.env now gets the SAME validation as WP_ENV_FILE =="
chmod 644 "$T/.env"
out=$(WP_DRY_RUN=1 "$WP" GET posts 2>&1); rc=$?
if [[ $rc -ne 0 && "$out" == *"group/world readable"* ]]; then ok "mode 0644 <skill>/.env refused (was unchecked)"; else no "mode 0644 <skill>/.env refused" "rc=$rc $out"; fi
chmod 600 "$T/.env"
mv "$T/.env" "$T/real.env"; ln -s "$T/real.env" "$T/.env"
out=$(WP_DRY_RUN=1 "$WP" GET posts 2>&1); rc=$?
if [[ $rc -ne 0 && "$out" == *"must not be a symlink"* ]]; then ok "symlinked <skill>/.env refused (was unchecked)"; else no "symlinked <skill>/.env refused" "rc=$rc $out"; fi
rm -f "$T/.env"; mv "$T/real.env" "$T/.env"; chmod 600 "$T/.env"

echo "== no secret on argv anywhere =="
if grep -qE 'curl[^|]*-u "\$\{?WP_USER' "$T/scripts/wp-upload.sh"; then no "wp-upload.sh has no curl -u" "found -u"; else ok "wp-upload.sh has no curl -u"; fi
if grep -q 'netrc-file' "$T/scripts/wp-upload.sh"; then ok "wp-upload.sh uses --netrc-file"; else no "wp-upload.sh uses --netrc-file" "not found"; fi
for f in wp.sh wp-upload.sh; do
  if grep -q 'wp-credentials.sh' "$T/scripts/$f"; then ok "$f sources the shared loader"; else no "$f sources the shared loader" "not found"; fi
done

echo "== netrc trap: no credential file survives a failure =="
if grep -q 'trap wp_netrc_cleanup' "$T/scripts/wp-credentials.sh"; then ok "netrc cleanup is trapped on EXIT/HUP/INT/TERM"; else no "netrc cleanup is trapped" "no trap"; fi

find "$T" -mindepth 1 -delete 2>/dev/null; rmdir "$T" 2>/dev/null
echo; echo "wordpress-ultimate: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
