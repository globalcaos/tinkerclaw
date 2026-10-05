#!/usr/bin/env python3
"""build-gantt: draw a master-worker build as a Gantt chart for the Tinker chat.

  gantt.py derive PLAN.json
      Fill each phase's lanes from the Claude Code workflow journals it names
      ("workflows": [...]): one lane per unit, a build segment and a review segment,
      with the real start and end read from each agent's own transcript.
  gantt.py render PLAN.json [--now ISO] [--html OUT.html] [--png OUT.png] [--width 1100]
      Print a ```html-render block on stdout. --html writes a standalone page,
      --png a screenshot of it (headless Chrome), for looking at it or for channels
      that cannot draw HTML.

The plan file format is described in SKILL.md next to this script.
"""
import datetime as dt
import glob
import html
import json
import os
import re
import subprocess
import sys
import tempfile

KINDS = [  # fixed order = palette order; validated on the dark card (#241c14), dataviz skill
    ("conception", "Conception", "#3987e5"),
    ("spec", "Spec", "#d95926"),
    ("build", "Build", "#199e70"),
    ("review", "Review / integration", "#c98500"),
    ("field", "Field test", "#d55181"),
    ("manual", "Manual", "#008300"),
]
KIND_COLOR = {k: c for k, _, c in KINDS}
KIND_NAME = {k: n for k, n, _ in KINDS}
PAUSE_COLOR = "#6b5d4d"
SURFACE = "#241c14"
CUT_AFTER_MIN = 10  # a started agent with no result and no activity for this long was cut


def parse_t(s):
    if s is None:
        return None
    t = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return t.astimezone() if t.tzinfo else t.astimezone()


def fmt_t(t):
    return t.strftime("%d %b %H:%M")


def fmt_dur(minutes):
    minutes = round(minutes)
    if minutes < 60:
        return f"{minutes} min"
    h, m = divmod(minutes, 60)
    return f"{h} h {m:02d}" if m else f"{h} h"


# ---------------------------------------------------------------- derive

VERBS = ("build", "review", "integrate", "verify", "fix")


def lane_of(label):
    """'review B3 recorder' -> ('B3', 'recorder', 'review'); 'i1-chain' -> ('I1', 'chain', 'build')."""
    text, verb = label.strip(), "build"
    for v in VERBS:
        if text.lower().startswith(v + " "):
            verb, text = v, text[len(v) + 1:]
            break
    m = re.match(r"([A-Za-z]{1,2}\d+)\b[\s:-]*(.*)", text)
    key, rest = (m.group(1).upper(), m.group(2)) if m else (text, "")
    first = rest.split(" ", 1)[0].lower() if rest else ""
    if verb == "build" and first in VERBS:  # "C1 review" names the verb after the id
        verb, rest = first, rest[len(first):].strip()
    kind = "review" if verb in ("review", "integrate", "verify") else "build"
    return key, rest.strip(), kind, verb


