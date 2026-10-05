#!/usr/bin/env bash
# Focused tests: owner data (allowlist, history series, state file) is found where the
# docs say, never silently swapped for another list, and never written from placeholders.
#
# Isolation: the scripts are COPIED into a mktemp dir together with the two *.example.json
# files only, so a real assets/ours-allowlist.json or history-series.json in your install
# is never read. HOME points at the temp dir, so ~/.config and ~/.openclaw resolve there.
# Every source used is offline (urls, gsc-csv). The gateway CLI is a stub that logs its
# argv; the suite aborts if `openclaw` would resolve to anything but that stub.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)" || { echo "node not found"; exit 2; }
H=$(mktemp -d /tmp/bl-cfg-test.XXXXXX)
trap 'find "$H" -mindepth 1 -delete 2>/dev/null; rmdir "$H" 2>/dev/null' EXIT

SK="$H/skill"; mkdir -p "$SK/assets"
cp -r "$SRC/scripts" "$SK/"
cp "$SRC/assets/ours-allowlist.example.json" "$SRC/assets/history-series.example.json" "$SK/assets/"
S="$SK/scripts/backlink-audit.mjs"; B="$SK/scripts/build-history.mjs"
STATE_DEFAULT="$H/.openclaw/workspace/memory/online-presence/inbound-campaign-state.json"

STUB="$H/stub-bin"; CLI_LOG="$H/cli-calls.log"; mkdir -p "$STUB"
cat > "$STUB/openclaw" <<'EOF'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$CLI_LOG"
EOF
chmod +x "$STUB/openclaw"; ln -s openclaw "$STUB/fake-cli"
export PATH="$STUB:$PATH" CLI_LOG
unset BACKLINK_AUDIT_ALLOWLIST BACKLINK_AUDIT_STATE BACKLINK_AUDIT_SERIES
if [[ "$(command -v openclaw)" != "$STUB/openclaw" ]]; then
  echo "ABORT: 'openclaw' resolves to $(command -v openclaw), not the test stub — refusing to touch a real gateway."
  exit 2
fi

pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail+1)); }
run(){ HOME="$H" "$NODE" "$S" "$@" 2>&1; }
runq(){ HOME="$H" "$NODE" "$S" "$@" 2>/dev/null; }
hist(){ HOME="$H" "$NODE" "$B" "$@" 2>&1; }
jget(){ "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);console.log(eval("o."+process.argv[1]))})' "$1"; }

URLS="https://mine.example/post,https://github.com/me-user/repo,https://github.com/other/x/issues/7,https://github.com/stranger/y,https://elsewhere.example/z"
mk_allow(){ # $1 = file, $2 = label domain
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<EOF
{ "rules": [ { "domain": "$2", "label": "site" }, { "domain": "github.com", "path_prefix": "/me-user", "label": "gh" } ],
  "ours_urls": [ "https://github.com/other/x/issues/7" ],
  "ambiguous_domains": { "domains": ["github.com"] } }
EOF
}

echo "== no allowlist of your own → the example is used, loudly =="
out=$(run t --source urls --urls "$URLS"); rc=$?
[[ $rc -eq 0 ]] && ok "runs with the placeholder example" || no "example run" "rc=$rc $out"
echo "$out" | grep -q "PLACEHOLDER example allowlist" && ok "warns that the allowlist is the placeholder" || no "example warning" "$out"
j=$(runq t --source urls --urls "$URLS" --json)
[[ "$(echo "$j" | jget allowlist_is_example)" == "true" ]] && ok "JSON report flags allowlist_is_example" || no "JSON flag" "$j"

echo "== --write-state refuses on the example, before any source runs =="
out=$(run t --source urls --urls "$URLS" --write-state --target-key my-repo); rc=$?
[[ $rc -ne 0 ]] && ok "--write-state exits non-zero on the example allowlist" || no "refuse on example" "rc=$rc"
[[ ! -e "$STATE_DEFAULT" ]] && ok "no state file was written" || no "state written from placeholders" "$(cat "$STATE_DEFAULT")"

echo "== a copied-but-unedited example is still treated as the example =="
mkdir -p "$H/.config/backlink-audit"; cp "$SK/assets/ours-allowlist.example.json" "$H/.config/backlink-audit/ours-allowlist.json"
out=$(run t --source urls --urls "$URLS" --write-state --target-key my-repo); rc=$?
[[ $rc -ne 0 ]] && echo "$out" | grep -q "placeholder" && ok "\"_example\": true in a user file still blocks --write-state" || no "_example marker" "rc=$rc $out"
rm -f "$H/.config/backlink-audit/ours-allowlist.json"

echo "== resolution order: assets < ~/.config < env < --allowlist =="
mk_allow "$SK/assets/ours-allowlist.json" "assets.example"
[[ "$(runq assets.example/x --source urls --urls https://assets.example/x --json | jget 'links[0].cls')" == "ours" ]] && ok "assets/ours-allowlist.json beside the script is used" || no "assets allowlist" "not used"
mk_allow "$H/.config/backlink-audit/ours-allowlist.json" "mine.example"
[[ "$(runq t --source urls --urls https://mine.example/p --json | jget allowlist)" == "~/.config/backlink-audit" ]] && ok "~/.config/backlink-audit/ours-allowlist.json beats assets" || no "user config precedence" "wrong source"
mk_allow "$H/env-allow.json" "env.example"
[[ "$(BACKLINK_AUDIT_ALLOWLIST="$H/env-allow.json" runq t --source urls --urls https://env.example/p --json | jget 'links[0].cls')" == "ours" ]] && ok "BACKLINK_AUDIT_ALLOWLIST beats ~/.config" || no "env precedence" "not ours"
mk_allow "$H/flag-allow.json" "flag.example"
[[ "$(BACKLINK_AUDIT_ALLOWLIST="$H/env-allow.json" runq t --source urls --urls https://flag.example/p --allowlist "$H/flag-allow.json" --json | jget 'links[0].cls')" == "ours" ]] && ok "--allowlist beats the env var" || no "flag precedence" "not ours"
out=$(run t --source urls --urls "$URLS" --allowlist "$H/nope.json"); rc=$?
[[ $rc -ne 0 ]] && echo "$out" | grep -q "does not exist" && ok "a missing --allowlist is an error, not a silent fallback" || no "missing explicit allowlist" "rc=$rc $out"
out=$(BACKLINK_AUDIT_ALLOWLIST="$H/nope.json" run t --source urls --urls "$URLS"); rc=$?
[[ $rc -ne 0 ]] && ok "a missing BACKLINK_AUDIT_ALLOWLIST is an error too" || no "missing env allowlist" "rc=$rc"

echo "== classification against ~/.config allowlist =="
j=$(runq t --source urls --urls "$URLS" --json)
[[ "$(echo "$j" | jget 'totals.ours')" == "3" && "$(echo "$j" | jget 'totals.ambiguous')" == "1" && "$(echo "$j" | jget 'totals.organic')" == "1" ]] \
  && ok "domain rule + path_prefix + ours_urls = 3 ours, 1 ambiguous, 1 organic" || no "classification" "$j"

echo "== --write-state: default path, --state, BACKLINK_AUDIT_STATE, key validation =="
out=$(run t --source urls --urls "$URLS" --write-state --target-key my-repo); rc=$?
[[ $rc -eq 0 && "$(jget 'inbound_targets["my-repo"].ours' < "$STATE_DEFAULT")" == "3" ]] && ok "writes inbound_targets.my-repo to the default state file" || no "default state write" "rc=$rc $out"
[[ "$(jget 'inbound_targets["my-repo"].external' < "$STATE_DEFAULT")" == "1" ]] && ok "external = organic only (ambiguous excluded)" || no "external count" "$(cat "$STATE_DEFAULT")"
run t --source urls --urls "$URLS" --write-state --target-key k2 --state "$H/custom/state.json" >/dev/null
[[ -e "$H/custom/state.json" ]] && ok "--state <path> redirects the write" || no "--state" "not written"
BACKLINK_AUDIT_STATE="$H/envstate.json" run t --source urls --urls "$URLS" --write-state --target-key k3 >/dev/null
[[ -e "$H/envstate.json" ]] && ok "BACKLINK_AUDIT_STATE redirects the write" || no "BACKLINK_AUDIT_STATE" "not written"
out=$(run t --source urls --urls "$URLS" --write-state --target-key "__proto__"); rc=$?
[[ $rc -ne 0 ]] && ok "an unsafe --target-key is refused" || no "target-key validation" "rc=$rc"
out=$(run t --source urls --urls "$URLS" --write-state); rc=$?
[[ $rc -ne 0 ]] && ok "--write-state without --target-key is refused" || no "missing target-key" "rc=$rc"

echo "== build-history: dry run by default, placeholder refusal, real write via --cli =="
out=$(hist); rc=$?
[[ $rc -eq 0 ]] && echo "$out" | grep -q "DRY RUN" && ok "bare run is a dry run" || no "bare dry run" "rc=$rc $out"
[[ ! -s "$CLI_LOG" ]] && ok "the dry run called no gateway CLI" || no "dry run wrote" "$(cat "$CLI_LOG")"
out=$(hist --yes); rc=$?
[[ $rc -ne 0 && ! -s "$CLI_LOG" ]] && ok "--yes on the example series is refused, nothing sent" || no "example --yes" "rc=$rc $(cat "$CLI_LOG" 2>/dev/null)"
cat > "$H/series.json" <<'EOF'
{ "series": { "graph.inbound.t.ours": [ { "date": "2026-01-01", "cumulative": 1 }, { "date": "2026-02-01", "cumulative": 2, "note": "n" } ] } }
EOF
out=$(hist --series "$H/series.json" --yes --dry-run); rc=$?
[[ $rc -eq 0 && ! -s "$CLI_LOG" ]] && ok "--dry-run wins over --yes" || no "--dry-run precedence" "$(cat "$CLI_LOG" 2>/dev/null)"
out=$(hist --series "$H/series.json" --yes --cli fake-cli); rc=$?
[[ $rc -eq 0 && "$(grep -c '^fake-cli gateway call control-panel.record --params ' "$CLI_LOG")" == "2" ]] && ok "--yes sends one control-panel.record per point via --cli" || no "real write" "rc=$rc $(cat "$CLI_LOG" 2>/dev/null)"
grep -q '"id":"graph.inbound.t.ours","value":2,"ts":1769947200000' "$CLI_LOG" && ok "params carry id, value and a noon-UTC ts" || no "params shape" "$(cat "$CLI_LOG")"
: > "$CLI_LOG"
mkdir -p "$H/.config/backlink-audit"; cp "$H/series.json" "$H/.config/backlink-audit/history-series.json"
out=$(hist); echo "$out" | grep -q "$H/.config/backlink-audit/history-series.json" && ok "~/.config/backlink-audit/history-series.json is picked up" || no "user series" "$out"
echo '{ "series": { "graph.inbound.t.ours": [ { "date": "someday", "cumulative": 1 } ] } }' > "$H/bad.json"
out=$(hist --series "$H/bad.json"); rc=$?
[[ $rc -ne 0 ]] && ok "a malformed series is rejected before anything is sent" || no "series validation" "rc=$rc"
out=$(hist --series "$H/missing.json"); rc=$?
[[ $rc -ne 0 ]] && ok "a missing --series is an error, not a fallback" || no "missing series" "rc=$rc"

echo "== shipped files carry placeholders only =="
"$NODE" -e 'const a=require(process.argv[1]); process.exit(a._example===true?0:1)' "$SRC/assets/ours-allowlist.example.json" && ok "example allowlist is marked _example" || no "_example marker" "missing"
"$NODE" -e 'const a=require(process.argv[1]); process.exit(a._example===true?0:1)' "$SRC/assets/history-series.example.json" && ok "example series is marked _example" || no "_example marker" "missing"

echo; echo "backlink-audit config: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
