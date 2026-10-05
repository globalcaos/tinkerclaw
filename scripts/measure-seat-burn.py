#!/usr/bin/env python3
"""Measure list-$ value burned inside each seat's CURRENT weekly quota window.

Usage: scripts/measure-seat-burn.py <claude_window_start_iso> <openai_window_start_iso>
Prints JSON: per seat, per model token sums and list-$ value.
Same method for both seats: every turn priced at its model's API list rate,
cache read = 0.1 x input, cache write = 1.25 x input (2 x for 1-hour TTL). Dedupe on
response/message id. Run it on EVERY host that shares the seat credentials (Goku) and
add the totals; then divide by the weekly meter from `openclaw gateway call budget.usage`
(claude.limits.seven_day / chatgpt.models.Weekly) and update SEAT_MEASURED in
src/shared/rel-cost-table.ts. Window start = resets_at minus 7 days.
"""
import glob, json, os, re, sys
from datetime import datetime, timezone

def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

C0, O0 = ts(sys.argv[1]), ts(sys.argv[2])
HOME = os.path.expanduser("~")

# $/Mtok (input, output) — vendor list, standard/short context.
PRICES = [
    (r"fable", (10, 50)),
    (r"opus-5[.-]5", (4, 20)),
    (r"opus", (5, 25)),
    (r"sonnet-5(?![.\d])", (2, 10)),
    (r"sonnet", (3, 15)),
    (r"haiku", (1, 5)),
    (r"gpt-6-astra", (10, 50)),
    (r"gpt-6-sol", (2, 10)),
    (r"gpt-6-luna", (0.10, 0.50)),
    (r"5\.6-sol", (4, 20)),
    (r"5\.6-terra", (2, 12)),
    (r"5\.6-luna", (0.20, 1.20)),
    (r"gpt-5\.5", (5, 30)),
]

def price(model):
    for pat, p in PRICES:
        if re.search(pat, model, re.I):
            return p
    return None

def add(acc, model, i, cr, cw, o):
    p = price(model)
    a = acc.setdefault(model, {"in": 0, "cacheRead": 0, "cacheWrite": 0, "out": 0, "turns": 0, "usd": 0.0, "priced": p is not None})
    a["in"] += i; a["cacheRead"] += cr; a["cacheWrite"] += cw; a["out"] += o; a["turns"] += 1
    if p:
        a["usd"] += (i * p[0] + cr * p[0] * 0.1 + cw * p[0] * 1.25 + o * p[1]) / 1e6

claude, openai = {}, {}
seen = set()

# 1) Claude Code transcripts (subscription seat = claude-cli OAuth).
for f in glob.glob(f"{HOME}/.claude/projects/**/*.jsonl", recursive=True):
    try:
        if os.path.getmtime(f) < C0:
            continue
        for line in open(f, errors="ignore"):
            if '"usage"' not in line or '"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get("message") or {}
            u = m.get("usage") or {}
            t = d.get("timestamp")
            if not u or not t or ts(t) < C0:
                continue
            key = ("c", m.get("id"), d.get("requestId"))
            if key in seen:
                continue
            seen.add(key)
            model = m.get("model") or "?"
            if model.startswith("<synthetic"):
                continue
            cc = u.get("cache_creation") or {}
            cw5 = cc.get("ephemeral_5m_input_tokens")
            cw1 = cc.get("ephemeral_1h_input_tokens")
            if cw5 is None and cw1 is None:
                cw5, cw1 = u.get("cache_creation_input_tokens", 0), 0
            # 1h-TTL writes bill at 2x input vs 1.25x: express them as 1.6x 5m-equivalents.
            add(claude, model, u.get("input_tokens", 0), u.get("cache_read_input_tokens", 0),
                (cw5 or 0) + (cw1 or 0) * 1.6, u.get("output_tokens", 0))
    except Exception:
        pass

# 2) Gateway transcripts: openai-codex turns (and any native anthropic turns, which
#    would not go through Claude Code — counted separately so they are visible).
gw_anthropic = {}
for f in glob.glob(f"{HOME}/.openclaw/agents/*/sessions/*.jsonl*"):
    if "trajectory" in f:
        continue
    try:
        if os.path.getmtime(f) < min(C0, O0):
            continue
        for line in open(f, errors="ignore"):
            if '"usage"' not in line:
                continue
            if "openai-codex" not in line and '"anthropic"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get("message") or {}
            prov = m.get("provider")
            u = m.get("usage") or {}
            t = m.get("timestamp")
            if not u or not t:
                continue
            t = t / 1000 if isinstance(t, (int, float)) else ts(t)
            if prov == "openai-codex" and t >= O0:
                key = ("o", m.get("responseId") or (t, u.get("totalTokens")))
                if key in seen:
                    continue
                seen.add(key)
                add(openai, m.get("model") or "?", u.get("input", 0), u.get("cacheRead", 0), u.get("cacheWrite", 0), u.get("output", 0))
            elif prov == "anthropic" and t >= C0:
                key = ("a", m.get("responseId") or (t, u.get("totalTokens")))
                if key in seen:
                    continue
                seen.add(key)
                add(gw_anthropic, m.get("model") or "?", u.get("input", 0), u.get("cacheRead", 0), u.get("cacheWrite", 0), u.get("output", 0))
    except Exception:
        pass

def tot(acc):
    return round(sum(a["usd"] for a in acc.values()), 2)

print(json.dumps({
    "host": os.uname().nodename,
    "claude": {"usd": tot(claude), "models": claude},
    "gateway_anthropic_direct": {"usd": tot(gw_anthropic), "models": gw_anthropic},
    "openai": {"usd": tot(openai), "models": openai},
}, indent=1, default=float))
