"""A controlled release of dams (the architect, 2026-10-16): Zen Mail is where Jarvis tells the architect things, and new kinds of
things arrive one stream at a time, timidly, only when he is not busy, growing only when he engages.

Three parts, all code, no model:
- LOAD: how busy he is now, from what waits in Today (both mailboxes), what arrived in the last three hours, and
  whether he is clearing things this very minute (then nothing new appears until he stops).
- DAMS: each stream (streams.py) has a level. 0 sealed; 1 a trickle (one card a day, at the bottom, worded as a
  small idea, only when calm); 2 a stream (up to three a day, ranked like mail, not when busy); 3 open (up to eight a
  day, any load). A stream opens at level 1 when he is calm and nothing else opened in the last two days. His
  reactions move it: useful / done / opened lift it, "not now" is neutral, "less of this" and cards left unopened for
  two days lower it, "not this kind" seals it for two weeks. One level change per stream per day.
- LEARNING: every click on any card (mail included) is logged in `events`; senders he handles within four hours
  rise one step in the list, senders he keeps putting off sink one. When two sealed streams tie right after he
  closed one, Jarvis asks which to open next instead of guessing; otherwise it decides.
"""
import datetime
import json

from common import db, in_today, log, meta_get, meta_set, now_iso, parse_date, settings, source_of, topic_id
from streams import STREAMS

QUOTA = {1: 1, 2: 3, 3: 8}
LOAD_OK = {1: ("calm",), 2: ("calm", "normal"), 3: ("calm", "normal", "busy")}
SIGNAL = {"useful": 1.0, "addtask": 1.0, "taskdone": 1.0, "open": 0.8, "pick": 1.0, "done": 0.5, "gotit": 0.5,
          "seen": 0.25, "later": 0.0, "less": -1.0, "never": -1.0, "ignored": -0.5}
QUICK_S = 4 * 3600
OPEN_GAP_H = 48
STALE_H = 48


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _hours_since(iso):
    d = parse_date(iso)
    return (_now() - d).total_seconds() / 3600 if d else 1e9


# ─── load ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def load(conn):
    """'calm', 'normal' or 'busy', with the numbers behind it. Jarvis's own cards never count.

    Busy is FLOW, not backlog (2026-10-16: 185 items sat in Today, 30 marked urgent, most of them old; counting them
    would keep every dam shut for good). It counts what needs him that arrived recently and how hard he is working
    the list right now: urgent things from the last 24 hours, things needing an answer from the last 3 hours, and
    his own clicks in the last hour. Clicks in the last 10 minutes mean he is mid-flow: nothing new appears then.
    """
    now = _now()
    unread = {r["conv"]: r["n"] for r in conn.execute("SELECT conv, SUM(unread) n FROM messages GROUP BY conv")}
    urgent_new = fresh = backlog = 0
    for t in conn.execute("SELECT * FROM topics").fetchall():
        if source_of(t["conv"]) == "jarvis" or not in_today(t, now, unread):
            continue
        backlog += 1
        age_h = _hours_since(t["last_date"])
        urgent_new += (t["urgency"] or 0) >= 2 and age_h <= 24
        fresh += t["need"] in ("reply", "decide", "act") and age_h <= 3
    clicks = lambda minutes: conn.execute(
        "SELECT COUNT(*) FROM events WHERE ts >= ? AND act <> 'seen' AND src <> 'jarvis'",
        ((now - datetime.timedelta(minutes=minutes)).isoformat(timespec="seconds"),)).fetchone()[0]
    hour, flow = clicks(60), clicks(10)
    # First bar, set by hand on 2026-10-16 06:05 (4 urgent from the last day, nothing in 3 h, no clicks = not busy).
    # The hourly samples below are kept so a later pass can set the bar from his own normal instead.
    if urgent_new >= 8 or fresh >= 6 or hour >= 8:
        level = "busy"
    elif urgent_new <= 3 and fresh <= 2 and hour <= 2:
        level = "calm"
    else:
        level = "normal"
    out = {"level": level, "urgent_new": urgent_new, "fresh": fresh, "clicks_hour": hour, "backlog": backlog,
           "in_flow": flow >= 2}
    samples = meta_get(conn, "load_samples", []) or []
    if not samples or _hours_since(samples[-1].get("at")) >= 1:
        samples.append(dict(out, at=now_iso()))
        meta_set(conn, "load_samples", samples[-24 * 30:])
    return out