def workflow_agents(wf):
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/*/subagents/workflows/{wf}"))
    if not hits:
        print(f"derive: workflow {wf} not found under ~/.claude/projects", file=sys.stderr)
        return []
    d = hits[0]
    labels, finished = {}, set()
    for line in open(os.path.join(d, "journal.jsonl")):
        o = json.loads(line)
        if o.get("type") == "started":
            labels[o["agentId"]] = o.get("label", "")
        elif o.get("type") == "result":
            finished.add(o.get("agentId"))
    now = dt.datetime.now().astimezone()
    out = []
    for aid, label in labels.items():
        f = os.path.join(d, f"agent-{aid}.jsonl")
        if not os.path.exists(f):
            continue
        ts = []
        for line in open(f):
            try:
                t = json.loads(line).get("timestamp")
            except ValueError:
                continue
            if t:
                ts.append(parse_t(t))
        if not ts:
            continue
        start, end = min(ts), max(ts)
        if aid in finished:
            state = "done"
        elif (now - end).total_seconds() < CUT_AFTER_MIN * 60:
            state, end = "running", None
        else:
            state = "cut"
        out.append({"label": label, "start": start, "end": end, "state": state})
    return out


def derive(path):
    plan = json.load(open(path))
    planned_names = {t["label"].split()[0].upper(): t["label"] for ph in plan["phases"]
                     for t in ph.get("tasks", []) if re.match(r"^[A-Za-z]{1,2}\d+\b", t["label"])}
    for ph in plan["phases"]:
        lanes = {}
        for wf in ph.get("workflows", []):
            for a in workflow_agents(wf):
                key, rest, kind, verb = lane_of(a["label"])
                lane = lanes.setdefault(key, {"key": key, "label": "", "segments": []})
                if verb == "build" and rest and not lane["label"]:
                    lane["label"] = rest
                seg = {"s": a["start"].isoformat(timespec="seconds"),
                       "e": a["end"].isoformat(timespec="seconds") if a["end"] else None,
                       "kind": kind, "note": verb + (f" · {rest}" if rest and verb != "build" else "")}
                if a["state"] == "cut":
                    seg["note"] += " · cut before it finished"
                    seg["cut"] = True
                lane["segments"].append(seg)
        notes = ph.get("notes", {})
        auto = []
        for key in sorted(lanes, key=natural):
            lane = lanes[key]
            lane["segments"].sort(key=lambda s: s["s"])
            if re.match(r"^[A-Z]{1,2}\d+$", key):
                name = planned_names.get(key) or f"{key} {lane['label']}".strip()
            else:
                name = key
            auto.append({"label": name, "segments": lane["segments"], "note": notes.get(key, ""),
                         "auto": True})
        if ph.get("workflows"):
            ph["auto_tasks"] = auto
    plan["derived_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    json.dump(plan, open(path, "w"), indent=1, ensure_ascii=False)
    n = sum(len(p.get("auto_tasks", [])) for p in plan["phases"])
    print(f"derive: {n} lanes from workflow journals written to {path}")


def natural(s):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]


# ---------------------------------------------------------------- layout

def build_rows(plan, now):
    """Resolve every phase into rows of segments with real times; schedule the planned ones."""
    phases = []
    cursor = None
    for ph in plan["phases"]:
        tasks = list(ph.get("auto_tasks", [])) + list(ph.get("tasks", []))
        rows = []
        for t in tasks:
            segs = []
            for s in t.get("segments", []):
                if isinstance(s, list):
                    s = {"s": s[0], "e": s[1]}
                st = parse_t(s["s"])
                en = parse_t(s.get("e")) if s.get("e") else None
                status = "running" if en is None else ("pause" if s.get("kind") == "pause" else "done")
                segs.append({"s": st, "e": en or now, "kind": s.get("kind") or t.get("kind") or ph["kind"],
                             "status": status, "note": s.get("note", ""), "cut": s.get("cut", False)})
            rows.append({"label": t["label"], "note": t.get("note", ""), "segs": segs,
                         "est": t.get("est_hours"), "after": t.get("after"), "after_phase": t.get("after_phase"), "not_before": t.get("not_before"),
                         "kind": t.get("kind") or ph["kind"]})
        phases.append({"id": ph["id"], "label": ph["label"], "kind": ph["kind"],
                       "planned": ph.get("status") in ("planned", "next"), "next": ph.get("status") == "next",
                       "with": ph.get("with"), "expect_until": ph.get("expect_until"), "waits": ph.get("waits", ""),
                       "est": ph.get("est_hours"), "note": ph.get("note", ""), "rows": rows})
        for r in rows:
            for s in r["segs"]:
                if s["status"] != "pause" or True:
                    cursor = max(cursor, s["e"]) if cursor else s["e"]
    for ph in phases:  # a running lane in a phase with "expect_until" gets a dashed tail to it
        eu = parse_t(ph.get("expect_until")) if ph.get("expect_until") else None
        if not eu or eu <= now:
            continue
        for r in ph["rows"]:
            if any(s["status"] == "running" for s in r["segs"]):
                r["segs"].append({"s": now, "e": eu, "kind": r["kind"], "status": "planned",
                                  "note": f"expected by {eu.strftime('%H:%M')} (the worker's deadline)", "cut": False})
    real_keys = {r["label"].split()[0] for ph in phases for r in ph["rows"] if r["segs"]}
    for ph in phases:
        ph["rows"] = [r for r in ph["rows"] if r["segs"] or not (r["est"] and r["label"].split()[0] in real_keys)]
        has_real = any(r["segs"] for r in ph["rows"])
        ph["mixed"] = has_real and any(r["est"] and not r["segs"] for r in ph["rows"])
        if has_real:
            ph["planned"] = False
    cursor = max(cursor or now, now)
    plan_start = cursor
    # Planned phases follow one another after the latest end so far, unless "with" names a phase
    # they run beside; a lane's "after_phase" waits for that whole phase to end.
    p_start, p_end = {}, {}
    for ph in phases:
        segs = [s for r in ph["rows"] for s in r["segs"]]
        if not ph["planned"] and segs:
            p_start[ph["id"]] = min(s["s"] for s in segs)
            p_end[ph["id"]] = max(s["e"] for s in segs)
    for ph in phases:
        if not ph["planned"] and not ph.get("mixed"):
            continue
        if ph.get("mixed"):
            start = now
        else:
            start = p_start.get(ph.get("with"), cursor) if ph.get("with") else cursor
        ends = {}
        for r in ph["rows"]:
            if r["segs"]:  # real work already drawn
                ends[r["label"]] = max(s["e"] for s in r["segs"])
                continue
            if r["after"]:
                st = ends.get(r["after"], start)
            elif r.get("after_phase"):
                st = p_end.get(r["after_phase"], start)
            else:
                st = start
            if r.get("not_before"):
                st = max(st, parse_t(r["not_before"]))
            hours = r["est"] or ph["est"] or 1
            en = st + dt.timedelta(hours=hours)
            ends[r["label"]] = en
            r["segs"] = [{"s": st, "e": en, "kind": r["kind"], "status": "planned",
                          "note": f"estimate {hours:g} h" + (f", after {r['after_phase']}" if r.get("after_phase") else ""),
                          "cut": False}]
        if not ph["rows"]:
            hours = ph["est"] or 1
            en = start + dt.timedelta(hours=hours)
            ph["rows"] = [{"label": ph["label"], "note": ph["note"], "est": hours, "after": None,
                           "kind": ph["kind"],
                           "segs": [{"s": start, "e": en, "kind": ph["kind"], "status": "planned",
                                     "note": f"estimate {hours:g} h", "cut": False}]}]
            ends[ph["label"]] = en
        p_start.setdefault(ph["id"], start)
        p_end[ph["id"]] = max(ends.values())
        cursor = max(cursor, p_end[ph["id"]])
    return phases, plan_start, cursor


def make_axis(phases, plan_start, plan_end, gap_min, future_share=0.32):
    """Fold idle gaps; give real work and the plan their own linear scales.

    Real work keeps one scale, so bar lengths compare across every done phase. The plan
    (estimates) gets at most `future_share` of the track on its own scale, marked "+N h",
    so a long estimate never squeezes the work that really happened."""
    real = sorted((s["s"], s["e"]) for ph in phases for r in ph["rows"] for s in r["segs"]
                  if s["status"] != "planned")
    blocks = []
    for s, e in real:
        if blocks and (s - blocks[-1][1]).total_seconds() <= gap_min * 60:
            blocks[-1][1] = max(blocks[-1][1], e)
        else:
            blocks.append([s, e])
    past_min = sum((e - s).total_seconds() for s, e in blocks) / 60
    fut_min = max((plan_end - plan_start).total_seconds() / 60, 0)
    BREAK = 1.6  # percent of the track per folded gap
    breaks = max(len(blocks) - 1, 0) + (1 if fut_min and blocks else 0)
    usable = 100 - breaks * BREAK
    if fut_min and past_min:
        fut_w = min(future_share * usable, usable * fut_min / (fut_min + past_min))
    else:
        fut_w = usable if fut_min else 0
    past_scale = (usable - fut_w) / past_min if past_min else 0
    fut_scale = fut_w / fut_min if fut_min else 0
    spans, off = [], 0.0
    for i, (s, e) in enumerate(blocks):
        w = (e - s).total_seconds() / 60 * past_scale
        spans.append({"s": s, "e": e, "x0": off, "x1": off + w, "scale": past_scale, "future": False})
        off += w
        if i < len(blocks) - 1:
            gap = (blocks[i + 1][0] - e).total_seconds() / 60
            spans.append({"gap": True, "x0": off, "x1": off + BREAK, "minutes": gap})
            off += BREAK
    if fut_min:
        if blocks:
            spans.append({"gap": True, "plan": True, "x0": off, "x1": off + BREAK, "minutes": 0})
            off += BREAK
        spans.append({"s": plan_start, "e": plan_end, "x0": off, "x1": off + fut_w, "scale": fut_scale,
                      "future": True})

    def x(t, planned=False):
        cand = [sp for sp in spans if not sp.get("gap") and sp["future"] == planned] or \
               [sp for sp in spans if not sp.get("gap")]
        for sp in cand:
            if sp["s"] <= t <= sp["e"]:
                return sp["x0"] + (t - sp["s"]).total_seconds() / 60 * sp["scale"]
        prev = None  # inside a folded gap: the middle of its break band
        for sp in spans:
            if not sp.get("gap") and sp["s"] > t and sp["future"] == planned:
                return (prev["x0"] + prev["x1"]) / 2 if prev else sp["x0"]
            prev = sp if sp.get("gap") else prev
        return cand[-1]["x1"] if cand else 100.0
    return spans, x


def ticks(spans, plan_start):
    out, last_day, last_x = [], None, -99
    for sp in spans:
        if sp.get("gap"):
            continue
        scale = sp["scale"]
        for step_h in (0.25, 0.5, 1, 2, 3, 6, 12, 24):
            if step_h * 60 * scale >= 5.5:
                break
        step = dt.timedelta(hours=step_h)
        if sp["future"]:
            t = sp["s"] + step
            while t < sp["e"]:
                xx = sp["x0"] + (t - sp["s"]).total_seconds() / 60 * scale
                out.append({"x": xx, "label": f"+{(t - plan_start).total_seconds() / 3600:g} h",
                            "future": True, "day": ""})
                t += step
            continue
        t = sp["s"].replace(minute=0, second=0, microsecond=0)
        if t < sp["s"] and t + step > sp["e"]:  # a block shorter than a step: label its start
            day = sp["s"].strftime("%-d %b") if sp["s"].date() != last_day else ""
            out.append({"x": sp["x0"], "label": sp["s"].strftime("%H:%M"), "future": False, "day": day})
            last_x, last_day = sp["x0"], sp["s"].date()
        while t < sp["e"]:
            if t >= sp["s"]:
                xx = sp["x0"] + (t - sp["s"]).total_seconds() / 60 * scale
                day = t.strftime("%-d %b") if t.date() != last_day else ""
                if xx - last_x >= 4.5:
                    out.append({"x": xx, "label": t.strftime("%H:%M"), "future": False, "day": day})
                    last_x = xx
                    if day:
                        last_day = t.date()
            t += step
    return out


# ---------------------------------------------------------------- render

CSS = """
.bg{--surface:%(surface)s;--ink:#efe4d0;--ink2:#b8a888;--ink3:#8d7d64;--line:#4a3a28;
 background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:12px;
 padding:14px 16px 12px;font:13px/1.35 ui-sans-serif,system-ui,sans-serif;position:relative}
.bg h1{font-size:16px;margin:0 0 2px;font-weight:650}
.bg .sub{color:var(--ink2);font-size:12px;margin-bottom:8px}
.bg .kpi{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 10px;font-size:12px;color:var(--ink2)}
.bg .kpi b{color:var(--ink);font-size:14px}
.bg .legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--ink2);margin-bottom:8px}
.bg .sw{display:inline-block;width:12px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:4px}
.bg .grid{display:grid;grid-template-columns:var(--lw) 1fr;column-gap:8px;position:relative}
.bg .lab{font-size:11.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
 height:17px;line-height:17px}
.bg .lab.ph{color:var(--ink);font-weight:650;font-size:12.5px;height:22px;line-height:24px}
.bg .trk{position:relative;height:17px}
.bg .trk.ph{height:22px}
.bg .bar{position:absolute;top:3px;height:11px;border-radius:3px;box-sizing:border-box;overflow:hidden;
 white-space:nowrap;font-size:9.5px;line-height:11px;color:#140e09;padding:0 3px;cursor:default}
.bg .trk.ph .bar{top:8px;height:8px;border-radius:2px}
.bg .bar.planned{background:transparent!important;border:1.5px dashed;color:var(--ink2);opacity:.95}
.bg .bar.running{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.28) 0 4px,transparent 4px 8px)!important;
 background-size:11px 11px;animation:mv 1s linear infinite}
@keyframes mv{to{background-position:11px 0}}
.bg .bar.pause{background:repeating-linear-gradient(135deg,%(pause)s 0 3px,transparent 3px 6px)!important}
.bg .bar.cut{box-shadow:inset -3px 0 0 #e66767}
.bg .axis{position:relative;height:27px;font-size:10px;color:var(--ink3)}
.bg .axis span.d{top:15px;color:var(--ink2)}
.bg .axis span{position:absolute;transform:translateX(-50%%);white-space:nowrap;top:3px}
.bg .axis span.f{color:#9085e9}
.bg .ov{position:absolute;top:0;bottom:0;pointer-events:none}
.bg .tl{position:absolute;top:0;bottom:0;width:1px;background:rgba(239,228,208,.07)}
.bg .gap{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(90deg,transparent 0 2px,rgba(239,228,208,.10) 2px 3px)}
.bg .gapl{position:absolute;top:-1px;font-size:9.5px;color:var(--ink3);transform:translateX(-50%%);white-space:nowrap}
.bg .now{position:absolute;top:0;bottom:0;width:2px;background:#9085e9}
.bg .nowl{position:absolute;top:-1px;font-size:10px;color:#9085e9;transform:translateX(-50%%);font-weight:600}
.bg .strip{position:relative;height:22px;margin:2px 0 6px}
.bg .strip div{position:absolute;top:0;height:20px;border-radius:4px;font-size:10.5px;line-height:20px;color:#140e09;
 padding:0 4px;box-sizing:border-box;overflow:hidden;white-space:nowrap;font-weight:600}
.bg .strip div.planned{background:transparent!important;border:1.5px dashed;color:var(--ink)}
.bg #tip{position:absolute;display:none;background:#120d09;border:1px solid var(--line);border-radius:6px;
 padding:6px 8px;font-size:11.5px;max-width:300px;white-space:pre-line;z-index:5;pointer-events:none;color:var(--ink)}
.bg details{margin-top:8px;font-size:11.5px;color:var(--ink2)}
.bg table{border-collapse:collapse;margin-top:4px}
.bg td,.bg th{padding:1px 8px 1px 0;text-align:left;font-weight:400}
.bg th{color:var(--ink3)}
"""

JS = """
(function(){const r=document.currentScript.parentElement,tip=r.querySelector('#tip');
r.addEventListener('mousemove',e=>{const b=e.target.closest('[data-t]');if(!b){tip.style.display='none';return}
tip.textContent=b.getAttribute('data-t');tip.style.display='block';const R=r.getBoundingClientRect();
let x=e.clientX-R.left+12,y=e.clientY-R.top+14;if(x>R.width-310)x=R.width-310;tip.style.left=x+'px';tip.style.top=y+'px'});
r.addEventListener('mouseleave',()=>tip.style.display='none');
function rh(){try{parent.postMessage({__tinkerHtmlFrame:1,h:document.body.scrollHeight+8},'*')}catch(e){}}
r.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',rh));rh();setTimeout(rh,300);})();
"""


def esc(s):
    return html.escape(str(s), quote=True)


def bar_html(s, x, cls_extra=""):
    planned = s["status"] == "planned"
    x0, x1 = x(s["s"], planned), x(s["e"], planned)
    w = max(x1 - x0, 0.35)
    color = PAUSE_COLOR if s["status"] == "pause" else KIND_COLOR.get(s["kind"], "#888")
    minutes = (s["e"] - s["s"]).total_seconds() / 60
    cls = ["bar", s["status"]] + (["cut"] if s.get("cut") else []) + ([cls_extra] if cls_extra else [])
    kind_name = "Pause" if s["status"] == "pause" else KIND_NAME.get(s["kind"], s["kind"])
    when = (f"{fmt_t(s['s'])} → {s['e'].strftime('%H:%M')}" if s["status"] != "planned"
            else "planned, after the work before it")
    status = {"done": "done", "running": "running now", "planned": "planned (estimate)",
              "pause": "pause"}[s["status"]]
    tip = (f"{s.get('row', '')}\n{kind_name} · {status}\n{when} · {fmt_dur(minutes)}"
           + (f"\n{s['note']}" if s.get("note") else ""))
    text = fmt_dur(minutes) if w > 4.5 and s["status"] != "pause" else ""
    style = f"left:{x0:.2f}%;width:{w:.2f}%;" + (f"border-color:{color}" if planned else f"background:{color}")
    return f'<div class="{" ".join(cls)}" style="{style}" data-t="{esc(tip)}">{esc(text)}</div>'


def render(plan, now, table=True, collapse_done=False):
    phases, plan_start, plan_end = build_rows(plan, now)
    spans, xa = make_axis(phases, plan_start, plan_end, plan.get("gap_minutes", 40),
                          plan.get("future_share", 0.32))
    x = xa
    tk = ticks(spans, plan_start)
    lw = plan.get("label_width", 230)

    worked = merged_minutes([(s["s"], s["e"]) for ph in phases for r in ph["rows"] for s in r["segs"]
                             if s["status"] in ("done", "running")])
    plan_segs = [s for ph in phases for s in phase_span(ph) if s["status"] == "planned"]
    planned_h = merged_minutes([(s["s"], s["e"]) for s in plan_segs]) / 60  # on the clock
    planned_work_h = sum((s["e"] - s["s"]).total_seconds() / 3600 for s in plan_segs)  # summed over lanes
    done_phases = [ph["label"] for ph in phases if not ph["planned"] and all(
        s["status"] != "running" for r in ph["rows"] for s in r["segs"])]
    running = [ph["label"] for ph in phases if any(s["status"] == "running" for r in ph["rows"]
                                                   for s in r["segs"])]
    nxt = next((ph["label"] for ph in phases if ph.get("next")), None) or next((ph["label"] for ph in phases if ph["planned"]), "nothing")
    pct = 100 * worked / 60 / (worked / 60 + planned_h) if (worked or planned_h) else 0

    out = [f'<div class="bg" style="--lw:{lw}px"><style>{CSS % {"surface": SURFACE, "pause": PAUSE_COLOR}}</style>']
    out.append(f"<h1>{esc(plan.get('title', 'Build'))}</h1>")
    if plan.get("subtitle"):
        out.append(f'<div class="sub">{esc(plan["subtitle"])}</div>')
    out.append('<div class="kpi">'
               f"<span>Worked <b>{esc(fmt_dur(worked))}</b></span>"
               f"<span>Estimated left <b>{planned_h:.0f} h</b> on the clock ({planned_work_h:.0f} h of unit work)</span>"
               f"<span>About <b>{pct:.0f} %</b> of the estimated time done</span>"
               f"<span>Now <b>{esc(', '.join(running) or 'between phases')}</b></span>"
               f"<span>Next <b>{esc(nxt)}</b></span></div>")
    leg = "".join(f'<span><i class="sw" style="background:{c}"></i>{esc(n)}</span>' for _, n, c in KINDS)
    leg += ('<span><i class="sw" style="background:#c9a86a"></i>solid = done</span>'
            '<span><i class="sw" style="background:repeating-linear-gradient(45deg,#c9a86a 0 3px,#7a6640 3px 6px)"></i>striped = running</span>'
            '<span><i class="sw" style="border:1.5px dashed #c9a86a;box-sizing:border-box"></i>dashed = planned (estimate)</span>'
            f'<span><i class="sw" style="background:repeating-linear-gradient(135deg,{PAUSE_COLOR} 0 2px,transparent 2px 4px)"></i>pause</span>'
            '<span><i class="sw" style="box-shadow:inset -3px 0 0 #e66767;background:#3a2d1e"></i>red edge = cut short</span>')
    out.append(f'<div class="legend">{leg}</div>')

    # roadmap strip: one block per phase
    out.append('<div class="grid"><div class="lab ph">Phases</div><div class="strip">')
    for ph in phases:
        segs = phase_span(ph)
        if not segs:
            continue
        x0, x1 = x(min(s["s"] for s in segs), ph["planned"]), x(max(s["e"] for s in segs), ph["planned"])
        c = KIND_COLOR.get(ph["kind"], "#888")
        cls = "planned" if ph["planned"] else ""
        tip = f"{ph['label']}\n{fmt_dur(sum((s['e'] - s['s']).total_seconds() / 60 for s in merge_segs(segs)))}" + (
            f"\nwaits: {ph['waits']}" if ph["waits"] else "") + (f"\n{ph['note']}" if ph["note"] else "")
        short = ph["label"].split(" · ")[0]
        out.append(f'<div class="{cls}" style="left:{x0:.3f}%;width:{max(x1 - x0, 0.6):.3f}%;background:{c};border-color:{c}" data-t="{esc(tip)}">{esc(short)}</div>')
    out.append("</div></div>")

    # axis
    def axis_row():
        a = ['<div class="grid"><div></div><div class="axis">']
        for t in tk:
            a.append(f'<span class="{"f" if t["future"] else ""}" style="left:{t["x"]:.3f}%">{esc(t["label"])}</span>')
            if t["day"]:
                a.append(f'<span class="d" style="left:{t["x"]:.3f}%">{esc(t["day"])}</span>')
        for sp in spans:
            if sp.get("plan"):
                a.append(f'<span class="f" style="left:{sp["x1"] + 0.3:.3f}%;transform:none">plan →</span>')
        a.append("</div></div>")
        return "".join(a)
    out.append(axis_row())

    # body with overlay (grid lines, folded gaps, now line)
    out.append('<div class="grid" style="position:relative">')
    ov = [f'<div class="ov" style="left:calc(var(--lw) + 8px);right:0">']
    for t in tk:
        ov.append(f'<div class="tl" style="left:{t["x"]:.3f}%"></div>')
    for sp in spans:
        if sp.get("gap"):
            ov.append(f'<div class="gap" style="left:{sp["x0"]:.3f}%;width:{sp["x1"] - sp["x0"]:.3f}%"></div>')
    nx = x(now)
    ov.append(f'<div class="now" style="left:{nx:.3f}%"></div>')
    ov.append("</div>")
    out.append("".join(ov))
    for ph in phases:
        segs = phase_span(ph)
        c = KIND_COLOR.get(ph["kind"], "#888")
        title = ph["label"] + (f" — waits: {ph['waits']}" if ph["waits"] else "")
        mark = " ⏸" if ph["waits"] else ""
        out.append(f'<div class="lab ph" title="{esc(title)}"><i class="sw" style="background:{c}"></i>{esc(ph["label"] + mark)}</div>')
        out.append('<div class="trk ph">')
        for s in merge_segs(segs):
            s2 = dict(s, row=ph["label"], note="whole phase", kind=ph["kind"])
            out.append(bar_html(s2, x))
        out.append("</div>")
        done = not ph["planned"] and not ph.get("mixed") and not any(
            s["status"] in ("running", "planned") for r in ph["rows"] for s in r["segs"])
        for r in ([] if (collapse_done and done) else ph["rows"]):
            out.append(f'<div class="lab" title="{esc(r["label"] + (" — " + r["note"] if r["note"] else ""))}">{esc(r["label"])}</div><div class="trk">')
            for s in r["segs"]:
                out.append(bar_html(dict(s, row=r["label"]), x))
            out.append("</div>")
    out.append("</div>")
    # gap and now labels on a second axis row
    gl = ['<div class="grid"><div></div><div class="axis">']
    lastg, row = -99, 0
    for sp in spans:
        if sp.get("gap") and not sp.get("plan"):
            mid = (sp["x0"] + sp["x1"]) / 2
            row = 1 - row if mid - lastg < 5 else 0
            h = sp["minutes"] / 60
            lab = f"{h:.0f} h" if h >= 1 else f"{sp['minutes']:.0f} m"
            gl.append(f'<span style="left:{mid:.3f}%;top:{3 + row * 11}px">⋯{esc(lab)}</span>')
            lastg = mid
    gl.append(f'<span class="f" style="left:{nx:.3f}%;top:3px">▲ now {now.strftime("%H:%M")}</span>')
    gl.append("</div></div>")
    out.append("".join(gl))
    out.append(axis_row())

    # table view (accessibility); left out of the chat block to keep it small, kept in --html
    if table:
        out.append("<details><summary>Table view</summary><table><tr><th>Phase</th><th>Lane</th><th>Kind</th>"
                   "<th>Start</th><th>End</th><th>Length</th><th>Status</th></tr>")
        for ph in phases:
            for r in ph["rows"]:
                for s in r["segs"]:
                    minutes = (s["e"] - s["s"]).total_seconds() / 60
                    out.append(f"<tr><td>{esc(ph['label'])}</td><td>{esc(r['label'])}</td>"
                               f"<td>{esc(KIND_NAME.get(s['kind'], s['kind']) if s['status'] != 'pause' else 'Pause')}</td>"
                               f"<td>{esc(fmt_t(s['s']) if s['status'] != 'planned' else '')}</td>"
                               f"<td>{esc(s['e'].strftime('%H:%M') if s['status'] != 'planned' else '')}</td>"
                               f"<td>{esc(fmt_dur(minutes))}</td><td>{esc(s['status'])}</td></tr>")
        out.append("</table></details>")
    foot = f"Drawn {now.strftime('%d %b %H:%M')}. Idle stretches over {plan.get('gap_minutes', 40)} min are folded; bar length is working time. Real work and the plan (estimates, +N h) have separate scales; ⏸ = waits on something outside the build."
    out.append(f'<div class="sub" style="margin:6px 0 0">{esc(foot)}</div>')
    out.append(f'<div id="tip"></div><script>{JS}</script></div>')
    return "".join(out)


def phase_span(ph):
    return [s for r in ph["rows"] for s in r["segs"]]


def merge_segs(segs):
    """Union of a phase's segments, for its summary bar; keeps the dominant status."""
    items = sorted(segs, key=lambda s: s["s"])
    out = []
    for s in items:
        if out and s["s"] <= out[-1]["e"]:
            last = out[-1]
            last["e"] = max(last["e"], s["e"])
            if s["status"] == "running":
                last["status"] = "running"
        else:
            out.append({"s": s["s"], "e": s["e"], "kind": s["kind"] if s["status"] != "pause" else s["kind"],
                        "status": "planned" if s["status"] == "planned" else
                        ("running" if s["status"] == "running" else "done"), "note": "", "cut": False})
    return out


def merged_minutes(intervals):
    total, cur = 0.0, None
    for s, e in sorted(intervals):
        if cur and s <= cur[1]:
            cur[1] = max(cur[1], e)
        else:
            if cur:
                total += (cur[1] - cur[0]).total_seconds() / 60
            cur = [s, e]
    if cur:
        total += (cur[1] - cur[0]).total_seconds() / 60
    return total


def chrome():
    for c in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "/opt/google/chrome/chrome"):
        p = c if os.path.isabs(c) else subprocess.run(["which", c], capture_output=True, text=True).stdout.strip()
        if p and os.path.exists(p):
            return p
    return None


def main(argv):
    if len(argv) < 3 or argv[1] not in ("derive", "render"):
        print(__doc__)
        return 2
    path = argv[2]
    if argv[1] == "derive":
        derive(path)
        return 0
    args = [a for a in argv[3:] if a != "--collapse-done"]
    opts = dict(zip(args[0::2], args[1::2]))
    now = parse_t(opts["--now"]) if "--now" in opts else dt.datetime.now().astimezone()
    plan = json.load(open(path))
    print("```html-render\n" + render(plan, now, table=False, collapse_done="--collapse-done" in argv) + "\n```")
    page = (f'<!doctype html><html><head><meta charset="utf-8"></head>'
            f'<body style="margin:0;padding:10px;background:#1a140e">{render(plan, now)}</body></html>')
    if "--html" in opts:
        open(opts["--html"], "w").write(page)
    if "--png" in opts:
        c = chrome()
        if not c:
            print("render: no Chrome found for --png", file=sys.stderr)
            return 1
        width = int(opts.get("--width", 1100))
        rows = sum(len(ph.get("auto_tasks", [])) + len(ph.get("tasks", [])) + 1 for ph in plan["phases"])
        height = 260 + rows * 18 + len(plan["phases"]) * 6
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
            f.write(page)
        subprocess.run([c, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        f"--screenshot={os.path.abspath(opts['--png'])}", f"--window-size={width},{height}",
                        "file://" + f.name], capture_output=True, timeout=60)
        os.unlink(f.name)
        print(f"render: wrote {opts['--png']} ({width}x{height})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
