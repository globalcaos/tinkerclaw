#!/bin/bash
# Replay one scenario into a real (headless) Chromium against the scenario-driven mock gateway.
#
#   bash run.sh <scenario.json> [outdir] [--dist <built tinker-ui dist>] [--headed]
#
# outdir defaults to ${TMPDIR:-/tmp}/tinker-replay/<scenario name>-<HHMMSS> (never inside the repo); dist
# defaults to this checkout's tinker-ui build (tinker-ui/dist). Starts mock-gateway.mjs on a free 127.0.0.1
# port, runs drive.mjs, stops the mock, prints the summary (also in <outdir>/summary.txt). Exit code =
# drive.mjs's.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCEN="${1:?usage: run.sh <scenario.json> [outdir] [--dist DIR] [--headed]}"
shift
OUTDIR=""
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then OUTDIR="$1"; shift; fi
DIST="$HERE/../../dist"
HEADED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dist) DIST="$2"; shift 2 ;;
    --headed) HEADED="--headed"; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
NAME="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).name||"scenario")' "$SCEN")"
[ -n "$OUTDIR" ] || OUTDIR="${TMPDIR:-/tmp}/tinker-replay/${NAME}-$(date +%H%M%S)"
mkdir -p "$OUTDIR"
PORTFILE="$OUTDIR/.port"
rm -f "$PORTFILE"
node "$HERE/mock-gateway.mjs" --scenario "$SCEN" --dist "$DIST" --port 0 --port-file "$PORTFILE" \
  --log "$OUTDIR/mock-log.ndjson" > "$OUTDIR/mock.out" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null; wait $MOCK 2>/dev/null' EXIT
for _ in $(seq 1 100); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
if [ ! -s "$PORTFILE" ]; then echo "mock did not start:"; cat "$OUTDIR/mock.out"; exit 3; fi
PORT="$(cat "$PORTFILE")"
echo "mock on 127.0.0.1:$PORT  dist=$DIST  out=$OUTDIR"
node "$HERE/drive.mjs" --url "http://127.0.0.1:$PORT" --scenario "$SCEN" --out "$OUTDIR" $HEADED
RC=$?
echo "result: $OUTDIR/result.json (rc=$RC)"
exit $RC
