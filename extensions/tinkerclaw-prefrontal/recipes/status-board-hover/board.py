#!/usr/bin/env python3
"""Render a grouped status board with hover summaries for a Tinker ```html-render fence.

Usage: board.py spec.json > board.html
The output ends with a <script>, which routes the fence to the sandboxed iframe.
Without it the chat sanitises the block inline and strips the <style> (and every hover).
Spec: see recipe.md in this folder.
"""
import html, json, sys

TONE = {"good": "#2e8b57", "warn": "#d48a12", "bad": "#c0392b", "neutral": "#9b8b74"}
CSS = """table{table-layout:auto!important}td,th{word-break:normal!important;overflow-wrap:normal!important}
.wrap{font-family:Georgia,serif;color:#2b2116;padding:14px;background:#f4ecdc}
.kpis{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.kpi{flex:1;min-width:120px;background:#fffaf0;border-radius:10px;padding:10px 12px;box-shadow:0 1px 3px rgba(80,55,20,.18)}
.kpi b{font-size:26px;display:block;line-height:1}.kpi span{font-size:11px;color:#7a6a52}
table{width:100%;border-collapse:separate;border-spacing:0 3px;font-size:12.5px}
th{font-weight:normal;font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:#7a6a52;text-align:left;padding:0 8px 4px}
tr.row td{background:#fffaf0;padding:7px 8px;vertical-align:middle}
tr.row td:last-child{border-radius:0 8px 8px 0}tr.row:hover td{background:#fff3da}
tr.grp td{font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;padding:10px 4px 2px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
td.nm{position:relative;display:flex;align-items:center;gap:9px;border-radius:8px 0 0 8px;min-width:200px;cursor:help}
.id{width:34px;height:34px;border-radius:50%;color:#fff;font-weight:bold;font-size:12px;display:flex;align-items:center;justify-content:center;flex:none}
.br{font-size:10px;letter-spacing:1px;font-weight:bold}.v{font-size:10px;color:#9b8b74}
.bars{width:150px}.track{height:10px;background:#ece2cf;border-radius:5px;overflow:hidden;display:flex}
.track.thin{height:8px}.track i{display:block;height:100%}
.hatch{background:repeating-linear-gradient(45deg,#e0a526 0 4px,#f3d48a 4px 8px)}
.lbl{font-size:10.5px;color:#7a6a52;margin-top:3px}.lbl b{color:#2b2116;font-size:12px}.lbl span{color:#b9780c}
.pill{display:inline-block;color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap}
.tip{display:none;position:absolute;left:52px;top:100%;width:340px;z-index:20;background:#2b2116;color:#f4ecdc;font-size:12px;line-height:1.45;padding:10px 12px;border-radius:9px;box-shadow:0 8px 22px rgba(0,0,0,.4)}
.tip b{color:#f3d48a}.tip.up{top:auto;bottom:100%}td.nm:hover .tip{display:block}
.leg{font-size:10.5px;color:#7a6a52;margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.leg i{display:inline-block;width:18px;height:8px;border-radius:3px;vertical-align:middle;margin-right:4px}"""
e = html.escape

def cell(c, col, accent):
    t = col["type"]
    if t == "bar":
        v, x = c.get("value", 0), c.get("extra", 0)
        color = c.get("color") or col.get("color") or accent
        ext = f'<i class="hatch" style="width:{x}%"></i>' if x else ""
        tail = f' {e(col.get("unit",""))} <span>+{x}% {e(col.get("extraLabel","beta"))}</span>' if "extraLabel" in col else ""
        return f'<td class="bars"><div class="track"><i style="width:{v}%;background:{color}"></i>{ext}</div><div class="lbl"><b>{c.get("text", str(v)+"%")}</b>{tail}</div></td>'
    if t == "stack":
        tot = sum(n for n, _ in c["parts"]) or 1
        seg = "".join(f'<i style="width:{100*n/tot:.1f}%;background:{TONE.get(k,k)}"></i>' for n, k in c["parts"])
        return f'<td class="bars"><div class="track thin">{seg}</div><div class="lbl">{e(c.get("label",""))}</div></td>'
    return f'<td><span class="pill" style="background:{TONE.get(c.get("tone","neutral"))}">{e(c["text"])}</span></td>'

def main():
    s = json.load(open(sys.argv[1]))
    cols, out = s["columns"], []
    kp = "".join(f'<div class="kpi"><b style="color:{k.get("color","#2b2116")}">{e(k["value"])}</b><span>{e(k["label"])}</span></div>' for k in s.get("kpis", []))
    head = "".join(f"<th>{e(c['label'])}</th>" for c in [{"label": s.get("firstColumn", "Item · hover for summary")}] + cols)
    n = sum(len(g["rows"]) for g in s["groups"]); i = 0
    for g in s["groups"]:
        a = g["color"]
        out.append(f'<tr class="grp"><td colspan="{len(cols)+1}" style="color:{a}"><span class="dot" style="background:{a}"></span>{e(g["name"])}</td></tr>')
        for r in g["rows"]:
            up = " up" if i >= n * 0.6 else ""; i += 1
            tip = f'<div class="tip{up}"><b>{e(r["id"])} · {e(r["name"])}{" · "+e(r["sub"]) if r.get("sub") else ""}</b><br>{e(r["tip"])}</div>' if r.get("tip") else ""
            nm = (f'<td class="nm" style="border-left:6px solid {a}"><div class="id" style="background:{a}">{e(r["id"])}</div>'
                  f'<div><b>{e(r["name"])}</b><br><span class="br" style="color:{a}">{e(r.get("sub",""))}</span> <span class="v">{e(r.get("note",""))}</span></div>{tip}</td>')
            out.append('<tr class="row">' + nm + "".join(cell(r["cells"][c["key"]], c, a) for c in cols) + "</tr>")
    leg = "".join(f'<span><i style="background:{TONE.get(c,c)}"></i>{e(t)}</span>' for t, c in s.get("legend", []))
    note = f'<span>{e(s["footnote"])}</span>' if s.get("footnote") else ""
    print(f'<style>\n{CSS}\n</style><div class="wrap"><div class="kpis">{kp}</div><table><tr>{head}</tr>\n'
          + "\n".join(out) + f'</table><div class="leg">{leg}{note}</div></div>\n'
          '<script>/* routes this fence to the sandboxed iframe so <style> and :hover survive */</script>')

main()
