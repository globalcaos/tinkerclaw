#!/usr/bin/env python3
"""build-gantt: draw a master-worker build as a Gantt chart for the Tinker chat.

  gantt.py derive PLAN.json
      Fill each phase's lanes from the Claude Code workflow journals it names
      ("workflows": [...]): one lane per unit, a build segment and a review segment,
      with the real start and end read from each agent's own transcript.
  gantt.py render PLAN.json [--now ISO] [--html OUT.html] [--png OUT.png] [--width 1100]
      Print a ```html-render block on stdout. --html writes a standalone page,
      --png a screenshot of it (headless Chrome), for looking at it or for channels
      that cannot draw HTML. Run from a Tinker chat ($TC_SESSION_KEY set), it also
      attaches the plan to that chat, which gives a chained master its Gantt tab.
  gantt.py live PLAN.json [--fragment] [--now ISO]
      Derive in memory (the plan file is never written) and print the interactive
      page the Gantt tab shows: phases fold and unfold, a click on a lane opens what
      each unit was asked and what it reported. --fragment prints only the chart,
      which the page fetches again every few seconds.
  gantt.py agent WF AGENT_ID
      One workflow unit as JSON: model, task prompt, result summary, start, end, state.
  gantt.py attach PLAN.json [--session KEY] | detach [--session KEY]
      Register or drop a plan for a chat session (default $TC_SESSION_KEY) in
      ~/.openclaw/data/gantt-boards.json, the list the Tinker tab bar reads.

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


_WF_DIRS = None


def workflow_dir(wf):
    """One walk of ~/.claude/projects per process: a glob per workflow was 93 % of derive."""
    global _WF_DIRS
    if _WF_DIRS is None:
        _WF_DIRS = {}
        for d in glob.glob(os.path.expanduser("~/.claude/projects/*/*/subagents/workflows/wf_*")):
            _WF_DIRS.setdefault(os.path.basename(d), d)
    return _WF_DIRS.get(wf)


def _ts_of(line):
    try:
        t = json.loads(line).get("timestamp")
    except (ValueError, AttributeError):
        return None
    return parse_t(t) if t else None


def first_last_ts(f):
    """First and last timestamp of an agent transcript, read from its head and its tail.

    The transcript is append-only, so those two ends are its start and its end. Reading every line
    of every transcript made derive take 12-15 s on a 39-phase, 248-lane build (2026-10-05), and
    the Gantt tab derives again every few seconds; head and tail gave the same 449 segments."""
    with open(f, "rb") as fh:
        first = None
        for line in fh:
            first = _ts_of(line)
            if first:
                break
        if not first:
            return None, None
        size = fh.seek(0, os.SEEK_END)
        back = 1 << 16
        while True:
            start = max(0, size - back)
            fh.seek(start)
            lines = fh.read(size - start).split(b"\n")
            if start:
                lines = lines[1:]  # the first piece is the end of a line cut in half
            for line in reversed(lines):
                t = _ts_of(line)
                if t:
                    return first, t
            if not start:
                return first, first
            back <<= 2


def workflow_agents(wf):
    d = workflow_dir(wf)
    if not d:
        print(f"derive: workflow {wf} not found under ~/.claude/projects", file=sys.stderr)
        return []
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
        start, end = first_last_ts(f)
        if not start:
            continue
        if aid in finished:
            state = "done"
        elif (now - end).total_seconds() < CUT_AFTER_MIN * 60:
            state, end = "running", None
        else:
            state = "cut"
        out.append({"label": label, "start": start, "end": end, "state": state, "agent": aid})
    return out


AGENT_ID = re.compile(r"^[A-Za-z0-9]{1,64}$")
WF_ID = re.compile(r"^wf_[A-Za-z0-9_-]{1,64}$")
HARNESS_SPLIT = "The computed task text follows:\n"


def agent_detail(wf, aid):
    """What one workflow unit was asked to do and what it reported, for the Gantt tab's drawer."""
    if not WF_ID.match(wf or "") or not AGENT_ID.match(aid or ""):
        return {"error": "bad workflow or agent id"}
    d = workflow_dir(wf)
    f = os.path.join(d, f"agent-{aid}.jsonl") if d else ""
    if not d or not os.path.exists(f):
        return {"error": f"unit {aid} of {wf} not found"}
    label, result, finished = "", None, False
    for line in open(os.path.join(d, "journal.jsonl")):
        o = json.loads(line)
        if o.get("agentId") != aid:
            continue
        if o.get("type") == "started":
            label = o.get("label", "")
        elif o.get("type") == "result":
            result, finished = o.get("result"), True
    try:
        model = json.load(open(os.path.join(d, f"agent-{aid}.meta.json"))).get("model", "")
    except (OSError, ValueError):
        model = ""
    task = ""
    with open(f) as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("type") != "user":
                continue
            c = (o.get("message") or {}).get("content")
            if isinstance(c, list):
                c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
            task = str(c or "")
            break
    if HARNESS_SPLIT in task:  # drop the workflow harness preamble and its two-space indent
        task = "\n".join(ln[2:] if ln.startswith("  ") else ln
                         for ln in task.split(HARNESS_SPLIT, 1)[1].split("\n")).strip()
    summary, head = "", ""
    if isinstance(result, dict):
        head = str(result.get("head") or "")
        summary = result.get("summary")
        if not isinstance(summary, str):
            summary = json.dumps(result, indent=1, ensure_ascii=False)
    elif result is not None:
        summary = str(result)
    start, end = first_last_ts(f)
    now = dt.datetime.now().astimezone()
    if finished:
        state = "done"
    elif end and (now - end).total_seconds() < CUT_AFTER_MIN * 60:
        state = "running"
    else:
        state = "cut"
    return {"wf": wf, "agent": aid, "label": label, "model": model, "state": state,
            "start": start.isoformat(timespec="seconds") if start else None,
            "end": end.isoformat(timespec="seconds") if end else None,
            "head": head, "summary": summary[:6000], "task": task[:12000]}


