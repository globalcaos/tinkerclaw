#!/usr/bin/env bash
# Focused tests: the backlinks.sh API key lives in the OS keychain or nowhere.
#
# Isolation: redirecting HOME is NOT enough — the OS keychain is not under HOME. So
# every run puts stub `secret-tool` and `security` executables first on PATH. The stubs
# keep their "keychain" in a file inside the temp dir, and the suite aborts before
# running anything if either name would resolve to a real binary. Your real keychain
# entry (service backlinks-sh, account api-key) is never read, written or cleared.
#
# No network either: every node run preloads a small module (--import) that replaces
# fetch() with a local fake returning an empty result and logging the request to the
# temp dir, so the suite never contacts api.backlinks.sh or any other host.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
S="$SRC/scripts/backlink-audit.mjs"
NODE="$(command -v node)" || { echo "node not found"; exit 2; }
H=$(mktemp -d /tmp/bl-test.XXXXXX)
trap 'find "$H" -mindepth 1 -delete 2>/dev/null; rmdir "$H" 2>/dev/null' EXIT
CRED="$H/.config/backlinks-sh/credentials.json"
STUB="$H/stub-bin"; STORE="$H/stub-keychain"; CALLS="$H/stub-calls.log"
mkdir -p "$STUB"

# One stub serves both names. STUB_MODE=absent -> behaves like a missing/locked keychain
# (exit 1). STUB_MODE=present -> a file-backed keychain under $H.
cat > "$STUB/keychain-stub" <<'EOF'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$STUB_CALLS"
[[ "${STUB_MODE:-absent}" == present ]] || exit 1
case "$(basename "$0") $1" in
  "secret-tool store")  cat > "$STUB_STORE" ;;
  "secret-tool lookup") [[ -s "$STUB_STORE" ]] && cat "$STUB_STORE" || exit 1 ;;
  "secret-tool clear")  rm -f "$STUB_STORE" ;;
  "security -i")        sed -n 's/.* -w "\(.*\)"$/\1/p' > "$STUB_STORE" ;;
  "security find-generic-password")   [[ -s "$STUB_STORE" ]] && cat "$STUB_STORE" || exit 1 ;;
  "security delete-generic-password") [[ -e "$STUB_STORE" ]] && rm -f "$STUB_STORE" || exit 1 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$STUB/keychain-stub"
ln -s keychain-stub "$STUB/secret-tool"
ln -s keychain-stub "$STUB/security"
export PATH="$STUB:$PATH" STUB_CALLS="$CALLS" STUB_STORE="$STORE"

# Offline fetch: records "<url> x-api-key=<value>" and answers with an empty backlink list.
FETCHES="$H/fetch-calls.log"; NONET="$H/no-network.mjs"
cat > "$NONET" <<'EOF'
import fs from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  const key = new Headers(init.headers).get("x-api-key");
  fs.appendFileSync(process.env.FETCH_LOG, `${url} x-api-key=${key}\n`);
  return new Response(JSON.stringify({ status: "no_data", data: { backlinks: [] } }), { status: 200 });
};
EOF
export FETCH_LOG="$FETCHES"

# Hard guard: refuse to run a single test if a real keychain binary could be reached.
for b in secret-tool security; do
  if [[ "$(command -v "$b")" != "$STUB/$b" ]]; then
    echo "ABORT: '$b' resolves to $(command -v "$b"), not the test stub — refusing to touch a real keychain."
    exit 2
  fi
done

pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "$2"; fail=$((fail+1)); }
run(){ HOME="$H" "$NODE" --import "$NONET" "$S" "$@" 2>&1; }

echo "== --login refuses instead of writing a plaintext file (no keychain) =="
out=$(printf %s 'sk-secret-value' | STUB_MODE=absent run --login); rc=$?
if [[ $rc -ne 0 ]]; then ok "--login exits non-zero when no keychain is available"; else no "--login exit code" "rc=$rc"; fi
if [[ ! -e "$CRED" ]]; then ok "no credentials.json was created (was: written silently at 0600)"; else no "no plaintext file created" "$CRED exists: $(cat "$CRED")"; fi
echo "$out" | grep -q "will not fall back to a plaintext file" && ok "--login says why it refused" || no "--login explains refusal" "$out"
echo "$out" | grep -q "BACKLINKS_SH_API_KEY" && ok "--login offers the env-var route instead" || no "--login offers alternative" "$out"
if ! grep -rq --exclude=stub-calls.log 'sk-secret-value' "$H" 2>/dev/null; then ok "the key appears nowhere under HOME"; else no "key leaked to disk" "$(grep -rl 'sk-secret-value' "$H")"; fi
if [[ -s "$CALLS" ]]; then ok "keychain calls went to the test stub, not a real keychain"; else no "stub was invoked" "no stub calls recorded"; fi
if ! grep -q 'sk-secret-value' "$CALLS" 2>/dev/null; then ok "the key never appeared as a keychain-tool argument"; else no "key on argv" "$(cat "$CALLS")"; fi

