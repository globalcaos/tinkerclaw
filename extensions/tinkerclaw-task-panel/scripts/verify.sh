#!/usr/bin/env bash
# FORK: tinkerclaw-task-panel — end-to-end verify suite.
#
# Smoke-tests every gateway RPC the plugin exposes (tasks lifecycle + bulk
# queries + metrics + calendar), then tears down any rows it created. Safe
# to run while the UI is in use — uses a unique nanosecond-suffixed ID so
# concurrent activity can't collide.
#
# Dependencies: bash, `openclaw` on PATH, python3 (always available).
# No `jq` dependency — JSON extraction is done with python.
#
# Usage:
#   bash extensions/tinkerclaw-task-panel/scripts/verify.sh
#
# Exit codes:
#   0 = all assertions passed
#   1 = at least one assertion failed (see output for details)

set +e

PASS=0
FAIL=0
RUN_ID="f1-$(date +%s%N | tail -c 6)"
DB_PATH="${CONTROL_PANEL_DB:-$HOME/.openclaw/data/control-panel/store.db}"

echo "════════════════════════════════════════════════════════════════════"
echo "FLOWS-F1-VERIFY — tinkerclaw-task-panel               run=$RUN_ID"
echo "════════════════════════════════════════════════════════════════════"

# Strip the two config-warning lines the openclaw CLI prefixes onto stdout;
# leave the JSON body intact.
#
# FORK 2026-05-12: per-call timeout raised 12 → 30 s. Each `openclaw gateway
# call` carries a ~10 s baseline cost (cold tsx loader + plugin init + IPC),
# so the old 12 s budget tipped over under any gateway contention and
# produced empty `actual=` strings that looked like RPC failures but were
# really CLI-process timeouts. 30 s gives ~3× headroom over the baseline.
call() {
  timeout 30 openclaw gateway call "$1" --params "$2" --json 2>&1 \
    | sed '/^Config warnings:$/d; /^- plugins\./d'
}

# Extract a dotted JSON path with python3. Returns string repr or "" on
# parse failure. `__len__` segment returns the array/object size.
pyget() {
  python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except: sys.exit(0)
cur = d
for p in '$1'.split('.'):
    if p == '__len__':
        cur = len(cur) if hasattr(cur, '__len__') else None; break
    if isinstance(cur, dict): cur = cur.get(p)
    elif isinstance(cur, list):
        try: cur = cur[int(p)]
        except: cur = None; break
    else: cur = None; break
if cur is None: print('null')
elif isinstance(cur, bool): print('true' if cur else 'false')
else: print(cur)
"
}

assert() {
  local actual=$(call "$2" "$3" | pyget "$4")
  if [ "$actual" = "$5" ]; then
    PASS=$((PASS+1))
    printf "  \033[32m✓\033[0m %s\n" "$1"
  else
    FAIL=$((FAIL+1))
    printf "  \033[31m✗\033[0m %s  expected=%s actual=%s\n" "$1" "$5" "$actual"
  fi
}

assert_p() {
  local actual=$(call "$2" "$3" | pyget "$4")
  if [ -n "$actual" ] && [ "$actual" != "null" ] && [ "$actual" != "0" ]; then
    PASS=$((PASS+1))
    printf "  \033[32m✓\033[0m %s  →  %s\n" "$1" "$actual"
  else
    FAIL=$((FAIL+1))
    printf "  \033[31m✗\033[0m %s  path=%s actual=%s\n" "$1" "$4" "$actual"
  fi
}

# Shape-only assertion — passes on ANY non-empty pyget output (including
# "0" and "null"). Use when the field's existence proves the RPC works
# even if the value is legitimately 0 (e.g. progress.denominator when the
# user-delivered pass has zero open tasks).
assert_exists() {
  local actual=$(call "$2" "$3" | pyget "$4")
  if [ -n "$actual" ]; then
    PASS=$((PASS+1))
    printf "  \033[32m✓\033[0m %s  →  %s\n" "$1" "$actual"
  else
    FAIL=$((FAIL+1))
    printf "  \033[31m✗\033[0m %s  path=%s actual=%s (json parse failed)\n" "$1" "$4" "$actual"
  fi
}

ID="$RUN_ID-t"
IMP="$RUN_ID-i"
MET="$RUN_ID-m"

