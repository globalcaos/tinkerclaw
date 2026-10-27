"""Who the owner is and what he is doing right now (the architect, 2026-10-22 14:06: "You should first understand my priorities
in life, like starting my own independent revenue stream ... Then you should understand my current focus, enjoying
myself or performing at work").

Two things, both computed in code each run and handed to triage, the butler and the escalation step:
  - the priorities: sections 1-3 of Jarvis's objectives file (revenue outside the day job, the funnel, how to value a task);
  - the focus now: "work" or "enjoy", from settings (an explicit switch, or the away periods: leave, trips) and the
    owner's local clock (weekends and evenings are "enjoy").
"""
import datetime
import re
from zoneinfo import ZoneInfo

from common import HOME, settings

OBJECTIVES = HOME / ".openclaw/workspace/memory/knowledge/jarvis-objectives.md"


def priorities():
    """Sections 1-3 of the objectives file, as plain text (about 4 KB). Empty if the file is missing."""
    try:
        text = OBJECTIVES.read_text(encoding="utf-8")
    except OSError:
        return ""
    m = re.search(r"^## 1\..*?(?=^## 4\.)", text, re.S | re.M)
    return (m.group(0) if m else "").strip()[:5000]


def _away_now(cfg, now_utc):
    for a in cfg.get("away") or []:
        try:
            start = datetime.date.fromisoformat(a["from"])
            end = datetime.date.fromisoformat(a["to"])
        except (KeyError, ValueError):
            continue
        if start <= now_utc.date() <= end:
            return a
    return None


def focus(now_utc=None):
    """{"focus": "work"|"enjoy", "why": "...", "tz": "...", "local": "YYYY-MM-DD HH:MM"}."""
    cfg = settings()
    now_utc = now_utc or datetime.datetime.now(datetime.timezone.utc)
    away = _away_now(cfg, now_utc)
    tz = ZoneInfo((away or {}).get("tz") or cfg.get("tz") or "Europe/Madrid")
    local = now_utc.astimezone(tz)
    out = {"tz": str(tz), "local": local.strftime("%Y-%m-%d %H:%M"), "hour": local.hour}
    pin = cfg.get("focus") or {}
    if pin.get("mode") in ("work", "enjoy") and (not pin.get("until") or pin["until"] >= now_utc.isoformat()):
        return {**out, "focus": pin["mode"], "why": "set by the architect"}
    if away:
        return {**out, "focus": "enjoy", "why": away.get("what") or "away"}
    if local.weekday() >= 5:
        return {**out, "focus": "enjoy", "why": "weekend"}
    if not 8 <= local.hour < 20:
        return {**out, "focus": "enjoy", "why": "outside working hours"}
    return {**out, "focus": "work", "why": "a working day"}


def brief():
    """The text block triage and the butler receive about the owner."""
    f = focus()
    return (f"Right now it is {f['local']} where the owner is ({f['tz']}); his focus is {f['focus'].upper()} "
            f"({f['why']}). In ENJOY focus only real emergencies and closing windows deserve his attention; "
            f"in WORK focus, normal priorities.\n\nHis priorities, in his own framing:\n{priorities()}")
