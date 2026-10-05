#!/usr/bin/env python3
"""Bipartite correspondence diagram: two groups, lines between matches, unmatched items flagged.

Usage: render.py spec.json > out.html
spec = {
  "title": str, "subtitle": str,
  "left":  {"label": str, "unmatched": "label for left items with no link",  "items": [{"id","name","sub"?}]},
  "right": {"label": str, "unmatched": "label for right items with no link", "items": [{"id","name","sub"?,"badge"?}]},
  "links": [{"from": leftId, "to": rightId, "kind": "full"|"partial", "note"?: str}],
  "sortRight": true   # order right column by barycenter of its left links (minimises crossings)
}
Output is ONE self-contained HTML fragment with a static SVG (no JS), so it renders in sandboxed
chat iframes, emails and printouts alike.
"""
import json, sys, html

spec = json.load(open(sys.argv[1]))
L, R, links = spec["left"]["items"], spec["right"]["items"], spec["links"]
li = {x["id"]: i for i, x in enumerate(L)}
if spec.get("sortRight", True):
    def bary(r):
        idx = [li[k["from"]] for k in links if k["to"] == r["id"]]
        return (0, sum(idx) / len(idx)) if idx else (1, 0)
    R = sorted(R, key=bary)
ri = {x["id"]: i for i, x in enumerate(R)}
unL = [x for x in L if not any(k["from"] == x["id"] for k in links)]
unR = [x for x in R if not any(k["to"] == x["id"] for k in links)]

W, BW, BH, TOP, GAP = 920, 300, 40, 44, 10
n = max(len(L), len(R)); H = TOP + n * (BH + GAP) + 10
def ys(items):  # spread a column evenly over the shared height
    step = (H - TOP - 10) / len(items)
    return [TOP + i * step + (step - BH) / 2 for i in range(len(items))]
yL, yR = ys(L), ys(R)
xL, xR = 10, W - BW - 10
e = html.escape
C = dict(bg="#2b2118", box="#3a2d21", line="#5a4632", ink="#f3e9d8", mute="#cdb99a",
         full="#7fbf7f", part="#e0b973", miss="#e07a6a", ext="#8fb3de")

s = [f'<svg viewBox="0 0 {W} {H}" width="100%" style="display:block;font-family:system-ui,sans-serif">']
s.append(f'<text x="{xL}" y="24" fill="{C["mute"]}" font-size="13" font-weight="700" letter-spacing="1">{e(spec["left"]["label"].upper())}</text>')
s.append(f'<text x="{xR}" y="24" fill="{C["mute"]}" font-size="13" font-weight="700" letter-spacing="1">{e(spec["right"]["label"].upper())}</text>')
for k in links:  # lines first, boxes on top
    a, b = yL[li[k["from"]]] + BH / 2, yR[ri[k["to"]]] + BH / 2
    x1, x2 = xL + BW, xR; mx = (x1 + x2) / 2
    col = C["full"] if k.get("kind", "full") == "full" else C["part"]
    dash = '' if k.get("kind", "full") == "full" else ' stroke-dasharray="6 5"'
    s.append(f'<path d="M{x1},{a} C{mx},{a} {mx},{b} {x2},{b}" fill="none" stroke="{col}" stroke-width="2.4"{dash} opacity=".9"/>')
    if k.get("note"):
        s.append(f'<text x="{mx}" y="{(a+b)/2-5}" fill="{col}" font-size="11" text-anchor="middle">{e(k["note"])}</text>')
def box(x, y, it, missing, side):
    st = C["miss"] if missing else C["line"]
    dash = ' stroke-dasharray="5 4"' if missing else ''
    s.append(f'<rect x="{x}" y="{y}" width="{BW}" height="{BH}" rx="9" fill="{C["box"]}" stroke="{st}" stroke-width="{2 if missing else 1}"{dash}/>')
    s.append(f'<text x="{x+12}" y="{y+17}" fill="{C["ink"]}" font-size="13.5" font-weight="700">{e(it["name"])}</text>')
    sub = it.get("sub", "") + (("  ·  " + spec[side]["unmatched"]) if missing else "")
    s.append(f'<text x="{x+12}" y="{y+32}" fill="{C["miss"] if missing else C["mute"]}" font-size="11">{e(sub)}</text>')
    if it.get("badge"):
        s.append(f'<text x="{x+BW-10}" y="{y+17}" fill="{C["ext"]}" font-size="11.5" font-weight="700" text-anchor="end">{e(it["badge"])}</text>')
for i, it in enumerate(L): box(xL, yL[i], it, it in unL, "left")
for i, it in enumerate(R): box(xR, yR[i], it, it in unR, "right")
s.append('</svg>')

def lst(items, lab):
    body = " · ".join(e(x["name"]) for x in items) or "cap"
    return f'<div style="margin:3px 0"><b style="color:{C["miss"]}">{e(lab)} ({len(items)}):</b> {body}</div>'
parts = [x for x in links if x.get("kind") == "partial"]
out = [f'<div style="background:{C["bg"]};color:{C["ink"]};font-family:system-ui,sans-serif;padding:16px 18px;border-radius:12px;border:1px solid {C["line"]}">',
       f'<div style="font-family:Georgia,serif;font-size:18px;font-weight:700">{e(spec["title"])}</div>',
       f'<div style="color:{C["mute"]};font-size:12.5px;margin:2px 0 8px">{e(spec.get("subtitle",""))}</div>',
       f'<div style="font-size:12px;color:{C["mute"]};margin-bottom:4px"><span style="color:{C["full"]}">━━</span> correspondència completa &nbsp; <span style="color:{C["part"]}">╍╍</span> parcial &nbsp; <span style="color:{C["miss"]}">▭</span> sense parella</div>',
       "".join(s),
       '<div style="font-size:13px;margin-top:10px">',
       lst(unL, spec["left"]["label"] + " — " + spec["left"]["unmatched"]),
       lst(unR, spec["right"]["label"] + " — " + spec["right"]["unmatched"]),
       (f'<div style="margin:3px 0"><b style="color:{C["part"]}">Parcials ({len(parts)}):</b> ' + " · ".join(e(f'{next(x["name"] for x in L if x["id"]==k["from"])} → {next(x["name"] for x in R if x["id"]==k["to"])}' + (f' ({k["note"]})' if k.get("note") else "")) for k in parts) + '</div>') if parts else "",
       '</div></div>']
print("".join(out))