def derive(path):
    plan = json.load(open(path))
    n = derive_plan(plan)
    json.dump(plan, open(path, "w"), indent=1, ensure_ascii=False)
    print(f"derive: {n} lanes from workflow journals written to {path}")


def derive_plan(plan):
    """Fill auto_tasks in memory and return the lane count; derive() is what writes the file."""
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
                seg["wf"], seg["agent"] = wf, a["agent"]  # the Gantt tab's drawer reads the unit
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
    return sum(len(p.get("auto_tasks", [])) for p in plan["phases"])


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
                             "status": status, "note": s.get("note", ""), "cut": s.get("cut", False),
                             "wf": s.get("wf"), "agent": s.get("agent")})
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


def seg_info(s):
    """The words for one segment, shared by the bar's tooltip and the Gantt tab's drawer."""
    minutes = (s["e"] - s["s"]).total_seconds() / 60
    return {
        "kindName": "Pause" if s["status"] == "pause" else KIND_NAME.get(s["kind"], s["kind"]),
        "when": (f"{fmt_t(s['s'])} → {s['e'].strftime('%H:%M')}" if s["status"] != "planned"
                 else f"planned, {fmt_t(s['s'])} → {fmt_t(s['e'])} if the estimate holds"),
        "statusText": {"done": "done", "running": "running now", "planned": "planned (estimate)",
                       "pause": "pause"}[s["status"]],
        "minutes": minutes,
        "dur": fmt_dur(minutes),
    }


def bar_html(s, x, cls_extra=""):
    planned = s["status"] == "planned"
    x0, x1 = x(s["s"], planned), x(s["e"], planned)
    w = max(x1 - x0, 0.35)
    color = PAUSE_COLOR if s["status"] == "pause" else KIND_COLOR.get(s["kind"], "#888")
    info = seg_info(s)
    minutes = info["minutes"]
    cls = ["bar", s["status"]] + (["cut"] if s.get("cut") else []) + ([cls_extra] if cls_extra else [])
    when = info["when"] if not planned else "planned, after the work before it"
    tip = (f"{s.get('row', '')}\n{info['kindName']} · {info['statusText']}\n{when} · {info['dur']}"
           + (f"\n{s['note']}" if s.get("note") else ""))
    text = fmt_dur(minutes) if w > 4.5 and s["status"] != "pause" else ""
    style = f"left:{x0:.2f}%;width:{w:.2f}%;" + (f"border-color:{color}" if planned else f"background:{color}")
    return f'<div class="{" ".join(cls)}" style="{style}" data-t="{esc(tip)}">{esc(text)}</div>'