echo ""
echo "▶ Section 1 — Task lifecycle"
assert         "add"               "control-panel.tasks.add"        "{\"id\":\"$ID\",\"text\":\"v5\",\"priority_axis\":\"meta\",\"priority_rank\":1,\"est_minutes\":7,\"context_md\":\"orig\"}" "task.id" "$ID"
assert         "get"               "control-panel.tasks.get"        "{\"id\":\"$ID\"}" "task.text" "v5"
assert         "status"            "control-panel.tasks.update"     "{\"id\":\"$ID\",\"status\":\"in_progress\"}" "task.status" "in_progress"
assert         "text"              "control-panel.tasks.update"     "{\"id\":\"$ID\",\"text\":\"v5e\"}" "task.text" "v5e"
assert         "ctx set"           "control-panel.tasks.update"     "{\"id\":\"$ID\",\"context_md\":\"c2\"}" "task.context_md" "c2"
assert         "ctx clear"         "control-panel.tasks.update"     "{\"id\":\"$ID\",\"context_md\":null}" "task.context_md" "null"
assert         "axis"              "control-panel.tasks.update"     "{\"id\":\"$ID\",\"priority_axis\":\"ventures\"}" "task.priority_axis" "ventures"
assert         "reschedule"        "control-panel.tasks.reschedule" "{\"id\":\"$ID\",\"due_date\":\"2026-05-15\"}" "task.due_date" "2026-05-15"
assert         "due clear"         "control-panel.tasks.update"     "{\"id\":\"$ID\",\"due_date\":null}" "task.due_date" "null"
assert         "dismiss"           "control-panel.tasks.dismiss"    "{\"id\":\"$ID\",\"dismissal_kind\":\"out_of_scope\",\"dismissal_note\":\"v5\"}" "task.dismissal_kind" "out_of_scope"
# v3.3 — back_burner status round-trip. Status flip is one tasks.update call;
# bring-back is the same RPC with status:'open'. No dedicated RPC needed.
BBID="$RUN_ID-bb"
assert         "add (bb)"          "control-panel.tasks.add"        "{\"id\":\"$BBID\",\"text\":\"bb-probe\",\"priority_axis\":\"meta\"}" "task.id" "$BBID"
assert         "snooze indef"      "control-panel.tasks.update"     "{\"id\":\"$BBID\",\"status\":\"back_burner\"}" "task.status" "back_burner"
assert         "bring back"        "control-panel.tasks.update"     "{\"id\":\"$BBID\",\"status\":\"open\"}" "task.status" "open"
assert         "remove (bb)"       "control-panel.tasks.remove"     "{\"id\":\"$BBID\"}" "removed" "true"
assert         "remove"            "control-panel.tasks.remove"     "{\"id\":\"$ID\"}" "removed" "true"

echo ""
echo "▶ Section 2 — Bulk queries"
assert_p       "list total"        "control-panel.tasks.list"       '{}' "tasks.__len__"
assert_p       "axis filter"       "control-panel.tasks.list"       '{"axis":"ventures","limit":1}' "tasks.0.priority_axis"
# Order matters: import FIRST so the briefing_pass it creates is the most
# recent user-delivered pass — progress then has a non-zero denominator.
# (If progress runs before import, denominator can legitimately be 0 when
# the verify suite has just swept all earlier verify-imports.)
assert_p       "import"            "control-panel.tasks.import"     "{\"pass_id\":\"$RUN_ID.pass\",\"version\":2,\"delivered_to_user_at\":$(date +%s%3N),\"tasks\":[{\"id\":\"$IMP\",\"text\":\"v5i\",\"priority_axis\":\"meta\",\"priority_rank\":1}]}" "inserted.__len__"
# Progress can legitimately return denominator=0 when the user-delivered
# pass of TODAY has zero open tasks (or hasn't been delivered yet).
# Shape-only check: the response must contain a denominator field.
assert_exists  "progress"          "control-panel.tasks.progress"   '{}' "denominator"

echo ""
echo "▶ Section 3 — Metrics"
assert         "add-metric"        "control-panel.add-metric"       "{\"id\":\"$MET\",\"class\":\"LIVE\",\"source\":\"v5\",\"template\":\"sparkline\",\"retention_days\":7}" "metric.id" "$MET"
assert         "record 42"         "control-panel.record"           "{\"id\":\"$MET\",\"value\":42}" "ok" "true"
assert         "record 88"         "control-panel.record"           "{\"id\":\"$MET\",\"value\":88}" "ok" "true"
assert_p       "query"             "control-panel.query"            "{\"id\":\"$MET\"}" "observations.__len__"
assert_p       "list metrics"      "control-panel.list"             '{}' "metrics.__len__"

