#!/usr/bin/env python3
"""Supervise a child agent: how much a human uses it, what the child did for them, where effort leaks.

  child-activity-report.py --host <ssh-alias|local> --since 2026-09-15 [--until 2026-09-19]
      [--human-label "the operator"] [--rules rules.json] [--narrative narrative.json]
      --out report.html [--data data.json]

Read-only. It collects every prompt that reached a model on the child host from BOTH stores:
  ~/.claude/projects/*/*.jsonl           one file per CLI-bridge turn (the gateway index under-counts these)
  ~/.openclaw/agents/*/sessions/*.jsonl  gateway transcripts (API-model turns, e.g. Grok)
and classifies each prompt, in this order:
  auto    runtime-generated: internal events, overseer nudges, briefings, subagent tasks, reflection triage,
          background-task notifications, gateway system lines ("System: [..] Model switched")
  test    matches a --rules entry (e.g. the supervisor's own setup tests, a time window, a regex)
  repeat  identical text to an earlier HUMAN prompt, or one of >=2 distinct prompts carrying the same
          client timestamp but landing >5 min later (a UI outbox flush, not typing)
  human   everything else: the operator's own requests
rules.json: [{"label": "test", "before": "2026-09-16T10:00:00Z"}, {"label": "test", "regex": "^(ping|hola)$"},
             {"label": "redact", "regex": "<a password the human typed>"}]   emails and long hex tokens are always redacted
narrative.json (written by the supervising agent after reading the human sessions):
  {"working_on": "<html>", "needs": "<html>", "our_side": "<html>", "reading": "<html>"}
Values about a specific host or person belong in the caller's private memory, never in this file.
"""
import argparse, collections, datetime, html, json, re, subprocess, sys

COLLECT = r'''
import json, glob, os, datetime, re, sys
since = datetime.datetime.fromisoformat(sys.argv[1]).timestamp()
home = os.path.expanduser("~")
STAMP = re.compile(r"\[(\w{3} \d{4}-\d\d-\d\d \d\d:\d\d) UTC\]\s*(.*)", re.S)
def clean(t):
    t = t.split("\n\n---\n\n**After your reply")[0].split("\n\n<!-- TINKERCLAW")[0]
    t = re.sub(r"^Sender \(untrusted metadata\):\s*```.*?```\s*", "", t, flags=re.S)
    m = STAMP.match(t.strip())
    return (m.group(1), m.group(2)) if m else (None, t)
out = []
for f in glob.glob(home + "/.claude/projects/*/*.jsonl"):
    if os.path.getmtime(f) < since: continue
    prompts, tools, chars, model = [], 0, 0, None
    for l in open(f, errors="replace"):
        try: o = json.loads(l)
        except Exception: continue
        if o.get("type") == "user" and isinstance(o.get("message", {}).get("content"), str):
            prompts.append((o.get("timestamp", ""), o["message"]["content"]))
        elif o.get("type") == "assistant":
            model = model or o["message"].get("model")
            for x in o["message"].get("content", []):
                if x.get("type") == "tool_use": tools += 1
                if x.get("type") == "text": chars += len(x.get("text", ""))
    for ts, p in prompts:
        stamp, text = clean(p)
        out.append({"src": "cli", "unit": os.path.basename(f)[:8], "sent": ts[:19], "stamp": stamp,
                    "text": text[:4000], "len": len(p), "tools": tools, "replyChars": chars, "model": model})
AGENT_KINDS = {"subagent", "fractal-reflection", "cron", "explicit"}
agent_files = set()
for idx in glob.glob(home + "/.openclaw/agents/*/sessions/sessions.json"):
    try: store = json.load(open(idx))
    except Exception: continue
    for k, v in store.items():
        parts = k.split(":")
        if len(parts) > 2 and parts[2] in AGENT_KINDS and v.get("sessionFile"):
            agent_files.add(os.path.basename(v["sessionFile"]).split(".jsonl")[0])
for f in glob.glob(home + "/.openclaw/agents/*/sessions/*.jsonl*"):
    if "trajectory" in f or os.path.getmtime(f) < since: continue
    if os.path.basename(f).split(".jsonl")[0] in agent_files: continue  # agent-to-agent sessions, not a human's
    cur = None
    for l in open(f, errors="replace"):
        try: o = json.loads(l)
        except Exception: continue
        if o.get("type") != "message": continue
        m = o["message"]; c = m.get("content")
        if m.get("role") == "user":
            txt = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict) and x.get("type") == "text")
            stamp, text = clean(txt)
            cur = {"src": "gateway", "unit": os.path.basename(f)[:8] + ":" + str(o.get("id")), "sent": o.get("timestamp", "")[:19],
                   "stamp": stamp, "text": text[:4000], "len": len(txt), "tools": 0, "replyChars": 0, "model": None}
            out.append(cur)
        elif m.get("role") == "assistant" and cur is not None:
            cur["model"] = cur["model"] or m.get("model")
            for x in c if isinstance(c, list) else []:
                if x.get("type") == "toolCall": cur["tools"] += 1
                if x.get("type") == "text": cur["replyChars"] += len(x.get("text", ""))
ledger = os.path.exists(home + "/.openclaw/forensic/llm-ledger.sqlite")
print(json.dumps({"prompts": out, "ledger": ledger}))
'''

