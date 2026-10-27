#!/bin/bash
# Regression tests for export.sh's destination vetting and for the capabilities removed in 1.9.1.
#
# These cover the two shell-side findings from the 1.9.0 scan:
#   - the destination check validated the LITERAL path, so a symlinked component bypassed the
#     outside-home / synced-folder / git-repo protections;
#   - --allow-unsafe-dest let a caller turn those protections off entirely.
#
# Everything runs inside a throwaway HOME under $TMPDIR. Nothing here touches your real home
# directory, your real exports, or the network. export.sh does not fetch anything at all.
#
# Run:  ./scripts/dest-safety-selftest.sh

set -u

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
EXPORT_SH="$HERE/export.sh"

FAKE_HOME=$(mktemp -d) || exit 1
cleanup() { chmod -R u+w "$FAKE_HOME" 2>/dev/null; rm -rf -- "$FAKE_HOME"; }
trap cleanup EXIT
# Canonicalize: on macOS $TMPDIR is itself under a symlinked /var, which would otherwise make
# every test look like the bug it is testing for.
FAKE_HOME=$(cd "$FAKE_HOME" && pwd -P)

PASS=0
FAIL=0

run_check() { HOME="$FAKE_HOME" "$EXPORT_SH" --check-dest "$1" 2>&1; }

# expect_reject NAME PATH SUBSTRING
expect_reject() {
  _name="$1"; _path="$2"; _needle="$3"
  _out=$(run_check "$_path"); _rc=$?
  if [ "$_rc" -eq 0 ]; then
    echo "✗ FAIL: $_name — ACCEPTED a destination that must be refused"
    echo "        $_out" | head -3
    FAIL=$((FAIL + 1)); return
  fi
  case "$_out" in
    *"$_needle"*) echo "✓ PASS: $_name"; PASS=$((PASS + 1)) ;;
    *)
      echo "✗ FAIL: $_name — refused, but not for the expected reason (wanted '$_needle')"
      echo "        $_out" | head -3
      FAIL=$((FAIL + 1)) ;;
  esac
}

expect_accept() {
  _name="$1"; _path="$2"
  _out=$(run_check "$_path"); _rc=$?
  if [ "$_rc" -eq 0 ]; then
    echo "✓ PASS: $_name"; PASS=$((PASS + 1))
  else
    echo "✗ FAIL: $_name — refused a destination that should be fine"
    echo "        $_out" | head -3
    FAIL=$((FAIL + 1))
  fi
}

# expect_flag_rejected NAME ARGS...
expect_flag_rejected() {
  _name="$1"; shift
  _out=$(HOME="$FAKE_HOME" "$EXPORT_SH" "$@" 2>&1); _rc=$?
  if [ "$_rc" -ne 0 ]; then
    echo "✓ PASS: $_name"; PASS=$((PASS + 1))
  else
    echo "✗ FAIL: $_name — exited 0, so the flag was accepted"
    echo "        $_out" | head -3
    FAIL=$((FAIL + 1))
  fi
}

echo "Destination-safety regression tests (fake HOME: $FAKE_HOME)"
echo ""

# ---------------------------------------------------------------- baseline
mkdir -p "$FAKE_HOME/.local/share/chatgpt-export"
expect_accept "a plain private directory is accepted" \
  "$FAKE_HOME/.local/share/chatgpt-export/2026-01-01"

expect_accept "a not-yet-existing directory under home is accepted" \
  "$FAKE_HOME/.local/share/chatgpt-export/does/not/exist/yet"

# ---------------------------------------------------------------- literal rejections
expect_reject "a relative path is refused" \
  "relative/path" "absolute path"

expect_reject "a literal path outside home is refused" \
  "/tmp/chatgpt-export-literal" "outside your home directory"

mkdir -p "$FAKE_HOME/Dropbox/exports"
expect_reject "a literal synced folder is refused" \
  "$FAKE_HOME/Dropbox/exports" "synced folder"

mkdir -p "$FAKE_HOME/code/project/.git"
expect_reject "a literal git repository is refused" \
  "$FAKE_HOME/code/project/exports" "git repository"

# ---------------------------------------------------------------- THE 1.9.0 BUG
# Each of these has a literal path that passes every 1.9.0 check — inside $HOME, no sync marker
# in the string, no .git along the spelled-out path — while resolving somewhere unacceptable.

