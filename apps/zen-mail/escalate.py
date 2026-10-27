"""Urgency that grows by itself, and a voice when it must (the architect, 2026-10-22 14:06: "the RobotVendor issue where they
were insisting ... was important to respond fast and should have gained more importance, and then you should have
pinged me out loud if the issue was not resolved soon").

Triage scores a topic when its mail changes; nothing re-scored it while it sat. This step runs on every sync, needs no
model, and for each open topic that wants something from the owner works out how much the waiting itself has added:
  +1 when the other side has written twice or more since the owner's last message (they are chasing),
  +1 when an important topic (importance 2+) has waited 48 h or more since the owner last wrote,
  +1 when its deadline is today or tomorrow.
The result (capped at 3) is kept in topics.extra.esc with its reasons; the list sorts by it.
At level 3 with importance 2+ (3+ while his focus is "enjoy"), the phone gets a notification, at most once per 12 h
per topic. If the topic is still open 4 h after that notification, Jarvis calls him out loud with a discreet line, only
between 09:00 and 21:00 where he is, at most twice a day. Every alert is logged in `alerts`.
"""
import datetime
import json
import re
import subprocess

from common import log, now_iso, parse_date, settings, source_of
import owner

NOTIFY_EVERY_H = 12
CALL_AFTER_H = 4
CALLS_PER_DAY = 2
CALL_HOURS = (9, 21)
NOTIFY_PER_RUN = 2  # the most pressing first; a first run on an old backlog must not fire a dozen at once
# Machines repeating a notice are not people chasing (Google Cloud's billing reminders, 2026-10-22 dry run).
MACHINE = re.compile(r"no-?reply|do-?not-?reply|notification|notify|alert|billing|mailer|postmaster|microsoftexchange|"
                     r"jira@|bounce|news(letter)?@|info@", re.I)
CALL_LINE = "Sir, one matter in your mail has been waiting a while and needs you. It is at the top of Zen Mail."


def _ensure(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, topic TEXT, kind TEXT, ts TEXT, level INT,"
                 " text TEXT)")


def _hours(since, now):
    d = parse_date(since)
    return (now - d).total_seconds() / 3600 if d else 0.0


def pressure(conn, t, me, now):
    """(level, reasons) for one topic."""
    msgs = conn.execute("SELECT from_addr, date FROM messages WHERE acct=? AND conv=? ORDER BY date",
                        (t["acct"], t["conv"])).fetchall()
    mine = [m["date"] for m in msgs if m["from_addr"] == me]
    last_mine = mine[-1] if mine else ""
    theirs = [m["date"] for m in msgs if m["from_addr"] != me and (m["date"] or "") > last_mine
              and not MACHINE.search(m["from_addr"] or "")]
    level, why = int(t["urgency"] or 0), []
    if len(theirs) >= 2:
        level += 1
        why.append(f"chased {len(theirs)} times")
    waited = _hours(theirs[0], now) if theirs else 0
    if waited >= 48 and (t["importance"] or 0) >= 2:
        level += 1
        why.append(f"waiting {int(waited // 24)} days")
    if t["deadline"]:
        try:
            days = (datetime.date.fromisoformat(t["deadline"]) - now.date()).days
            if days <= 1:
                level += 1
                why.append("deadline " + ("passed" if days < 0 else "today" if days == 0 else "tomorrow"))
        except ValueError:
            pass
    return min(level, 3), why


def _phone_node():
    try:
        out = subprocess.run(["openclaw", "nodes", "status", "--json", "--timeout", "60000"], capture_output=True,
                             text=True, timeout=90).stdout
        status = json.loads(out[out.index("{"):])
        n = next((x for x in status.get("nodes") or [] if x.get("connected") and "android" in str(x.get("platform", "")).lower()), None)
        return (n or {}).get("nodeId") or (n or {}).get("displayName")
    except Exception as err:
        log(f"[escalate] no phone node: {err}")
        return None