def render(plan, now, table=True, collapse_done=False, interactive=False):
    """interactive=True is the Gantt tab's chart: every lane is emitted, phases carry data-ph and
    fold (done ones start folded), lanes carry data-lane, and the drawer's data rides along as
    JSON in #gd. The page around it (live_page) owns the script, so the chart can be swapped in
    place on each refresh."""
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
        goto = f' data-goto="{esc(ph["id"])}"' if interactive else ""
        out.append(f'<div class="{cls}" style="left:{x0:.3f}%;width:{max(x1 - x0, 0.6):.3f}%;background:{c};border-color:{c}" data-t="{esc(tip)}"{goto}>{esc(short)}</div>')
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
    lanes_data, phases_data = [], {}
    for ph in phases:
        segs = phase_span(ph)
        c = KIND_COLOR.get(ph["kind"], "#888")
        title = ph["label"] + (f" — waits: {ph['waits']}" if ph["waits"] else "")
        mark = " ⏸" if ph["waits"] else ""
        done = not ph["planned"] and not ph.get("mixed") and not any(
            s["status"] in ("running", "planned") for r in ph["rows"] for s in r["segs"])
        pid = esc(ph["id"])
        if interactive:
            out.append(f'<div class="lab ph tg{"" if done else " open"}" data-ph="{pid}" data-open="{0 if done else 1}" title="{esc(title)}">'
                       f'<b class="car"></b><i class="sw" style="background:{c}"></i>{esc(ph["label"] + mark)}</div>')
            out.append(f'<div class="trk ph" data-ph="{pid}">')
        else:
            out.append(f'<div class="lab ph" title="{esc(title)}"><i class="sw" style="background:{c}"></i>{esc(ph["label"] + mark)}</div>')
            out.append('<div class="trk ph">')
        for s in merge_segs(segs):
            s2 = dict(s, row=ph["label"], note="whole phase", kind=ph["kind"])
            out.append(bar_html(s2, x))
        out.append("</div>")
        if interactive:
            running_n = sum(1 for r in ph["rows"] if any(s["status"] == "running" for s in r["segs"]))
            phases_data[ph["id"]] = {
                "label": ph["label"], "kind": ph["kind"], "waits": ph["waits"], "note": ph["note"],
                "status": "done" if done else ("running" if running_n else ("planned" if ph["planned"] else "open")),
                "lanes": len(ph["rows"]), "running": running_n,
                "worked": fmt_dur(merged_minutes([(s["s"], s["e"]) for s in segs if s["status"] in ("done", "running")])),
            }
        seen = set()
        for r in ([] if (collapse_done and done and not interactive) else ph["rows"]):
            tip = esc(r["label"] + (" — " + r["note"] if r["note"] else ""))
            if not interactive:
                out.append(f'<div class="lab" title="{tip}">{esc(r["label"])}</div><div class="trk">')
            else:
                key = f'{ph["id"]}|{r["label"]}'
                while key in seen:
                    key += "+"
                seen.add(key)
                hid = " hid" if done else ""
                out.append(f'<div class="lab ln{hid}" data-in="{pid}" data-lane="{esc(key)}" title="{tip}">{esc(r["label"])}</div>'
                           f'<div class="trk ln{hid}" data-in="{pid}" data-lane="{esc(key)}">')
                lanes_data.append({
                    "key": key, "phase": ph["id"], "label": r["label"], "note": r["note"],
                    "kind": r["kind"], "est": r.get("est"), "after": r.get("after"),
                    "afterPhase": r.get("after_phase"),
                    "segs": [dict({k: v for k, v in seg_info(s).items() if k != "minutes"},
                                  kind=s["kind"], status=s["status"], note=s.get("note", ""),
                                  cut=bool(s.get("cut")), wf=s.get("wf"), agent=s.get("agent"),
                                  s=s["s"].isoformat(timespec="minutes"))
                             for s in r["segs"]],
                })
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
    if interactive:
        data = json.dumps({"lanes": lanes_data, "phases": phases_data, "drawn": now.isoformat(timespec="seconds")},
                          ensure_ascii=False).replace("</", "<\\/")
        out.append(f'<div id="tip"></div><script type="application/json" id="gd">{data}</script></div>')
    else:
        out.append(f'<div id="tip"></div><script>{JS}</script></div>')
    return "".join(out)