echo "== --login still refuses a key on argv (stdin only) =="
out=$(HOME="$H" "$NODE" --import "$NONET" "$S" --login </dev/null 2>&1); rc=$?
echo "$out" | grep -q "STDIN" && ok "--login with no stdin points at STDIN, never argv" || no "--login stdin guidance" "$out"

echo "== --login / --logout round-trip against the stub keychain =="
out=$(printf %s 'stub-only-key' | STUB_MODE=present run --login); rc=$?
if [[ $rc -eq 0 ]] && [[ "$(cat "$STORE" 2>/dev/null)" == "stub-only-key" ]]; then ok "--login stores the key in the (stubbed) keychain"; else no "--login stores key" "rc=$rc out=$out"; fi
if [[ ! -e "$CRED" ]]; then ok "a successful --login still writes no credentials.json"; else no "no file on success" "exists"; fi
out=$(STUB_MODE=present run --logout); rc=$?
if [[ ! -e "$STORE" ]]; then ok "--logout clears the (stubbed) keychain entry"; else no "--logout clears keychain" "$out"; fi
echo "$out" | grep -q "cleared" && ok "--logout reports the keychain entry as cleared" || no "--logout report" "$out"

echo "== a legacy plaintext file is NOT accepted as a credential =="
mkdir -p "$(dirname "$CRED")"
printf '{"api_key":"legacy-plaintext-key"}' > "$CRED"
out=$(STUB_MODE=absent run example.com --source backlinks 2>&1); rc=$?
if [[ $rc -ne 0 ]]; then ok "backlinks source fails rather than using the plaintext file"; else no "should not authenticate from file" "$out"; fi
echo "$out" | grep -q "NO LONGER READ" && ok "explains the legacy file is no longer read" || no "legacy-file explanation" "$out"
echo "$out" | grep -qi "keychain" && ok "points at --login / the keychain for migration" || no "migration guidance" "$out"
if ! echo "$out" | grep -q "legacy-plaintext-key"; then ok "the stale key is never echoed to the terminal"; else no "key echoed" "$out"; fi

echo "== --logout still deletes the legacy file (off switch keeps working) =="
out=$(STUB_MODE=absent run --logout); rc=$?
if [[ ! -e "$CRED" ]]; then ok "--logout deleted the legacy credentials.json"; else no "--logout deletes file" "still present"; fi
echo "$out" | grep -qi "does NOT revoke\|rotate or delete" && ok "--logout says local removal is not server-side revocation" || no "--logout revoke note" "$out"

echo "== env var still works and never touches disk =="
out=$(STUB_MODE=absent BACKLINKS_SH_API_KEY=env-only-key run example.com --source backlinks); rc=$?
if [[ $rc -eq 0 ]]; then ok "env var authenticates the backlinks source (offline fake fetch)"; else no "env var run" "rc=$rc out=$out"; fi
if [[ "$(cat "$FETCHES" 2>/dev/null)" == "https://api.backlinks.sh/v1/backlinks?target=example.com x-api-key=env-only-key" ]]; then
  ok "exactly one request, to api.backlinks.sh, key only in x-api-key — intercepted, never sent"
else no "request shape" "$(cat "$FETCHES" 2>/dev/null)"; fi
if ! echo "$out" | grep -q "NO LONGER READ"; then ok "env var short-circuits the legacy warning"; else no "env var precedence" "$out"; fi
if [[ ! -e "$CRED" ]]; then ok "using the env var writes no credential file"; else no "env var wrote a file" "exists"; fi

echo "== source-level guarantees =="
if ! grep -qE 'writeFileSync\([^)]*CRED_FILE' "$S"; then ok "no code path writes CRED_FILE any more"; else no "CRED_FILE is still written" "$(grep -n 'writeFileSync.*CRED_FILE' "$S")"; fi
if grep -q 'unlinkSync(CRED_FILE)' "$S"; then ok "CRED_FILE is still DELETED by --logout (cleanup preserved)"; else no "--logout no longer deletes CRED_FILE" "missing"; fi
# macOS branch: the secret must reach `security` on stdin, never as an argv element.
if grep -q '"add-generic-password", "-U", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w", key' "$S"; then
  no "macOS keychain write keeps the key off argv" "still passes key as an argv element"
else ok "macOS keychain write no longer passes the key as an argv element"; fi
if grep -q 'execFileSync("security", \["-i"\]' "$S"; then ok "macOS uses \`security -i\` (command on stdin)"; else no "macOS uses security -i" "not found"; fi
if grep -q 'input: `add-generic-password' "$S"; then ok "the add-generic-password command is fed via stdin"; else no "stdin input" "not found"; fi
if grep -q 'if (kcGet() !== key) return false' "$S"; then ok "macOS write is verified by read-back (security -i exits 0 on failure)"; else no "read-back verification" "not found"; fi

if [[ "$(wc -l < "$FETCHES" 2>/dev/null || echo 0)" -le 1 ]]; then ok "no other test made a request"; else no "unexpected requests" "$(cat "$FETCHES")"; fi

echo; echo "backlink-audit: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