# ─── dams ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _stream(conn, sid):
    r = conn.execute("SELECT * FROM streams WHERE id=?", (sid,)).fetchone()
    return r or {"id": sid, "level": 0, "since": None, "blocked_until": None}


def _set_level(conn, sid, level, why, blocked_until=None):
    conn.execute("INSERT INTO streams(id, level, since, blocked_until) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET"
                 " level=excluded.level, since=excluded.since, blocked_until=excluded.blocked_until",
                 (sid, level, now_iso(), blocked_until))
    hist = meta_get(conn, "dam_history", []) or []
    hist.append({"at": now_iso(), "stream": sid, "level": level, "why": why})
    meta_set(conn, "dam_history", hist[-200:])
    log(f"[dams] {sid} -> level {level} ({why})")


def open_streams(conn):
    return [r["id"] for r in conn.execute("SELECT id FROM streams WHERE level >= 1")]


def _group_feel(conn):
    """How his reactions over the last two weeks lean, per group of streams (tasks, jarvis, home)."""
    since = (_now() - datetime.timedelta(days=14)).isoformat(timespec="seconds")
    feel = {}
    for r in conn.execute("SELECT stream, SUM(signal) s FROM events WHERE src='jarvis' AND ts >= ? GROUP BY stream", (since,)):
        g = (STREAMS.get(r["stream"]) or {}).get("group")
        if g:
            feel[g] = feel.get(g, 0) + (r["s"] or 0)
    return feel


def _ranked_sealed(conn):
    feel = _group_feel(conn)
    out = []
    for sid, spec in STREAMS.items():
        st = _stream(conn, sid)
        if st["level"] >= 1:
            continue
        if st["blocked_until"] and (parse_date(st["blocked_until"]) or _now()) > _now():
            continue
        out.append((spec["prior"] + max(-0.3, min(0.3, 0.1 * feel.get(spec["group"], 0))), sid))
    return sorted(out, reverse=True)


def next_in_line(conn):
    ranked = _ranked_sealed(conn)
    return ranked[0][1] if ranked else None


def _judged(conn, sid, n=6):
    """Net reaction to each of the stream's last `n` released cards that got one, oldest reactions weighing the same."""
    rows = conn.execute(
        "SELECT json_extract(t.extra, '$.cand') cand, SUM(e.signal) s, MAX(e.id) last FROM events e"
        " JOIN topics t ON t.id = e.topic WHERE e.src = 'jarvis' AND e.stream = ? GROUP BY cand ORDER BY last DESC LIMIT ?",
        (sid, n)).fetchall()
    return [max(-1.0, min(1.0, r["s"] or 0.0)) for r in rows]


def _maybe_move(conn, sid):
    st = _stream(conn, sid)
    if st["level"] < 1 or _hours_since(st["since"]) < 24:
        return
    vals = _judged(conn, sid)
    if len(vals) < 3:
        return
    avg = sum(vals) / len(vals)
    if avg >= 0.6 and st["level"] < 3:
        _set_level(conn, sid, st["level"] + 1, f"he engaged: average {avg:.2f} over {len(vals)} cards")
    elif avg <= -0.4 and st["level"] > 1:
        _set_level(conn, sid, st["level"] - 1, f"he turned away: average {avg:.2f} over {len(vals)} cards")


