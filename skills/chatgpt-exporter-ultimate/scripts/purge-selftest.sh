#!/bin/bash
# Regression tests for the --purge path of export.sh.
#
# --purge is the only destructive thing in this package, so its refusals are tested rather than
# asserted. Everything here happens inside a throwaway HOME under $TMPDIR: the test never touches
# your real home directory, your real exports, or the network.
#
# Run:  ./scripts/purge-selftest.sh

set -u

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
EXPORT_SH="$HERE/export.sh"
MANIFEST_NAME=".chatgpt-export-manifest.json"

if ! command -v script >/dev/null 2>&1; then
  echo "SKIP: this test needs util-linux \`script\` to give export.sh a pty (--purge refuses to run"
  echo "      non-interactively, which is itself the behaviour under test)."
  exit 0
fi

FAKE_HOME=$(mktemp -d) || exit 1
cleanup() { chmod -R u+w "$FAKE_HOME" 2>/dev/null; rm -rf -- "$FAKE_HOME"; }
trap cleanup EXIT

PASS=0
FAIL=0

mkmanifest() {
  # $1 = dir, $2 = seconds from now until expiry (may be negative)
  mkdir -p "$1"
  now=$(date +%s)
  cat > "$1/$MANIFEST_NAME" <<M
{
  "format": "chatgpt-export-manifest/1",
  "tool": "chatgpt-exporter-ultimate",
  "created_at_epoch": $now,
  "expires_at_epoch": $((now + $2)),
  "index_only": true
}
M
}

run_purge() {
  # $1 = answer typed at the prompt, rest = args. Returns combined output; exit code in RC.
  answer="$1"; shift
  out=$(printf '%s\n' "$answer" | HOME="$FAKE_HOME" script -q -e -c "bash '$EXPORT_SH' $*" /dev/null 2>&1)
  RC=$?
  printf '%s' "$out"
}

check() {
  # $1 = label, $2 = "gone"|"exists", $3 = path
  if [ "$2" = "gone" ] && [ ! -e "$3" ]; then
    echo "  ✅ $1"; PASS=$((PASS + 1))
  elif [ "$2" = "exists" ] && [ -e "$3" ]; then
    echo "  ✅ $1"; PASS=$((PASS + 1))
  else
    echo "  ❌ $1  (expected $3 to be $2)"; FAIL=$((FAIL + 1))
  fi
}

echo "Testing --purge inside a throwaway HOME: $FAKE_HOME"
echo ""

# 1. A directory this tool did not create must survive, marker absent.
UNMARKED="$FAKE_HOME/.local/share/chatgpt-export/unmarked"
mkdir -p "$UNMARKED"; echo "important" > "$UNMARKED/notes.txt"
run_purge PURGE --purge -o "$UNMARKED" >/dev/null
check "refuses a directory with no manifest" exists "$UNMARKED"

# 2. An index.json alone is NOT proof of ownership (the old bug accepted it).
INDEXONLY="$FAKE_HOME/.local/share/chatgpt-export/indexjson"
mkdir -p "$INDEXONLY"; echo "[]" > "$INDEXONLY/index.json"
run_purge PURGE --purge -o "$INDEXONLY" >/dev/null
check "refuses a directory carrying only index.json" exists "$INDEXONLY"

# 3. $HOME itself must never be a target.
mkmanifest "$FAKE_HOME" 86400
run_purge PURGE --purge -o "$FAKE_HOME" >/dev/null
check "refuses \$HOME itself" exists "$FAKE_HOME"
rm -f "$FAKE_HOME/$MANIFEST_NAME"

# 4. One level below $HOME is too shallow.
SHALLOW="$FAKE_HOME/documents"
mkmanifest "$SHALLOW" 86400
run_purge PURGE --purge -o "$SHALLOW" >/dev/null
check "refuses a directory one level below \$HOME" exists "$SHALLOW"

# 5. Outside $HOME entirely.
OUTSIDE=$(mktemp -d)
mkmanifest "$OUTSIDE" 86400
run_purge PURGE --purge -o "$OUTSIDE" >/dev/null
check "refuses a directory outside \$HOME" exists "$OUTSIDE"

# 6. A symlink under $HOME pointing outside it. The canonical path escapes home, so it is refused
#    even though the literal path starts with $HOME. This is the case a [ -L ] check would miss
#    if the symlink were an intermediate component.
mkdir -p "$FAKE_HOME/.local/share/chatgpt-export"
ln -s "$OUTSIDE" "$FAKE_HOME/.local/share/chatgpt-export/escape"
run_purge PURGE --purge -o "$FAKE_HOME/.local/share/chatgpt-export/escape" >/dev/null
check "refuses a symlink escaping \$HOME" exists "$OUTSIDE"
rm -rf -- "$OUTSIDE"

# 7. Typing anything other than PURGE aborts.
VALID="$FAKE_HOME/.local/share/chatgpt-export/2026-01-31"
mkmanifest "$VALID" 86400
run_purge yes --purge -o "$VALID" >/dev/null
check "aborts when the confirmation word is wrong" exists "$VALID"

# 8. The happy path: a real, marked export directory IS deleted.
run_purge PURGE --purge -o "$VALID" >/dev/null
check "deletes a valid marked export directory" gone "$VALID"

# 9. The sibling must be untouched — purge takes the exact directory, never the parent.
SIB_A="$FAKE_HOME/.local/share/chatgpt-export/2026-02-01"
SIB_B="$FAKE_HOME/.local/share/chatgpt-export/2026-02-02"
mkmanifest "$SIB_A" 86400
mkmanifest "$SIB_B" 86400
run_purge PURGE --purge -o "$SIB_A" >/dev/null
check "deletes only the named export" gone "$SIB_A"
check "leaves its sibling alone" exists "$SIB_B"
check "leaves the parent directory alone" exists "$FAKE_HOME/.local/share/chatgpt-export"

# 10. --purge-expired takes the expired one and leaves the live one.
EXPIRED="$FAKE_HOME/.local/share/chatgpt-export/2025-01-01"
mkmanifest "$EXPIRED" -86400
run_purge PURGE --purge-expired >/dev/null
check "--purge-expired deletes an expired export" gone "$EXPIRED"
check "--purge-expired leaves an unexpired export" exists "$SIB_B"

# 11. Non-interactive purge is refused outright (no pty here, so stdin is a pipe).
STILL="$FAKE_HOME/.local/share/chatgpt-export/2026-03-01"
mkmanifest "$STILL" 86400
printf 'PURGE\n' | HOME="$FAKE_HOME" bash "$EXPORT_SH" --purge -o "$STILL" >/dev/null 2>&1
check "refuses to purge non-interactively" exists "$STILL"

echo ""
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