# ---------------------------------------------------------------- the Gantt tab (Tinker)

LIVE_REFRESH_S = 15

LIVE_CSS = """
html,body{margin:0;background:#1a140e;color:#efe4d0;font:13px/1.35 ui-sans-serif,system-ui,sans-serif}
#bar{position:sticky;top:0;z-index:20;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 12px;
 background:#1a140e;border-bottom:1px solid #4a3a28}
#bar button{background:#2e2318;color:#efe4d0;border:1px solid #4a3a28;border-radius:6px;padding:3px 9px;font:inherit;
 font-size:12px;cursor:pointer}
#bar button:hover{border-color:#c9a86a}
#now{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11.5px;color:#b8a888;margin-left:8px}
#now .c{background:#2e2318;border:1px solid #199e70;color:#efe4d0;border-radius:10px;padding:1px 8px;cursor:pointer}
#now .c:hover{background:#3a2d1e}
#live{font-size:11.5px;color:#b8a888;margin-left:auto;white-space:nowrap}
#live i{display:inline-block;width:8px;height:8px;border-radius:50%;background:#199e70;margin-right:5px;animation:pl 2s infinite}
#live.stale i{background:#e66767;animation:none}
@keyframes pl{50%{opacity:.3}}
#chart{padding:10px 12px}
.bg .lab.tg{cursor:pointer}
.bg .lab.tg .car{display:inline-block;width:13px;color:#b8a888;font-weight:400}
.bg .lab.tg .car::before{content:'\\25B8'}
.bg .lab.tg.open .car::before{content:'\\25BE'}
.bg .trk.ph,.bg .ln,.bg .strip div{cursor:pointer}
.bg .lab.ln{padding-left:14px}
.bg .lab.ln:hover,.bg .lab.ln.sel{color:#efe4d0;background:rgba(239,228,208,.07)}
.bg .trk.ln.sel{background:rgba(239,228,208,.05)}
.bg .hid{display:none}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(470px,94vw);background:#120d09;border-left:1px solid #4a3a28;
 box-shadow:-8px 0 24px rgba(0,0,0,.5);transform:translateX(105%);transition:transform .18s;z-index:30;
 overflow-y:auto;padding:14px 16px;box-sizing:border-box}
#drawer.open{transform:none}
#drawer h2{font-size:15px;margin:0 26px 4px 0}
#drawer .x{position:absolute;top:8px;right:10px;cursor:pointer;color:#b8a888;font-size:20px;background:none;border:0}
#drawer .meta{color:#b8a888;font-size:12px;margin:2px 0 6px}
#drawer .seg{border:1px solid #4a3a28;border-radius:8px;padding:8px 10px;margin:8px 0}
#drawer .seg.running{border-color:#199e70}
#drawer .seg h3{font-size:12.5px;margin:0 0 2px;font-weight:650}
#drawer .k{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
#drawer pre{white-space:pre-wrap;word-break:break-word;background:#1a140e;border:1px solid #4a3a28;border-radius:6px;
 padding:6px 8px;font:11.5px/1.45 ui-monospace,monospace;max-height:360px;overflow:auto;color:#d8ccb4}
#drawer details summary{cursor:pointer;color:#b8a888;font-size:12px;margin-top:6px}
#drawer .sum{font-size:12.5px;white-space:pre-wrap;margin-top:4px;line-height:1.45}
"""