def _publish(conn, cand, level):
    """Turn a candidate into a card in Today (both mailboxes when it belongs to neither)."""
    spec = STREAMS.get(cand["stream"], {"label": "Jarvis"})
    accts = list(settings()["accounts"]) if cand["acct"] == "both" else [cand["acct"]]
    timid = level == 1
    actions = json.loads(cand["actions"] or "[]")
    actions += [{"k": "later", "label": "Not now"}, {"k": "less", "label": "Less of this"}]
    if timid:
        actions.append({"k": "never", "label": "Not this kind"})
    conv = "jarvis:" + cand["id"]
    stamp = now_iso()
    body = cand["body"] or ""
    if timid:
        body += "\n\n— This is new: I am trying out showing you “" + spec["label"].lower() + "”. If it helps, press a positive button and I will bring a little more; if not, “Not this kind” stops it."
    for acct in accts:
        if acct not in settings()["accounts"]:
            continue
        tid = topic_id(acct, conv)
        conn.execute(
            "INSERT OR REPLACE INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread, body,"
            " has_att, link, labels) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"{conv}@{acct}", acct, conv, "inbox", "Jarvis", "jarvis", "[]", cand["title"], stamp, 1, body, 0, cand["link"] or "", "[]"))
        u = 0 if timid else (2 if (cand["score"] or 0) >= 1 else 1)
        conn.execute(
            "INSERT OR REPLACE INTO topics(id, acct, conv, title, who, sender, need, urgency, importance, summary, facts,"
            " draft, state, noise, private, last_date, sig, updated, extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,'open',0,0,?,?,?,?)",
            (tid, acct, conv, cand["title"], spec["label"], "jarvis", "read", u, 0 if timid else 1, cand["summary"] or "",
             cand["facts"] or "[]", stamp, "jarvis", stamp,
             json.dumps({"stream": cand["stream"], "level": level, "timid": timid, "actions": actions,
                         "link": cand["link"] or "", "cand": cand["id"]}, ensure_ascii=False)))
    conn.execute("UPDATE candidates SET released=? WHERE id=?", (stamp, cand["id"]))


def _expire(conn):
    """A card left unopened for two days leaves Today and counts as a quiet no."""
    for t in conn.execute("SELECT * FROM topics WHERE sender='jarvis' AND state='open'").fetchall():
        if _hours_since(t["last_date"]) < STALE_H:
            continue
        extra = json.loads(t["extra"] or "{}")
        touched = conn.execute("SELECT 1 FROM events WHERE topic=? LIMIT 1", (t["id"],)).fetchone()
        conn.execute("UPDATE topics SET state='done' WHERE conv=?", (t["conv"],))
        if not touched:
            record(conn, t, "ignored", commit=False)
        _maybe_move(conn, extra.get("stream") or "")


def _released_today(conn, sid):
    start = datetime.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    return conn.execute("SELECT COUNT(*) FROM candidates WHERE stream=? AND released >= ?",
                        (sid, start.astimezone(datetime.timezone.utc).isoformat(timespec="seconds"))).fetchone()[0]


def _ask_next(conn, a, b):
    """Two dams tie right after he closed one: ask him instead of guessing."""
    cid = "meta:next-" + datetime.date.today().isoformat()
    if conn.execute("SELECT 1 FROM candidates WHERE id=?", (cid,)).fetchone():
        return
    la, lb = STREAMS[a]["label"], STREAMS[b]["label"]
    conn.execute(
        "INSERT INTO candidates(id, stream, acct, title, summary, facts, body, link, actions, score, created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (cid, "meta", "both", "What should I bring in next?",
         f"I can start showing you “{la.lower()}” or “{lb.lower()}”. You closed one kind lately, so I would rather ask.",
         "[]", f"Option 1: {la}\nOption 2: {lb}\n\nPick one and I start small: one card a day, only when your inbox is quiet.", "",
         json.dumps([{"k": "pick:" + a, "label": la}, {"k": "pick:" + b, "label": lb}]), 1.0, now_iso()))
    _publish(conn, conn.execute("SELECT * FROM candidates WHERE id=?", (cid,)).fetchone(), 2)


def release(conn):
    """Called on every page refresh and every sync: expire stale cards, maybe open a dam, let out what is due."""
    _expire(conn)
    ld = load(conn)
    meta_set(conn, "load", ld)
    if ld["in_flow"]:
        conn.commit()
        return ld
    opened = {r["id"]: r for r in conn.execute("SELECT * FROM streams WHERE level >= 1")}
    if ld["level"] == "calm":
        last_open = max([_hours_since(r["since"]) for r in opened.values()] or [1e9])
        settled = all(len(_judged(conn, sid)) >= 3 or _hours_since(r["since"]) >= 72 for sid, r in opened.items())
        if last_open >= OPEN_GAP_H and settled:
            ranked = _ranked_sealed(conn)
            closed_lately = any(h.get("level") == 0 and _hours_since(h.get("at")) < 7 * 24
                                for h in meta_get(conn, "dam_history", []) or [])
            if len(ranked) >= 2 and closed_lately and ranked[0][0] - ranked[1][0] < 0.05:
                _ask_next(conn, ranked[0][1], ranked[1][1])
            elif ranked:
                sid = ranked[0][1]
                if conn.execute("SELECT 1 FROM candidates WHERE stream=? AND released IS NULL AND gone=0", (sid,)).fetchone():
                    _set_level(conn, sid, 1, "he is calm and nothing opened in the last two days")
                    opened[sid] = _stream(conn, sid)
    timid_open = conn.execute("SELECT COUNT(*) FROM topics WHERE sender='jarvis' AND state='open'"
                              " AND json_extract(extra, '$.timid') = 1").fetchone()[0]
    for sid, st in sorted(opened.items(), key=lambda kv: -kv[1]["level"]):
        lvl = st["level"]
        if ld["level"] not in LOAD_OK[lvl] or _released_today(conn, sid) >= QUOTA[lvl]:
            continue
        if lvl == 1 and timid_open:
            continue  # one small idea on screen at a time
        cand = conn.execute("SELECT * FROM candidates WHERE stream=? AND released IS NULL AND gone=0"
                            " ORDER BY score DESC, created LIMIT 1", (sid,)).fetchone()
        if cand:
            _publish(conn, cand, lvl)
            timid_open += lvl == 1
    conn.commit()
    return ld


