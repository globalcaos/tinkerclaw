#!/usr/bin/env bash
#
# Focused tests for overseer.sh's runtime directory, privacy controls and
# lifecycle commands. Everything runs against a throwaway status directory and a
# throwaway workdir; no real overseer and no real workspace is touched.
#
# Run:  bash tests/test_overseer.sh

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERSEER="$HERE/../scripts/overseer.sh"

PASS=0
FAIL=0
ok()    { PASS=$((PASS + 1)); echo "  ok   — $1"; }
bad()   { FAIL=$((FAIL + 1)); echo "  FAIL — $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
checkne() { if [ "$1" != "$2" ]; then ok "$3"; else bad "$3 (did not expect '$2')"; fi; }

SDIR=""
WDIR=""
teardown() {
    [ -n "$SDIR" ] && bash "$OVERSEER" --status-dir "$SDIR" --cleanup >/dev/null 2>&1
    [ -n "$WDIR" ] && rm -rf "$WDIR"
    SDIR=""; WDIR=""
}
trap teardown EXIT

setup() {
    SDIR="$(mktemp -d)/overseer"
    WDIR="$(mktemp -d)"
    echo "seed" > "$WDIR/seed.txt"
}

# Start the daemon and wait for the first status file. Interval is long enough
# that it is still alive when the lifecycle assertions run.
start_daemon() {
    setsid bash "$OVERSEER" --status-dir "$SDIR" --workdir "$WDIR" \
        --interval 5 "$@" >/dev/null 2>&1 &
    for _ in $(seq 1 60); do
        [ -s "$SDIR/status.json" ] && return 0
        sleep 0.2
    done
    return 1
}

status_field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))${2})" "$1" 2>/dev/null; }

echo "== the default runtime directory is per-user, not the shared /tmp/overseer"
DEFAULT_PATH="$(bash "$OVERSEER" --status-path)"
checkne "$DEFAULT_PATH" "/tmp/overseer/status.json" "default status path is not the shared directory"
check "$(dirname "$(dirname "$DEFAULT_PATH")" | grep -c .)" "1" "default path resolves to something"
check "$(stat -c '%a' "$(dirname "$DEFAULT_PATH")")" "700" "the runtime directory is mode 0700"

echo "== --status-dir and --status-path agree"
setup
check "$(bash "$OVERSEER" --status-dir "$SDIR" --status-path)" "$SDIR/status.json" "--status-path honours --status-dir"
teardown

echo "== --stop on a directory with no daemon is harmless"
setup
mkdir -m 700 "$SDIR"
check "$(bash "$OVERSEER" --status-dir "$SDIR" --stop >/dev/null 2>&1; echo $?)" "0" "--stop exits 0 when nothing is running"
teardown

echo "== a running daemon writes parseable status, a pid file, and stops on request"
setup
if start_daemon; then
    ok "status file appeared"
    check "$(status_field "$SDIR/status.json" "['cycle']" | grep -c '^[0-9]')" "1" "status.json is valid JSON with a cycle number"
    check "$([ -f "$SDIR/overseer.pid" ] && echo yes || echo no)" "yes" "a pid file was written"
    PID="$(cat "$SDIR/overseer.pid")"
    check "$([ -d "/proc/$PID" ] && echo yes || echo no)" "yes" "that pid is alive"
    bash "$OVERSEER" --status-dir "$SDIR" --stop >/dev/null 2>&1
    sleep 0.5
    check "$([ -d "/proc/$PID" ] && echo yes || echo no)" "no" "--stop stopped the daemon"
    check "$(grep -c 'Overseer stopped' "$SDIR/overseer.log" || true)" "1" "the exit trap logged the stop"
    check "$([ -f "$SDIR/overseer.pid" ] && echo yes || echo no)" "no" "--stop removed the pid file"
else
    bad "daemon never wrote a status file"
fi
teardown

echo "== filenames are recorded by default and suppressed by --no-filenames"
setup
if start_daemon; then
    sleep 0.2
    echo "change" > "$WDIR/a-revealing-project-name.txt"
    sleep 6
    check "$(status_field "$SDIR/status.json" "['filesystem']['filenames_recorded']")" "True" "filenames_recorded is true by default"
    bash "$OVERSEER" --status-dir "$SDIR" --stop >/dev/null 2>&1
else
    bad "daemon never wrote a status file"
fi
teardown

setup
if start_daemon --no-filenames; then
    sleep 0.2
    echo "change" > "$WDIR/a-revealing-project-name.txt"
    sleep 6
    check "$(status_field "$SDIR/status.json" "['filesystem']['filenames_recorded']")" "False" "--no-filenames sets filenames_recorded false"
    check "$(status_field "$SDIR/status.json" "['filesystem']['recent_files']")" "" "--no-filenames records no basenames"
    checkne "$(status_field "$SDIR/status.json" "['filesystem']['changes_since_last']")" "" "the change count is still reported"
    bash "$OVERSEER" --status-dir "$SDIR" --stop >/dev/null 2>&1
else
    bad "daemon never wrote a status file"
fi
teardown