LIVE_JS = """
(function(){
const S=new URLSearchParams(location.search).get('session')||'',PK='gantt-open:'+S,EVERY=%(every)d*1000;
const COL=%(colors)s;
const chart=document.getElementById('chart'),drawer=document.getElementById('drawer'),
 live=document.getElementById('live'),nowEl=document.getElementById('now');
let pref={};try{pref=JSON.parse(localStorage.getItem(PK)||'{}')||{}}catch(e){}
let data={lanes:[],phases:{}},sel=null,selSig='',busy=false;const units={};
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const q=v=>CSS.escape(v);
function read(){const g=chart.querySelector('#gd');if(g){try{data=JSON.parse(g.textContent)}catch(e){}}}
function phLab(id){return chart.querySelector('.lab.tg[data-ph="'+q(id)+'"]')}
function isOpen(id){if(id in pref)return pref[id];const el=phLab(id);return !!el&&el.dataset.open==='1'}
function apply(){chart.querySelectorAll('.lab.tg').forEach(el=>{const id=el.dataset.ph,o=isOpen(id);
 el.classList.toggle('open',o);chart.querySelectorAll('[data-in="'+q(id)+'"]').forEach(r=>r.classList.toggle('hid',!o))});
 chart.querySelectorAll('.ln').forEach(el=>el.classList.toggle('sel',el.dataset.lane===sel))}
function save(){try{localStorage.setItem(PK,JSON.stringify(pref))}catch(e){}}
function setOpen(id,o){pref[id]=o;save();apply()}
function lane(key){return data.lanes.find(l=>l.key===key)}
function sig(L){return L?L.segs.map(s=>s.status+s.when).join('|'):''}
function chips(){const run=data.lanes.filter(l=>l.segs.some(s=>s.status==='running'));
 nowEl.innerHTML=run.length?'<span>Running now:</span>'+run.map(l=>{const s=l.segs.find(x=>x.status==='running');
 return '<span class="c" data-lane="'+esc(l.key)+'" title="'+esc(s.when)+'">'+esc(l.phase)+' · '+esc(l.label)+' · '+esc(s.dur)+'</span>'}).join('')
 :'<span>Nothing running right now</span>'}
function show(key){const el=chart.querySelector('.lab.ln[data-lane="'+q(key)+'"]');if(el)el.scrollIntoView({block:'center',behavior:'smooth'})}
function openLane(key){const L=lane(key);if(!L)return;sel=key;selSig=sig(L);apply();
 const P=data.phases[L.phase]||{};
 let h='<button class="x" title="Close (Esc)">&times;</button><h2>'+esc(L.label)+'</h2><div class="meta">'+esc(P.label||L.phase)
 +(L.note?'<br>'+esc(L.note):'')+(L.est?'<br>Estimate '+esc(L.est)+' h':'')+(L.after?'<br>Starts after '+esc(L.after):'')
 +(L.afterPhase?'<br>Starts after phase '+esc(L.afterPhase):'')+(P.waits?'<br>&#9208; Waits on: '+esc(P.waits):'')+'</div>';
 L.segs.forEach(s=>{h+='<div class="seg '+esc(s.status)+'"><h3><i class="k" style="background:'+(COL[s.kind]||'#888')+'"></i>'
 +esc(s.kindName)+' &middot; '+esc(s.statusText)+'</h3><div class="meta">'+esc(s.when)+' &middot; '+esc(s.dur)+(s.note?' &middot; '+esc(s.note):'')+'</div>'
 +(s.agent?'<div class="unit" data-wf="'+esc(s.wf)+'" data-agent="'+esc(s.agent)+'"><div class="meta">Loading what this unit was asked and what it reported&hellip;</div></div>':'')+'</div>'});
 if(!L.segs.some(s=>s.agent))h+='<div class="meta">'+(L.segs.every(s=>s.status==='planned')?'Not started yet: the bar is the plan\\'s estimate.':'Drawn from the plan file; no workflow unit is linked to this lane.')+'</div>';
 drawer.innerHTML=h;drawer.classList.add('open');drawer.querySelectorAll('.unit').forEach(loadUnit)}
async function loadUnit(el){const k=el.dataset.wf+'/'+el.dataset.agent;let a=units[k];
 if(!a){try{const r=await fetch('/api/gantt/agent?wf='+encodeURIComponent(el.dataset.wf)+'&agent='+encodeURIComponent(el.dataset.agent),{cache:'no-store'});
 a=await r.json();if(!r.ok||a.error)throw new Error(a.error||('HTTP '+r.status));if(a.state==='done')units[k]=a}
 catch(e){el.innerHTML='<div class="meta">Could not load this unit: '+esc(e.message)+'</div>';return}}
 el.innerHTML='<div class="meta">'+esc(a.model||'model not recorded')+(a.head?' &middot; commit '+esc(a.head):'')+' &middot; '+esc(a.wf)+'</div>'
 +(a.summary?'<div class="sum">'+esc(a.summary)+'</div>':'<div class="meta">'+(a.state==='running'?'Still working; no report yet.':'Ended without a report.')+'</div>')
 +(a.task?'<details'+(a.summary?'':' open')+'><summary>What it was asked to do</summary><pre>'+esc(a.task)+'</pre></details>':'')}
function closeDrawer(){drawer.classList.remove('open');sel=null;apply()}
chart.addEventListener('click',e=>{const g=e.target.closest('[data-goto]');
 if(g){setOpen(g.dataset.goto,true);const el=phLab(g.dataset.goto);if(el)el.scrollIntoView({block:'start',behavior:'smooth'});return}
 const p=e.target.closest('[data-ph]');if(p){setOpen(p.dataset.ph,!isOpen(p.dataset.ph));return}
 const l=e.target.closest('[data-lane]');if(l)openLane(l.dataset.lane)});
nowEl.addEventListener('click',e=>{const c=e.target.closest('[data-lane]');if(!c)return;const L=lane(c.dataset.lane);
 if(L){setOpen(L.phase,true);show(L.key);openLane(L.key)}});
drawer.addEventListener('click',e=>{if(e.target.closest('.x'))closeDrawer()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()});
document.getElementById('expand').onclick=()=>{Object.keys(data.phases).forEach(id=>pref[id]=true);save();apply()};
document.getElementById('collapse').onclick=()=>{Object.keys(data.phases).forEach(id=>pref[id]=false);save();apply()};
document.getElementById('auto').onclick=()=>{pref={};save();apply()};
chart.addEventListener('mousemove',e=>{const tip=chart.querySelector('#tip'),bg=chart.querySelector('.bg');if(!tip||!bg)return;
 const b=e.target.closest('[data-t]');if(!b){tip.style.display='none';return}tip.textContent=b.getAttribute('data-t');tip.style.display='block';
 const R=bg.getBoundingClientRect();let x=e.clientX-R.left+12,y=e.clientY-R.top+14;if(x>R.width-310)x=R.width-310;tip.style.left=x+'px';tip.style.top=y+'px'});
chart.addEventListener('mouseleave',()=>{const t=chart.querySelector('#tip');if(t)t.style.display='none'});
function stamp(){live.classList.remove('stale');live.innerHTML='<i></i>live &middot; updated '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
async function refresh(){if(busy||document.hidden)return;busy=true;
 try{const r=await fetch('/api/gantt/chart?session='+encodeURIComponent(S),{cache:'no-store'});const t=await r.text();
 if(!r.ok)throw new Error(t.slice(0,120)||('HTTP '+r.status));const y=scrollY;chart.innerHTML=t;read();apply();chips();scrollTo(0,y);
 if(sel&&drawer.classList.contains('open')){const L=lane(sel);if(!L)closeDrawer();else if(sig(L)!==selSig)openLane(sel)}stamp()}
 catch(e){live.classList.add('stale');live.innerHTML='<i></i>not updated: '+esc(e.message)}finally{busy=false}}
read();apply();chips();stamp();setInterval(refresh,EVERY);document.addEventListener('visibilitychange',refresh);
})();
"""