def _notify(title, body):
    node = _phone_node()
    if not node:
        return False
    params = json.dumps({"title": title, "body": body, "priority": "timeSensitive"})
    r = subprocess.run(["openclaw", "nodes", "invoke", "--node", node, "--command", "system.notify", "--params", params,
                        "--json", "--timeout", "60000"], capture_output=True, text=True, timeout=90)
    if r.returncode:
        log(f"[escalate] notify failed: exit {r.returncode}")
    return r.returncode == 0


def _call(line):
    r = subprocess.run(["jarvis-call", line], capture_output=True, text=True, timeout=180)
    if r.returncode:
        log(f"[escalate] call failed: exit {r.returncode}")
    return r.returncode == 0


def _last(conn, topic, kind):
    r = conn.execute("SELECT ts FROM alerts WHERE topic=? AND kind=? ORDER BY id DESC LIMIT 1", (topic, kind)).fetchone()
    return r["ts"] if r else None


def run(conn, dry=False):
    _ensure(conn)
    cfg = settings()
    now = datetime.datetime.now(datetime.timezone.utc)
    f = owner.focus(now)
    min_imp = 3 if f["focus"] == "enjoy" else 2
    raised = alerts = 0
    hot = []  # (level, importance, topic, reasons) of topics past the alert line, alerted most pressing first
    for acct, spec in cfg["accounts"].items():
        me = (spec.get("address") or "").lower()
        rows = conn.execute("SELECT * FROM topics WHERE acct=? AND state='open' AND private=0 AND noise=0"
                            " AND need IN ('reply','decide','act','seize')", (acct,)).fetchall()
        for t in rows:
            if source_of(t["conv"]) == "jarvis":
                continue
            level, why = pressure(conn, t, me, now)
            extra = json.loads(t["extra"] or "{}")
            old = (extra.get("esc") or {}).get("level")
            extra["esc"] = {"level": level, "why": why, "at": now_iso()}
            conn.execute("UPDATE topics SET extra=? WHERE id=?", (json.dumps(extra, ensure_ascii=False), t["id"]))
            raised += level > int(t["urgency"] or 0)
            if level >= 3 and (t["importance"] or 0) >= min_imp:
                hot.append((level, t["importance"] or 0, len(why), t, why))
    notified = 0
    for level, _imp, _n, t, why in sorted(hot, key=lambda h: h[:3], reverse=True):
        if True:
            last_n = _last(conn, t["id"], "notify")
            if not last_n or _hours(last_n, now) >= NOTIFY_EVERY_H:
                if notified >= NOTIFY_PER_RUN:
                    continue
                text = f"{t['title']} ({', '.join(why) or 'urgent'})"
                notified += 1
                alerts += 1
                if dry:
                    log(f"[escalate] would notify: {text}")
                elif _notify("Zen Mail · needs you", text):
                    conn.execute("INSERT INTO alerts(topic, kind, ts, level, text) VALUES(?,?,?,?,?)",
                                 (t["id"], "notify", now_iso(), level, text))
                continue
            calls_today = conn.execute("SELECT COUNT(*) FROM alerts WHERE kind='call' AND ts>=?",
                                       ((now - datetime.timedelta(hours=24)).isoformat(),)).fetchone()[0]
            last_c = _last(conn, t["id"], "call")
            if (_hours(last_n, now) >= CALL_AFTER_H and CALL_HOURS[0] <= f["hour"] < CALL_HOURS[1]
                    and calls_today < CALLS_PER_DAY and (not last_c or _hours(last_c, now) >= 24)):
                alerts += 1
                if dry:
                    log(f"[escalate] would call about: {t['title']}")
                elif _call(CALL_LINE):
                    conn.execute("INSERT INTO alerts(topic, kind, ts, level, text) VALUES(?,?,?,?,?)",
                                 (t["id"], "call", now_iso(), level, CALL_LINE))
    conn.commit()
    log(f"[escalate] focus {f['focus']} ({f['why']}): {raised} topics raised by waiting, {alerts} alerts")
    return raised, alerts