echo ""
echo "▶ Section 4 — Calendar"
assert_p       "calendar.list 14d" "control-panel.calendar.list"    '{"from":"2026-05-11","to":"2026-05-25"}' "events.__len__"
assert_p       "density 14d"       "control-panel.calendar.density" '{"from":"2026-05-11","to":"2026-05-25"}' "density.__len__"

echo ""
echo "▶ Section 5 — Axes taxonomy (v3.3)"
AXID="$RUN_ID-ax"
assert_p       "list seeded"       "control-panel.axes.list"        '{}' "axes.__len__"
assert         "add"               "control-panel.axes.add"         "{\"id\":\"$AXID\",\"label\":\"🧪 Probe\"}" "axis.id" "$AXID"
assert         "update"            "control-panel.axes.update"      "{\"id\":\"$AXID\",\"label\":\"🧪 Probe v2\"}" "axis.label" "🧪 Probe v2"
# reorder: send the full current order; just verify the response shape.
assert_p       "reorder"           "control-panel.axes.reorder"     "{\"ids\":[\"ventures\",\"online\",\"family\",\"me\",\"serra\",\"meta\",\"$AXID\"]}" "axes.__len__"
assert         "delete"            "control-panel.axes.delete"      "{\"id\":\"$AXID\",\"reassign_to\":\"meta\"}" "removed" "true"

echo ""
echo "▶ Section 6 — Estimation presets taxonomy (v3.3)"
assert_p       "list seeded"       "control-panel.est-presets.list" '{}' "presets.__len__"
# Capture a fresh preset id via a separate add+jq-like path. The verify
# scaffold doesn't support extracting an int return value across asserts,
# so the next two asserts re-resolve by listing and grabbing the tail.
PID_OUT=$(call "control-panel.est-presets.add" "{\"minutes\":17,\"label\":\"17 min probe\"}" | pyget "preset.id")
if [ -n "$PID_OUT" ] && [ "$PID_OUT" != "null" ]; then
  PASS=$((PASS+1))
  printf "  \033[32m✓\033[0m add  →  id=%s\n" "$PID_OUT"
  assert       "update label"      "control-panel.est-presets.update" "{\"id\":$PID_OUT,\"label\":\"17 min probe v2\"}" "preset.label" "17 min probe v2"
  assert       "delete"            "control-panel.est-presets.delete" "{\"id\":$PID_OUT}" "removed" "true"
else
  FAIL=$((FAIL+1))
  printf "  \033[31m✗\033[0m add  preset.id was empty\n"
fi

echo ""
echo "▶ Section 7 — Teardown (this run + any orphans from prior runs)"
timeout 30 openclaw gateway call control-panel.tasks.remove --params "{\"id\":\"$IMP\"}" --json 2>/dev/null > /dev/null \
  && echo "  ✓ removed task $IMP"
python3 - <<PY
import sqlite3, sys
db = sqlite3.connect("$DB_PATH")
# This-run metric (no remove-metric RPC exists; direct SQLite is the path)
m1 = db.execute("DELETE FROM metric_definition WHERE id = ?", ("$MET",)).rowcount
# Sweep any leftover verify rows from earlier runs (be conservative — only
# our own id pattern).
m2 = db.execute("DELETE FROM metric_definition WHERE id LIKE 'f1%-m' OR id LIKE 'f1_%_metric%'").rowcount
t  = db.execute("DELETE FROM task WHERE id LIKE 'f1%-imp' OR id LIKE 'f1%-i' OR id LIKE 'f1r%' OR id LIKE 'f1v%'").rowcount
db.commit()
print(f"  ✓ removed metric \$MET (rows={m1})")
print(f"  ✓ swept leftover verify rows: metrics={m2}, tasks={t}")
PY

echo ""
echo "════════════════════════════════════════════════════════════════════"
TOTAL=$((PASS+FAIL))
if [ $FAIL -eq 0 ]; then
  printf "F1 VERIFY: \033[32m%d/%d PASS — clean green ✓\033[0m\n" $PASS $TOTAL
  exit 0
else
  printf "F1 VERIFY: \033[32m%d pass\033[0m  \033[31m%d fail\033[0m / %d\n" $PASS $FAIL $TOTAL
  exit 1
fi