def live_page(chart, title):
    js = LIVE_JS % {"every": LIVE_REFRESH_S, "colors": json.dumps(dict(KIND_COLOR, pause=PAUSE_COLOR))}
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>{esc(title)} · Gantt</title>'
            f"<style>{LIVE_CSS}</style></head><body>"
            '<div id="bar"><button id="expand">Expand all</button><button id="collapse">Collapse all</button>'
            '<button id="auto" title="Finished phases folded, running and planned ones open">Default</button>'
            '<div id="now"></div><span id="live"><i></i>live</span></div>'
            f'<div id="chart">{chart}</div><div id="drawer"></div><script>{js}</script></body></html>')


def boards_file():
    return os.environ.get("GANTT_BOARDS_FILE") or os.path.expanduser("~/.openclaw/data/gantt-boards.json")


def read_boards():
    try:
        b = json.load(open(boards_file())).get("boards", {})
        return b if isinstance(b, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def write_boards(boards):
    f = boards_file()
    os.makedirs(os.path.dirname(f), exist_ok=True)
    tmp = f + ".tmp"
    json.dump({"boards": boards}, open(tmp, "w"), indent=1, ensure_ascii=False)
    os.replace(tmp, f)


def attach(path, session):
    """Give this chat a Gantt tab: Tinker draws it next to the chat while it is a chain master."""
    path = os.path.abspath(path)
    try:
        title = json.load(open(path)).get("title", "")
    except (OSError, ValueError):
        title = ""
    boards = {k: v for k, v in read_boards().items() if os.path.exists(v.get("plan", ""))}
    if boards.get(session, {}).get("plan") == path and boards[session].get("title") == title:
        return False
    boards[session] = {"plan": path, "title": title,
                       "at": dt.datetime.now().astimezone().isoformat(timespec="seconds")}
    write_boards(boards)
    return True


def detach(session):
    boards = read_boards()
    gone = [k for k in boards if k == session or k.endswith(":" + session) or session.endswith(":" + k)]
    for k in gone:
        del boards[k]
    if gone:
        write_boards(boards)
    return gone


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
    cmds = ("derive", "render", "live", "agent", "attach", "detach")
    if len(argv) < 2 or argv[1] not in cmds or (len(argv) < 3 and argv[1] != "detach"):
        print(__doc__)
        return 2
    if argv[1] == "agent":
        if len(argv) < 4:
            print(__doc__)
            return 2
        d = agent_detail(argv[2], argv[3])
        print(json.dumps(d, ensure_ascii=False))
        return 1 if "error" in d else 0
    if argv[1] in ("attach", "detach"):
        rest = argv[2:] if argv[1] == "detach" else argv[3:]
        opts = dict(zip(rest[0::2], rest[1::2]))
        session = opts.get("--session") or os.environ.get("TC_SESSION_KEY", "")
        if not session:
            print(f"{argv[1]}: no --session and no $TC_SESSION_KEY", file=sys.stderr)
            return 2
        if argv[1] == "attach":
            attach(argv[2], session)
            print(f"attach: {os.path.abspath(argv[2])} is the Gantt tab of {session}")
        else:
            print(f"detach: dropped {detach(session) or 'nothing'}")
        return 0
    path = argv[2]
    if argv[1] == "derive":
        derive(path)
        return 0
    args = [a for a in argv[3:] if a not in ("--collapse-done", "--fragment")]
    opts = dict(zip(args[0::2], args[1::2]))
    now = parse_t(opts["--now"]) if "--now" in opts else dt.datetime.now().astimezone()
    plan = json.load(open(path))
    if argv[1] == "live":
        if any(ph.get("workflows") for ph in plan["phases"]):
            derive_plan(plan)
        chart = render(plan, now, table=False, interactive=True)
        print(chart if "--fragment" in argv else live_page(chart, plan.get("title", "Build")))
        return 0
    print("```html-render\n" + render(plan, now, table=False, collapse_done="--collapse-done" in argv) + "\n```")
    if os.environ.get("TC_SESSION_KEY") and attach(path, os.environ["TC_SESSION_KEY"]):
        print(f"render: this chat's Gantt tab now shows {os.path.abspath(path)}", file=sys.stderr)
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