AUTO = re.compile(r"^(<<<BEGIN_OPENCLAW|⟦OVERSEER|Reply with exactly|\[Subagent Context\]|# FRACTAL|<task-notification>|System: \[)|Execute the morning briefing", re.S)
BUILTIN_REDACT = [r"[\w.+-]+@[\w-]+\.[\w.]+", r"\b[0-9a-fA-F]{32,}\b"]


def collect(host, since):
    cmd = ["python3", "-", since] if host == "local" else ["ssh", "-o", "BatchMode=yes", host, "nice -n19 python3 - " + since]
    r = subprocess.run(cmd, input=COLLECT, capture_output=True, text=True, timeout=300)
    if r.returncode:
        sys.exit(f"collect failed on {host}: {r.stderr.strip()[:400]}")
    return json.loads(r.stdout)


def redact(text, rules):
    """Never show a credential or address the human typed; private rules add host-specific ones."""
    for rx in BUILTIN_REDACT + [r["regex"] for r in rules if r.get("label") == "redact"]:
        text = re.sub(rx, "[redacted]", text)
    return text


def rule_match(r, p):
    if r.get("label") == "redact": return False
    if r.get("before") and not p["sent"] < r["before"].rstrip("Z"): return False
    if r.get("after") and not p["sent"] >= r["after"].rstrip("Z"): return False
    if r.get("regex") and not re.search(r["regex"], p["text"].strip(), re.S): return False
    return any(k in r for k in ("before", "after", "regex"))


def classify(prompts, rules, since, until):
    norm = lambda t: re.sub(r"\s+", " ", t).strip()[:600]
    seen, rows = {}, []
    for p in sorted(prompts, key=lambda x: (x["sent"], x["src"] != "cli")):
        if not p["sent"] or p["sent"] < since or (until and p["sent"] >= until):
            continue
        key = (p["stamp"] or p["sent"][:16], norm(p["text"]))
        if key in seen:  # same prompt stored by both the CLI bridge and the gateway
            s = seen[key]
            if p["src"] == "cli":  # the CLI turn file is the unit of work; count its effort once
                s["unit"], s["tools"], s["replyChars"] = p["unit"], p["tools"], p["replyChars"]
            continue
        seen[key] = p; rows.append(p)
    stamp_groups = collections.defaultdict(set)
    for p in rows:
        if p["stamp"]:
            stamp_groups[p["stamp"]].add(norm(p["text"]))
    human_texts = {}
    for p in rows:
        t, lag = norm(p["text"]), None
        if p["stamp"]:
            lag = (datetime.datetime.fromisoformat(p["sent"]) - datetime.datetime.strptime(p["stamp"][4:], "%Y-%m-%d %H:%M")).total_seconds()
        if AUTO.search(p["text"][:400]):
            p["cat"] = "auto"
        elif any(rule_match(r, p) for r in rules):
            p["cat"] = "test"
        elif (t in human_texts and (datetime.datetime.fromisoformat(p["sent"]) - human_texts[t]).total_seconds() > 1200) or \
             (lag is not None and lag > 300 and len(stamp_groups[p["stamp"]]) > 1):
            p["cat"] = "repeat"
        else:
            p["cat"] = "human"; human_texts.setdefault(t, datetime.datetime.fromisoformat(p["sent"]))
    return rows


