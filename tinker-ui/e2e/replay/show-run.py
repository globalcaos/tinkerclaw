#!/usr/bin/env python3
"""Print one replay's record: summary, mid-run dumps, every chat.history the page asked for (and what the
mock served), connection events and binds, in scenario time (ms since the clock started).

Usage: python3 show-run.py <result dir> [--no-summary]
"""
import json
import os
import sys

d = sys.argv[1]
if "--no-summary" not in sys.argv:
    print(open(os.path.join(d, "summary.txt")).read())
dumps = os.path.join(d, "dumps.txt")
if os.path.exists(dumps) and os.path.getsize(dumps) > 1:
    print("== mid-run dumps")
    print(open(dumps).read())
log = json.load(open(os.path.join(d, "mock-log.json")))
print("== chat.history reads, connections, binds, drops (t = scenario ms; null = before the clock started)")
for r in log:
    k = r["kind"]
    if k == "history":
        if r.get("archive"):
            print(f"  t={r['t']} history {r['key']} reset-archive read (empty)")
            continue
        snap = r.get("snapshot") or {}
        print(
            f"  t={r['t']} history {r['key']} params={json.dumps({x: y for x, y in (r.get('params') or {}).items() if y is not None})}"
            f" plan={r.get('plan')} served snapshot@{snap.get('at')}({snap.get('tag')}) rows={r.get('rows')}"
            f" cursor={json.dumps(r.get('cursor'))}"
        )
    elif k in ("open", "close", "refused", "drop", "bind", "start", "hold-released", "hold-timeout", "frames-done"):
        print(f"  t={r['t']} {k} " + json.dumps({x: y for x, y in r.items() if x not in ('t', 'wall', 'kind')}))
lost = [r for r in log if r["kind"] == "frame" and r.get("delivered") == 0]
if lost:
    print(f"== frames delivered to no socket: {len(lost)}")
    for r in lost[:40]:
        print(f"  t={r['t']} {r['event']} {r.get('state')} runId={r.get('runId')}")