OUTSIDE=$(mktemp -d) || exit 1
trap 'chmod -R u+w "$FAKE_HOME" 2>/dev/null; rm -rf -- "$FAKE_HOME" "$OUTSIDE"' EXIT
OUTSIDE=$(cd "$OUTSIDE" && pwd -P)
ln -s "$OUTSIDE" "$FAKE_HOME/escape"
expect_reject "a symlink under home pointing OUTSIDE home is refused" \
  "$FAKE_HOME/escape/exports" "outside your home directory"

ln -s "$FAKE_HOME/Dropbox" "$FAKE_HOME/notsynced"
expect_reject "a symlink whose name hides a synced target is refused" \
  "$FAKE_HOME/notsynced/exports" "synced folder"

ln -s "$FAKE_HOME/code/project" "$FAKE_HOME/plain"
expect_reject "a symlink into a git repository is refused" \
  "$FAKE_HOME/plain/exports" "git repository"

# The symlink deeper in the path, with a non-existent tail beyond it — the ordinary shape, since
# the dated export directory has not been created yet.
mkdir -p "$FAKE_HOME/a"
ln -s "$OUTSIDE" "$FAKE_HOME/a/link"
expect_reject "a symlinked ANCESTOR with a not-yet-created tail is refused" \
  "$FAKE_HOME/a/link/2026-01-01/conversations" "outside your home directory"

# Home itself, reached through a link, must not be writable as an export root.
ln -s "$FAKE_HOME" "$FAKE_HOME/selfhome"
expect_reject "a symlink resolving to home itself is refused" \
  "$FAKE_HOME/selfhome" "home directory"

# ---------------------------------------------------------------- removed capabilities
expect_flag_rejected "--allow-unsafe-dest is rejected" \
  --check-dest "$FAKE_HOME/Dropbox/exports" --allow-unsafe-dest
expect_flag_rejected "--token-mode is rejected" --token-mode
expect_flag_rejected "--full is rejected" --full
expect_flag_rejected "--redact is rejected" --redact

# The override must not exist anywhere in the shipped script, not even as a dead branch.
if grep -q "allow-unsafe-dest" "$EXPORT_SH" && \
   ! grep -q "was removed in 1.9.1" "$EXPORT_SH"; then
  echo "✗ FAIL: --allow-unsafe-dest still has a live implementation"
  FAIL=$((FAIL + 1))
else
  echo "✓ PASS: --allow-unsafe-dest has no live implementation"
  PASS=$((PASS + 1))
fi

# No credential handling may remain in the shell path. Comment lines are excluded on purpose:
# the header explains that CHATGPT_ACCESS_TOKEN is no longer consulted, and saying so is the
# point. What must not exist is a line of CODE that reads, prompts for or sends a token.
if grep -qE '^[^#]*(CHATGPT_ACCESS_TOKEN|read -rs|Authorization: Bearer)' "$EXPORT_SH"; then
  echo "✗ FAIL: export.sh still contains bearer-token handling"
  FAIL=$((FAIL + 1))
else
  echo "✓ PASS: export.sh contains no bearer-token handling"
  PASS=$((PASS + 1))
fi

# And it must make no network calls at all.
if grep -qE '^[^#]*\b(curl|wget)\b' "$EXPORT_SH"; then
  echo "✗ FAIL: export.sh still makes network calls"
  FAIL=$((FAIL + 1))
else
  echo "✓ PASS: export.sh makes no network calls"
  PASS=$((PASS + 1))
fi

# Bundle-wide: no script in this package may touch a bearer token, in code, on any path.
BUNDLE_HITS=$(grep -nE '^[^#/*]*(Authorization|Bearer|accessToken|CHATGPT_ACCESS_TOKEN)' \
  "$HERE/export.sh" "$HERE/export-conversations.ts" "$HERE/bookmarklet.js" 2>/dev/null)
if [ -n "$BUNDLE_HITS" ]; then
  echo "✗ FAIL: a script in this package still handles a bearer token"
  echo "$BUNDLE_HITS" | head -5
  FAIL=$((FAIL + 1))
else
  echo "✓ PASS: no script in this package handles a bearer token"
  PASS=$((PASS + 1))
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