CATS = [("human", "{h} (typed)", "#2e7d32"), ("repeat", "Repeat (UI replay or resend)", "#e08a1e"),
        ("test", "Supervisor / setup tests", "#7a8aa0"), ("auto", "Automatic (runtime, overseer)", "#c9b99a")]


def local(ts):
    return datetime.datetime.fromisoformat(ts).replace(tzinfo=datetime.timezone.utc).astimezone()


def render(rows, args, rules, ledger, narrative):
    hl = args.human_label
    days = sorted({local(r["sent"]).date() for r in rows})
    per = {d: collections.Counter(r["cat"] for r in rows if local(r["sent"]).date() == d) for d in days}
    eff, units = collections.defaultdict(lambda: [0, 0]), set()
    for r in rows:
        if r["unit"] in units: continue
        units.add(r["unit"]); eff[r["cat"]][0] += 1; eff[r["cat"]][1] += r["tools"]
    humans = [r for r in rows if r["cat"] == "human"]
    W, H, pad, bw = 560, 250, 40, 64
    mx = max([sum(c.values()) for c in per.values()] + [1]); sc = (H - 70) / mx; step = max(1, round(mx / 6))
    svg = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Prompts per day">']
    for g in range(0, mx + 1, step):
        y = H - 30 - g * sc
        svg.append(f'<line x1="{pad}" x2="{W-10}" y1="{y:.1f}" y2="{y:.1f}" stroke="#e4dccb"/><text x="{pad-6}" y="{y+4:.1f}" font-size="10" text-anchor="end" fill="#8a7a62">{g}</text>')
    gap = min(50, (W - pad - 40 - bw * len(days)) / max(len(days), 1))
    for i, d in enumerate(days):
        x, y = pad + 20 + i * (bw + gap), H - 30
        for k, _, col in CATS:
            n = per[d].get(k, 0)
            if not n: continue
            h = n * sc; y -= h
            svg.append(f'<rect x="{x:.0f}" y="{y:.1f}" width="{bw}" height="{h:.1f}" fill="{col}"><title>{n}</title></rect>')
            if h > 13: svg.append(f'<text x="{x+bw/2:.0f}" y="{y+h/2+4:.1f}" font-size="11" text-anchor="middle" fill="#fff" font-weight="600">{n}</text>')
        svg.append(f'<text x="{x+bw/2:.0f}" y="{H-12}" font-size="11" text-anchor="middle" fill="#4a3b2a">{d.strftime("%a %d")}</text>')
    svg.append("</svg>")
    legend = "".join(f'<span class="lg"><i style="background:{c}"></i>{html.escape(l.format(h=hl))}</span>' for _, l, c in CATS)
    mt = max([v[1] for v in eff.values()] + [1])
    bars = "".join(f'<div class="hb"><span class="hl">{html.escape(l.format(h=hl))}</span><span class="ht"><b style="width:{100*eff[k][1]/mt:.0f}%;background:{c}"></b></span><span class="hv">{eff[k][1]} tool calls · {eff[k][0]} turns</span></div>' for k, l, c in CATS if k in eff)
    tl = "".join(f'<tr><td>{local(r["sent"]).strftime("%a %d %b %H:%M")}</td><td>{html.escape(redact(r["text"], rules)[:260])}{"…" if len(r["text"]) > 260 else ""}</td><td>{r["tools"]} tools · {r["replyChars"]:,} chars · {html.escape((r["model"] or "?").split("/")[-1])}</td></tr>' for r in humans)
    kp = lambda n, l: f'<div class="kpi"><b>{n}</b><span>{l}</span></div>'
    sec = lambda t, k: f'<h2>{t}</h2><div class="card">{narrative[k]}</div>' if narrative.get(k) else ""
    period = f'{local(rows[0]["sent"]).strftime("%d %b")} – {local(rows[-1]["sent"]).strftime("%d %b %H:%M")}' if rows else "no data"
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><title>{html.escape(args.title)}</title>
<style>body{{font-family:system-ui,sans-serif;background:#f6f1e7;color:#2b2118;max-width:920px;margin:24px auto;padding:0 20px;line-height:1.5}}
h1{{font-size:24px;margin:0}}h2{{font-size:18px;margin:30px 0 8px;border-bottom:2px solid #d9c9a8;padding-bottom:4px}}.sub{{color:#7a6a52;margin:4px 0 18px}}
.card{{background:#fffdf8;border:1px solid #e2d6bd;border-radius:10px;padding:14px 16px;margin:10px 0}}.kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}}
.kpi{{background:#fffdf8;border:1px solid #e2d6bd;border-radius:10px;padding:10px}}.kpi b{{display:block;font-size:24px}}.kpi span{{font-size:12px;color:#7a6a52}}
.lg{{display:inline-flex;align-items:center;gap:6px;margin:4px 14px 0 0;font-size:12px}}.lg i{{width:12px;height:12px;border-radius:3px;display:inline-block}}
.hb{{display:grid;grid-template-columns:220px 1fr 150px;gap:10px;align-items:center;margin:6px 0;font-size:13px}}.ht{{background:#efe6d3;border-radius:6px;height:16px}}.ht b{{display:block;height:16px;border-radius:6px}}
table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{border-bottom:1px solid #eadfc8;padding:6px 8px;text-align:left;vertical-align:top}}th{{background:#efe6d3}}
.note{{font-size:12px;color:#7a6a52}}.pri{{font-weight:700;color:#8a3b12}}li{{margin:4px 0}}code{{font-size:12px}}</style>
<h1>{html.escape(args.title)}</h1><div class="sub">{period} · host <code>{html.escape(args.host)}</code> · generated {datetime.datetime.now().strftime("%d %b %H:%M")}</div>
<div class="kpis">{kp(len(humans), f"prompts {html.escape(hl)} typed")}{kp(len({r["unit"].split(":")[0] for r in humans}), "working sessions")}{kp(eff["human"][1], f"child actions for {html.escape(hl)}")}{kp(eff["repeat"][1], "child actions on repeats")}</div>
<h2>1 · How much it is used</h2><div class="card">{"".join(svg)}<div>{legend}</div></div>
<div class="card"><b>Where the child's effort went</b> (tool calls it ran){bars}</div>
<h2>2 · What {html.escape(hl)} asked</h2><div class="card"><table><tr><th>When</th><th>Prompt</th><th>Child's work (whole session)</th></tr>{tl}</table></div>
{sec("3 · What they are working on", "working_on")}{sec("4 · Resources worth the manager's attention", "needs")}{sec("5 · On our side", "our_side")}{sec("Reading", "reading")}
<h2>How this was measured</h2><p class="note">Prompts from the child's CLI-bridge turns and gateway transcripts, deduplicated. "Repeat" = identical to an earlier typed prompt, or several distinct prompts sharing one client timestamp (a UI outbox flush, not typing). {"Per-person driver attribution is available on this host in <code>~/.openclaw/forensic/llm-ledger.sqlite</code>; prefer it over these heuristics." if ledger else "This host has no LLM ledger yet, so who typed what is inferred from rules and timing, not recorded."}</p></html>'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True); ap.add_argument("--since", required=True); ap.add_argument("--until")
    ap.add_argument("--human-label", default="the operator"); ap.add_argument("--title", default="Child agent activity report")
    ap.add_argument("--rules"); ap.add_argument("--narrative"); ap.add_argument("--out", required=True); ap.add_argument("--data")
    a = ap.parse_args()
    got = collect(a.host, a.since)
    rules = json.load(open(a.rules)) if a.rules else []
    rows = classify(got["prompts"], rules, a.since, a.until)
    narrative = json.load(open(a.narrative)) if a.narrative else {}
    open(a.out, "w").write(render(rows, a, rules, got["ledger"], narrative))
    if a.data: json.dump(rows, open(a.data, "w"), indent=1)
    c = collections.Counter(r["cat"] for r in rows)
    print(json.dumps({"out": a.out, "prompts": len(rows), "by_class": c, "ledger_on_host": got["ledger"]}))


if __name__ == "__main__":
    main()