# ─── learning ────────────────────────────────────────────────────────────────────────────────────────────────────────

def record(conn, t, act, commit=True):
    """Log one reaction. For a Jarvis card it also moves its stream (or seals it on "not this kind")."""
    src = source_of(t["conv"])
    extra = json.loads((t["extra"] if "extra" in t.keys() else None) or "{}")
    stream = extra.get("stream") or ""
    base = act.split(":", 1)[0]
    age = int((_now() - (parse_date(t["last_date"]) or _now())).total_seconds())
    conn.execute("INSERT INTO events(ts, topic, acct, src, stream, sender, act, signal, age_s, u, i) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                 (now_iso(), t["id"], t["acct"], src, stream, t["sender"] or "", act, SIGNAL.get(base, 0.0), age,
                  t["urgency"] or 0, t["importance"] or 0))
    if src == "jarvis":
        if base == "never" and stream in STREAMS:
            until = (_now() + datetime.timedelta(days=14)).isoformat(timespec="seconds")
            _set_level(conn, stream, 0, "he said: not this kind", blocked_until=until)
            conn.execute("UPDATE topics SET state='done' WHERE sender='jarvis' AND json_extract(extra, '$.stream')=? AND state='open'", (stream,))
        elif base == "pick":
            sid = act.split(":", 1)[1]
            if sid in STREAMS:
                _set_level(conn, sid, 1, "he picked it")
        elif stream in STREAMS:
            _maybe_move(conn, stream)
    if commit:
        conn.commit()


def sender_boosts(conn):
    """+1 for senders he handles within four hours, -1 for senders he keeps putting off (three reactions or more)."""
    since = (_now() - datetime.timedelta(days=60)).isoformat(timespec="seconds")
    out = {}
    for r in conn.execute(
            "SELECT sender, COUNT(*) n, SUM(act IN ('approve','done','gotit') AND age_s <= ?) quick, SUM(act='later') off"
            " FROM events WHERE src <> 'jarvis' AND act <> 'seen' AND ts >= ? AND sender <> '' GROUP BY sender", (QUICK_S, since)):
        if r["n"] >= 3:
            out[r["sender"]] = 1 if (r["quick"] or 0) / r["n"] >= 0.6 else (-1 if (r["off"] or 0) / r["n"] >= 0.5 else 0)
    return out


def report(conn):
    """For Jarvis and for the architect's questions: each dam's level, what waits behind it, and the current load."""
    out = {"load": meta_get(conn, "load", {}), "streams": []}
    for sid, spec in STREAMS.items():
        st = _stream(conn, sid)
        out["streams"].append({
            "id": sid, "label": spec["label"], "level": st["level"], "since": st["since"], "blocked_until": st["blocked_until"],
            "waiting": conn.execute("SELECT COUNT(*) FROM candidates WHERE stream=? AND released IS NULL AND gone=0", (sid,)).fetchone()[0],
            "released": conn.execute("SELECT COUNT(*) FROM candidates WHERE stream=? AND released IS NOT NULL", (sid,)).fetchone()[0],
            "reactions": _judged(conn, sid)})
    out["next"] = next_in_line(conn)
    out["history"] = (meta_get(conn, "dam_history", []) or [])[-10:]
    return out


if __name__ == "__main__":
    print(json.dumps(report(db()), indent=1, ensure_ascii=False))
