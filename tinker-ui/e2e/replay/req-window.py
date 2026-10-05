#!/usr/bin/env python3
"""Requests the page made in a scenario-time window (noise methods hidden).

Usage: python3 req-window.py <result dir> <from ms> <to ms>
"""
import json
import os
import sys

d, lo, hi = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
NOISE = {"debug.dumpUiSnapshot", "sessions.attachments"}
for r in json.load(open(os.path.join(d, "mock-log.json"))):
    t = r.get("t")
    if t is None or not (lo <= t <= hi):
        continue
    if r["kind"] == "req" and r.get("method") not in NOISE:
        print(t, "req", r["method"], r.get("sessionKey") or "")
    elif r["kind"] == "history":
        print(t, "history", r.get("key"), json.dumps(r.get("params")), r.get("plan"), (r.get("snapshot") or {}).get("tag"), r.get("rows"))
    elif r["kind"] in ("open", "close", "drop", "refused", "bind"):
        print(t, r["kind"])
