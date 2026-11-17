#!/bin/bash
# The "no mark or edit is ever lost" contract (2026-11-15): every test in both modes where it applies.
#   bash test/contract.sh [progress file]     (Pi: PW_CHROMIUM=/usr/bin/chromium; each test starts its own server)
# Prints one line per test and "<passing>/<total> contract tests"; exit 0 = all passed.
cd "$(dirname "$0")/.." || exit 1
PROGRESS=${1:-/dev/null}
RUNS="1-rebuilds:desktop 1-rebuilds:phone 2-apply:desktop 2-apply:phone 3-reload:desktop 3-reload:phone
4-network:desktop 4-network:phone 5-refusals:desktop 5-refusals:phone 6-two-devices:both 7-writer:desktop 7-writer:phone"
total=$(echo $RUNS | wc -w); pass=0; n=0
for r in $RUNS; do
  t=${r%%:*}; m=${r##*:}; n=$((n + 1))
  D=${CONTRACT_DIR:-/tmp/jarvis/contract-test}; log=$D/log-$t-$m.txt; mkdir -p $D
  MODE=$([ $m = phone ] && echo phone || echo desktop) timeout 600 node test/contract-$t.mjs > $log 2>&1
  if [ $? = 0 ]; then pass=$((pass + 1)); echo "PASS contract-$t ($m)"; else echo "FAIL contract-$t ($m): $(grep -m3 FAIL $log | tr '\n' ' ')"; fi
  echo "$pass/$total contract tests ($n run)" > "$PROGRESS"
done
echo "$pass/$total contract tests" | tee "$PROGRESS"
[ $pass = $total ]
