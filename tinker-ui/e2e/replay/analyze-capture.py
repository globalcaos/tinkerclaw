#!/usr/bin/env python3
"""Facts of one capture dir (frames.ndjson + history-*.json) for the dup investigation.

Usage: python3 analyze-capture.py <capdir>
Prints: event kinds in order (runs collapsed), delta text shape (cumulative or incremental),
narration/answer block structure, tool + thinking events, both finals, and what chat.history
served at each read (row count, roles, ids, text lengths).
"""
import json
import os
import sys

if len(sys.argv) < 2:
    sys.exit("usage: analyze-capture.py <capture dir>")
cap = sys.argv[1]
rows = [json.loads(l) for l in open(os.path.join(cap, "frames.ndjson")) if l.strip()]


def kind(r):
    if r["dir"] == "in":
        p = r.get("payload") or {}
        return f"{r['event']}:{p.get('state') or p.get('stream') or '?'}"
    if r["dir"] == "res":
        return f"res:{r.get('method')}"
    return "note:" + (r.get("note") or "").split(" ")[0] + ("" if not (r.get("note") or "").startswith("history") else "(" + (r.get("note") or "").split(" ")[-1] + ")")


print("== event kinds in order (consecutive runs collapsed; t = ms since capture start)")
prev = None
cnt = 0
start_t = 0
out = []
for r in rows:
    k = kind(r)
    if k != prev:
        if prev is not None:
            out.append(f"  t={start_t:>6} {prev} x{cnt}")
        prev, cnt, start_t = k, 1, r["t"]
    else:
        cnt += 1
out.append(f"  t={start_t:>6} {prev} x{cnt}")
print("\n".join(out))


def text_of(msg):
    if not isinstance(msg, dict):
        return None
    if isinstance(msg.get("text"), str):
        return msg["text"]
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return None


print()
print("== chat deltas: text shape")
deltas = [r for r in rows if r["dir"] == "in" and r["event"] == "chat" and r["payload"].get("state") == "delta"]
prev_text = ""
cum = 0
for r in deltas:
    p = r["payload"]
    t = text_of(p.get("message")) or ""
    is_cum = t.startswith(prev_text)
    cum += 1 if is_cum else 0
    print(f"  t={r['t']:>6} fseq={r.get('seq')} pseq={p.get('seq')} len={len(t):>5} cumulative_of_prev={is_cum} keys={sorted(p.keys())} msgkeys={sorted((p.get('message') or {}).keys())} tail={t[-50:]!r}")
    prev_text = t
print(f"  {cum}/{len(deltas)} deltas extend the previous delta's text")

print()
print("== agent assistant stream: data.text vs data.delta")
ast = [r for r in rows if r["dir"] == "in" and r["event"] == "agent" and r["payload"].get("stream") == "assistant"]
prev_text = ""
resets = []
for r in ast:
    d = r["payload"].get("data") or {}
    t = d.get("text") or ""
    dl = d.get("delta") or ""
    if not t.startswith(prev_text):
        resets.append((r["t"], r.get("seq"), r["payload"].get("seq"), len(prev_text), len(t), t[:60]))
    if t != prev_text + dl:
        pass
    prev_text = t
print(f"  {len(ast)} frames; data keys seen: {sorted(set(k for r in ast for k in (r['payload'].get('data') or {}).keys()))}")
print(f"  text resets (data.text not extending previous data.text): {len(resets)}")
for x in resets:
    print("   ", x)
nonconcat = sum(1 for i, r in enumerate(ast) if i and (r['payload']['data'].get('text') or '') != (ast[i-1]['payload']['data'].get('text') or '') + (r['payload']['data'].get('delta') or ''))
print(f"  frames where text != prev text + delta: {nonconcat}")
other_data = [r for r in ast if set((r['payload'].get('data') or {}).keys()) - {'text', 'delta'}]
for r in other_data[:10]:
    print("   extra-keys frame", r['t'], json.dumps(r['payload']['data'])[:300])

print()
print("== tool / thinking / block-break / lifecycle events")
for r in rows:
    if r["dir"] != "in":
        continue
    p = r["payload"]
    s = p.get("stream")
    if r["event"] == "agent" and s in ("tool", "thinking", "lifecycle", "call", "effort", "turn-phase", "block", "reasoning", "cache"):
        d = dict(p.get("data") or {})
        if "result" in d:
            d["result"] = str(d["result"])[:80]
        if "args" in d:
            d["args"] = str(d["args"])[:80]
        print(f"  t={r['t']:>6} fseq={r.get('seq')} pseq={p.get('seq')} {s} {json.dumps(d, ensure_ascii=False)[:260]}")
    elif r["event"] not in ("agent", "chat"):
        print(f"  t={r['t']:>6} other event {r['event']} {json.dumps(p)[:200]}")

print()
print("== finals")
finals = [r for r in rows if r["dir"] == "in" and r["event"] == "chat" and r["payload"].get("state") == "final"]
bodies = []
for r in finals:
    p = r["payload"]
    m = p.get("message") or {}
    t = text_of(m) or ""
    bodies.append(t)
    print(f"  t={r['t']} frame seq={r.get('seq')} payload seq={p.get('seq')} runId={p.get('runId')} payload keys={sorted(p.keys())} message keys={sorted(m.keys())} body len={len(t)}")
    print(f"    head={t[:140]!r}")
    print(f"    tail={t[-80:]!r}")
    extra = {k: v for k, v in p.items() if k not in ("message",)}
    print(f"    other payload fields: {json.dumps(extra)[:400]}")
    mx = {k: v for k, v in m.items() if k not in ("content", "text")}
    print(f"    other message fields: {json.dumps(mx)[:400]}")
if len(bodies) >= 2:
    print(f"  bodies equal: {bodies[0] == bodies[1]}")
    if bodies[0] != bodies[1]:
        import difflib
        sm = difflib.SequenceMatcher(None, bodies[0], bodies[1])
        for op in sm.get_opcodes():
            if op[0] != "equal":
                print("   diff", op, repr(bodies[0][op[1]:op[2]][:80]), repr(bodies[1][op[3]:op[4]][:80]))

print()
print("== chat.history reads")
for r in rows:
    if r["dir"] == "note" and (r.get("note") or "").startswith("history") and r.get("file"):
        h = json.load(open(os.path.join(cap, r["file"])))
        res = h.get("res") or {}
        msgs = res.get("messages") or []
        desc = []
        for m in msgs:
            oc = m.get("__openclaw") or {}
            t = text_of(m)
            blocks = m.get("content") if isinstance(m.get("content"), list) else []
            btypes = ",".join(b.get("type", "?") for b in blocks if isinstance(b, dict))
            desc.append(f"{m.get('role')}[{btypes}] id={oc.get('id') or oc.get('externalId') or '-'} len={len(t or '')}")
        print(f"  t={r['t']:>6} {r['note']:<28} rows={len(msgs)} keys={sorted(res.keys())} :: " + " | ".join(desc))
