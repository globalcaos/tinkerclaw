#!/usr/bin/env python3
"""Overview of a scenario file: history snapshots per session, actions, frames by kind, the finals.

Usage: python3 show-scenario.py <scenario.json>
"""
import json
import sys
from collections import Counter

s = json.load(open(sys.argv[1]))
print(f"name={s.get('name')} session={s.get('session')} main={s.get('mainSession')} epoch0={s.get('epoch0')} preroll={s.get('prerollMs')} end={s.get('end')}")
print(f"runs={json.dumps(s.get('runs'))}")
for key, snaps in (s.get("history") or {}).items():
    print(f"== history {key}")
    for h in snaps:
        ids = []
        for m in h.get("messages", []):
            oc = m.get("__openclaw") or {}
            ident = f"oc:{oc['id']}" if oc.get("id") else (f"ext:{oc['externalId'][:8]}" if oc.get("externalId") else "-")
            kinds = ",".join(b.get("type", "?") for b in m.get("content", []) if isinstance(b, dict)) if isinstance(m.get("content"), list) else "str"
            seq = oc.get("seq")
            ids.append(f"{m.get('role')}[{kinds}]{ident}{'#' + str(seq) if seq else ''}")
        print(f"  at={h.get('at')} tag={h.get('tag')} rows={len(h.get('messages', []))} cursor={json.dumps(h.get('cursor'))} hidden={json.dumps(h.get('hiddenLocal'))}")
        print(f"     {' | '.join(ids)}")
print("== actions")
for a in s.get("actions") or []:
    extra = {k: v for k, v in a.items() if k not in ("at", "do", "text")}
    print(f"  at={a.get('at')} {a.get('do')} {json.dumps(extra)}{' text=' + str(len(a['text'])) + ' chars' if 'text' in a else ''}")
c = Counter()
for f in s.get("frames") or []:
    p = f.get("payload") or {}
    c[f"{f.get('event')}:{p.get('state') or p.get('stream')}"] += 1
print("== frames " + ", ".join(f"{k} x{v}" for k, v in c.items()))
for f in s.get("frames") or []:
    p = f.get("payload") or {}
    if f.get("event") == "chat" and p.get("state") != "delta":
        m = p.get("message") or {}
        body = m.get("text") if isinstance(m.get("text"), str) else "".join(b.get("text", "") for b in m.get("content", []) if isinstance(b, dict))
        print(f"  at={f.get('at')} chat {p.get('state')} runId={p.get('runId')} pseq={p.get('seq')} body={len(body or '')}")
    if f.get("event") == "agent" and p.get("stream") == "lifecycle" and (p.get("data") or {}).get("phase") in ("start", "end", "text-block-break"):
        print(f"  at={f.get('at')} lifecycle {(p.get('data') or {}).get('phase')}")
