#!/usr/bin/env bash
# Behavioral tests for ../../.claude/hooks/enforce-file-lease.sh — the ORCA
# cross-session Edit/Write lease hook. Pure bash; no framework. Run:
#   bash extensions/tinkerclaw-orca/enforce-file-lease.test.sh
#
# The hook can BLOCK a human's edit (exit 2), so its mode + exit-code + fail-open
# behaviour is exercised end-to-end against the real lease-core CLI here.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/enforce-file-lease.sh"

PASS=0
FAIL=0
ok() { # want got label
  if [ "$1" = "$2" ]; then
    PASS=$((PASS + 1))
    echo "ok   - $3"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL - $3 (want=$1 got=$2)"
  fi
}

if [ ! -f "$HOOK" ]; then
  echo "FAIL - hook script not found at $HOOK"
  exit 1
fi

# Isolated lease root + a throwaway git repo with one file.
ROOT="$(mktemp -d)"
export ORCA_LEASE_ROOT="$ROOT"
REPO="$(mktemp -d)"
git -C "$REPO" init -q
FILE="$REPO/foo.ts"
echo "x" >"$FILE"

LC="$HERE/lease-core.mjs"

pre_json() { # $1=session $2=file (Edit event)
  printf '{"hook_event_name":"PreToolUse","tool_name":"Edit","session_id":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2"
}
write_json() { # $1=session $2=file (Write event)
  printf '{"hook_event_name":"PreToolUse","tool_name":"Write","session_id":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2"
}
stop_json() { printf '{"hook_event_name":"Stop","session_id":"%s"}' "$1"; }
subagentstop_json() { printf '{"hook_event_name":"SubagentStop","session_id":"%s"}' "$1"; }

# 1. first session acquires the file → allow (exit 0)
pre_json sessA "$FILE" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "first acquirer is allowed"

# 2. a different session, enforce mode → deny (exit 2)
pre_json sessB "$FILE" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 2 $? "contending session is denied in enforce mode"

# 3. a different session, warn mode → allow (exit 0) + a stderr warning
ERR="$(pre_json sessB "$FILE" | ORCA_LEASE_MODE=warn bash "$HOOK" 2>&1 1>/dev/null)"
RC=$?
ok 0 "$RC" "contending session is allowed in warn mode"
case "$ERR" in
  *orca-lease*) ok 0 0 "warn mode prints an orca-lease warning" ;;
  *) ok 0 1 "warn mode prints an orca-lease warning" ;;
esac

# 4. off mode → immediate allow even when contended
pre_json sessB "$FILE" | ORCA_LEASE_MODE=off bash "$HOOK" >/dev/null 2>&1
ok 0 $? "off mode allows unconditionally"

# 5. the owner re-editing its own file → allow (idempotent refresh)
pre_json sessA "$FILE" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "owner re-edit is allowed (refresh)"

# 6. the owner's Stop releases everything → the contender can then acquire
stop_json sessA | bash "$HOOK" >/dev/null 2>&1
ok 0 $? "stop hook exits 0"
pre_json sessB "$FILE" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "after the owner's Stop, the contender acquires"

# 7. a path outside any git repo → fail open (exit 0)
NOGIT="$(mktemp -d)"
pre_json sessC "$NOGIT/x.ts" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "a non-git path fails open"

# 8. missing file_path → nothing to lease → allow
printf '{"hook_event_name":"PreToolUse","tool_name":"Edit","session_id":"sessD","tool_input":{}}' \
  | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "missing file_path is allowed (nothing to lease)"

# 9. SubagentStop must NOT release the session's leases. A subagent finishing
#    does not mean the (possibly same-session_id) parent is done editing.
FILE9="$REPO/sub.ts"
echo "x" >"$FILE9"
pre_json sessA "$FILE9" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "subagent-test: owner acquires"
subagentstop_json sessA | bash "$HOOK" >/dev/null 2>&1
ok 0 $? "SubagentStop exits 0"
pre_json sessB "$FILE9" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 2 $? "SubagentStop does NOT free the lease (contender still denied)"

# 10. a new file in a not-yet-existing directory must still be leased
NEWP="$REPO/brand/new/deep/file.ts"
pre_json sessG "$NEWP" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "new file in a new dir acquires"
pre_json sessH "$NEWP" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 2 $? "new file in a new dir is leased (contender denied)"

# 11. a path containing spaces must be leased correctly
mkdir -p "$REPO/dir with space"
SPF="$REPO/dir with space/foo bar.ts"
echo "x" >"$SPF"
pre_json sessI "$SPF" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "spaced path acquires"
pre_json sessJ "$SPF" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 2 $? "spaced path is leased (contender denied)"

# 12. a Write event (not just Edit) also leases
FILE12="$REPO/wr.ts"
echo "x" >"$FILE12"
write_json sessK "$FILE12" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 0 $? "Write event acquires"
write_json sessL "$FILE12" | ORCA_LEASE_MODE=enforce bash "$HOOK" >/dev/null 2>&1
ok 2 $? "Write event is leased (contender denied)"

# 13. the deny banner must NOT echo terminal control chars from a holder field
FILE13="$REPO/evil.ts"
echo "x" >"$FILE13"
REPO_REAL="$(git -C "$REPO" rev-parse --show-toplevel)"
REL13="$(realpath -m --relative-to="$REPO_REAL" "$FILE13")"
EVIL="$(printf '\033[31mPWNED')"
node "$LC" acquire --repo "$REPO_REAL" --path "$REL13" --owner "$EVIL" --root "$ROOT" >/dev/null 2>&1
ERR13="$(pre_json sessM "$FILE13" | ORCA_LEASE_MODE=enforce bash "$HOOK" 2>&1 1>/dev/null)"
case "$ERR13" in
  *$'\033'*) ok 0 1 "deny banner strips terminal control chars from holder field" ;;
  *) ok 0 0 "deny banner strips terminal control chars from holder field" ;;
esac

rm -rf "$ROOT" "$REPO" "$NOGIT"
echo "---"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