echo "== a quote in a filename does not corrupt the status JSON"
setup
if start_daemon; then
    sleep 0.2
    touch "$WDIR/od\"d\\name.txt" 2>/dev/null || touch "$WDIR/oddname.txt"
    sleep 6
    check "$(status_field "$SDIR/status.json" "['cycle']" | grep -c '^[0-9]')" "1" "status.json still parses"
    bash "$OVERSEER" --status-dir "$SDIR" --stop >/dev/null 2>&1
else
    bad "daemon never wrote a status file"
fi
teardown

echo "== --cleanup removes the daemon's state"
setup
if start_daemon; then
    bash "$OVERSEER" --status-dir "$SDIR" --cleanup >/dev/null 2>&1
    check "$([ -f "$SDIR/status.json" ] && echo yes || echo no)" "no" "status file removed"
    check "$([ -f "$SDIR/overseer.log" ] && echo yes || echo no)" "no" "log removed"
    check "$([ -f "$SDIR/overseer.pid" ] && echo yes || echo no)" "no" "pid file removed"
else
    bad "daemon never wrote a status file"
fi
teardown

echo "== an unsafe status directory is refused, not silently chmod-ed"
BASE="$(mktemp -d)"
mkdir -m 777 "$BASE/open"
chmod 777 "$BASE/open"
bash "$OVERSEER" --status-dir "$BASE/open" --status-path >/dev/null 2>&1
check "$?" "1" "a group/world-accessible status dir is refused"
check "$(stat -c '%a' "$BASE/open")" "777" "and its mode was left alone"
mkdir -m 700 "$BASE/real"
ln -s "$BASE/real" "$BASE/link"
bash "$OVERSEER" --status-dir "$BASE/link" --status-path >/dev/null 2>&1
check "$?" "1" "a symlinked status dir is refused"
rm -rf "$BASE"

echo "== bad numeric arguments are rejected"
bash "$OVERSEER" --interval "5; rm" --status-path >/dev/null 2>&1
check "$?" "1" "non-integer --interval is rejected"

echo "== --stop never signals a process that is not this overseer"
setup
mkdir -m 700 "$SDIR"
sleep 60 &
VICTIM=$!
echo "$VICTIM" > "$SDIR/overseer.pid"
bash "$OVERSEER" --status-dir "$SDIR" --stop >/dev/null 2>&1
sleep 0.3
check "$([ -d "/proc/$VICTIM" ] && echo yes || echo no)" "yes" "an unrelated pid in the pid file is not killed"
check "$([ -f "$SDIR/overseer.pid" ] && echo yes || echo no)" "no" "the stale pid file is removed"
kill "$VICTIM" 2>/dev/null; wait "$VICTIM" 2>/dev/null
teardown

echo "== --stop is prompt even with a long interval (SIGTERM is not deferred by sleep)"
setup
setsid bash "$OVERSEER" --status-dir "$SDIR" --workdir "$WDIR" --interval 120 >/dev/null 2>&1 &
for _ in $(seq 1 60); do [ -s "$SDIR/status.json" ] && break; sleep 0.2; done
PID="$(cat "$SDIR/overseer.pid" 2>/dev/null)"
T0=$(date +%s)
OUT="$(bash "$OVERSEER" --status-dir "$SDIR" --stop 2>&1)"
T1=$(date +%s)
check "$([ $((T1 - T0)) -le 2 ] && echo yes || echo no)" "yes" "--stop returned within 2 s"
check "$(printf '%s' "$OUT" | grep -c SIGKILL || true)" "0" "no SIGKILL was needed"
check "$([ -n "$PID" ] && [ -d "/proc/$PID" ] && echo yes || echo no)" "no" "the daemon is gone"
check "$(grep -c 'Overseer stopped' "$SDIR/overseer.log" 2>/dev/null || true)" "1" "the exit trap ran"
teardown

echo "== --labels keeps only the named sub-agents"
setup
STUB="$(mktemp -d)"
cat > "$STUB/openclaw" <<'STUBEOF'
#!/usr/bin/env bash
echo "subagent agent:main:subagent:alpha 5s ago model-x 100 -"
echo "subagent agent:main:subagent:beta 7s ago model-x 100 -"
STUBEOF
chmod +x "$STUB/openclaw"
PATH="$STUB:$PATH" setsid bash "$OVERSEER" --status-dir "$SDIR" --workdir "$WDIR" --interval 30 --labels alpha >/dev/null 2>&1 &
for _ in $(seq 1 60); do [ -s "$SDIR/status.json" ] && break; sleep 0.2; done
check "$(status_field "$SDIR/status.json" "['subagents']['count']")" "1" "only the listed label is counted"
check "$(status_field "$SDIR/status.json" "['subagents']['details'][0]['label']")" "alpha" "and it is the right one"
bash "$OVERSEER" --status-dir "$SDIR" --stop >/dev/null 2>&1
rm -rf "$STUB"
teardown

echo "== --help documents the controls a reviewer looks for"
HELP="$(bash "$OVERSEER" --help)"
for flag in --stop --cleanup --no-filenames --voice-files --status-dir; do
    MENTIONS="$(printf '%s' "$HELP" | grep -c -- "$flag" || true)"
    if [ "${MENTIONS:-0}" -ge 1 ]; then ok "--help mentions $flag"; else bad "--help does not mention $flag"; fi
done

echo ""
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
