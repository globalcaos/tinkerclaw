#!/usr/bin/env python3
"""Subjects to watch: a Gmail search Zen Mail runs every hour, with a card that speaks when it matters.

  python3 watch.py add <slug> "<title>" "<body>" --gmail '<gmail query>' [--standing] [--link URL] [--link-label TEXT]
  python3 watch.py check      # every watch's search; hourly after sync (zen-mail-sync drop-in)
  python3 watch.py list
  python3 watch.py remove <topic id>

Two kinds. A one-answer watch ("tell me when they confirm") pins its card on top and flips it to ✅ when a new
matching thread arrives. A standing watch (a sender that keeps writing, e.g. a school) treats everything already in
Gmail as known and reopens its card, in its normal rank, only when Zen Mail's triage gave a new thread a need.
A watch card is a Zen Mail topic with conv `jarvis:watch-<slug>` and extra.watch = {gmail, since, seen, standing}.
Moved here from the zen-watch skill on 2026-10-25 so the page can list, add and remove watches (2026-10-25 request).
Removing sets the card's state to 'removed': it stops being checked
and leaves both lists, and the row stays in the database.
"""
import argparse
import json
import re
import sys

from common import db, gog, now_iso, topic_id

ACCT = "personal"  # Gmail only: work-side (Outlook) watches are not built
IMPORTANT = ("act", "reply", "decide", "seize")


def gmail(query):
    return gog("gmail", "search", query, "--max", "10").get("threads") or []


def top_pin(conn, acct):
    pins = [json.loads(x[0]).get("pin") for x in conn.execute(
        "SELECT extra FROM topics WHERE acct=? AND state IN ('open','later') AND extra LIKE '%\"pin\"%'", (acct,))]
    pins = [p for p in pins if p is not None]
    return min(pins) - 1 if pins else 0


def slugify(title, conn):
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40].rstrip("-") or "watch"
    slug, n = base, 2
    while conn.execute("SELECT 1 FROM topics WHERE conv=? AND state!='removed'", ("jarvis:watch-" + slug,)).fetchone():
        slug, n = f"{base}-{n}", n + 1
    return slug


def add(title, body, query, standing=False, slug=None, link="", link_label="Obre"):
    conn, stamp = db(), now_iso()
    slug = slug or slugify(title, conn)
    conv = "jarvis:watch-" + slug
    seen = [t["id"] for t in gmail(query)]  # what is there already counts as known (the architect 2026-10-25 02:38)
    acts = ([{"k": "open", "label": link_label}] if link else []) + \
        [{"k": "done", "label": "Fet"}, {"k": "later", "label": "Ara no"}]
    extra = {"stream": "reminder", **({} if standing else {"pin": top_pin(conn, ACCT)}), "link": link, "actions": acts,
             "watch": {"gmail": query, "since": stamp, "seen": seen, "standing": bool(standing),
                       "name": title, "about": body}}
    card = ("📚 " if standing else "⏳ ") + title
    conn.execute("INSERT OR REPLACE INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread,"
                 " body, has_att, link, labels) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 (f"{conv}@{ACCT}", ACCT, conv, "inbox", "Recordatori", "reminder", "[]", card, stamp, 1, body, 0,
                  link, "[]"))
    # A standing watch starts quiet ('done'): it speaks when something important arrives, not when it is created.
    conn.execute("INSERT OR REPLACE INTO topics(id, acct, conv, title, who, sender, need, urgency, importance, summary,"
                 " facts, draft, state, noise, private, last_date, sig, updated, extra)"
                 " VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,0,0,?,?,?,?)",
                 (topic_id(ACCT, conv), ACCT, conv, card, "Recordatori", "reminder", "act", 2, 2, body, "[]",
                  "done" if standing else "open", stamp, "reminder", stamp, json.dumps(extra, ensure_ascii=False)))
    conn.commit()
    return {"ok": True, "id": topic_id(ACCT, conv), "conv": conv, "pin": extra.get("pin"), "already_seen": len(seen)}


def remove(tid):
    conn = db()
    n = conn.execute("UPDATE topics SET state='removed', updated=? WHERE id=? AND conv LIKE 'jarvis:watch-%'",
                     (now_iso(), tid)).rowcount
    conn.commit()
    if not n:
        raise ValueError("no such watch")
    return {"ok": True}


def watches(conn, all_states=False):
    # A standing watch also wakes from 'done': Fet clears today's mail, not the watch (2026-10-25, Eli's school).
    for row in conn.execute("SELECT id, title, summary, extra, state FROM topics WHERE conv LIKE 'jarvis:watch-%'"
                            " AND state!='removed'"):
        extra = json.loads(row[3])
        if row[4] in ("open", "later") or (all_states and extra["watch"].get("standing")):
            yield row[0], row[1], row[2], extra


def listing():
    """Every live watch for the page: one-answer watches until Fet, standing watches until removed."""
    out = []
    for r in db().execute("SELECT id, title, state, updated, extra FROM topics WHERE conv LIKE 'jarvis:watch-%'"
                          " AND state!='removed' ORDER BY updated DESC"):
        w = json.loads(r["extra"] or "{}").get("watch") or {}
        if not w.get("standing") and r["state"] not in ("open", "later"):
            continue
        last = w.get("hit") or (w.get("items") or [None])[0]
        name = w.get("name") or re.sub(r"^[⏳✅📚]\s*|\s*— answer arrived$", "", r["title"] or "")
        out.append({"id": r["id"], "name": name, "about": w.get("about") or "", "gmail": w.get("gmail"),
                    "standing": bool(w.get("standing")), "since": w.get("since"), "answered": bool(w.get("hit")),
                    "last": last, "card_open": r["state"] in ("open", "later")})
    return out


def standing_hit(conn, tid, extra, new):
    """2026-10-25: no need to sit on top; assume everything to date is known and report only what matters, when it
    matters. A new thread counts only when Zen Mail's own triage gave it a need
    (act, reply, decide, seize); the rest are marked seen silently. A thread not triaged yet waits for the next hour.
    The card reopens in its normal rank, never pinned to the top."""
    w = extra["watch"]
    important, quiet, later = [], [], []
    for t in new:
        row = conn.execute("SELECT need FROM topics WHERE acct=? AND conv=?", (ACCT, t["id"])).fetchone()
        (later if row is None else important if row[0] in IMPORTANT else quiet).append(t)
    w["seen"] = w["seen"] + [t["id"] for t in important + quiet]
    extra.pop("pin", None)
    if not important:
        conn.execute("UPDATE topics SET extra=? WHERE id=?", (json.dumps(extra, ensure_ascii=False), tid))
        conn.commit()
        return
    items = [{"from": t["from"], "subject": t["subject"], "date": t["date"]} for t in important] + w.get("items", [])
    w["items"] = items[:15]
    name = w.get("name") or "watch"
    title = f"📚 {name}: {len(important)} new" if len(important) > 1 else f"📚 {name}: {important[0]['subject'][:70]}"
    body = w.get("about", "") + "\n\n" + "\n".join(f"- {i['date'][:16]} · {i['from'][:40]} · {i['subject']}" for i in w["items"])
    conn.execute("UPDATE topics SET title=?, summary=?, extra=?, state='open', updated=?, last_date=? WHERE id=?",
                 (title, body.strip(), json.dumps(extra, ensure_ascii=False), now_iso(), now_iso(), tid))
    conn.commit()
    print(f"[watch] standing {tid}: {len(important)} new")


def check():
    conn = db()
    for tid, title, body, extra in list(watches(conn, all_states=True)):
        w = extra["watch"]
        if not w.get("standing") and w.get("hit"):
            continue
        try:
            new = [t for t in gmail(w["gmail"]) if t["id"] not in w["seen"]]
        except Exception as e:  # one bad query must not stop the other watches
            print(f"[watch] {tid}: {e}", file=sys.stderr)
            continue
        if not new:
            continue
        if w.get("standing"):
            standing_hit(conn, tid, extra, new)
            continue
        t = new[0]
        w["hit"] = {"id": t["id"], "from": t["from"], "subject": t["subject"], "date": t["date"]}
        title = "✅ " + title.lstrip("⏳ ").strip() + " — answer arrived"
        body = f"Answer arrived {t['date']} from {t['from']}:\n“{t['subject']}”\n\n" + body
        conn.execute("UPDATE topics SET title=?, summary=?, extra=?, updated=?, last_date=? WHERE id=?",
                     (title, body, json.dumps(extra, ensure_ascii=False), now_iso(), now_iso(), tid))
        conn.commit()
        print(f"[watch] hit {tid}: {t['subject'][:80]}")


def find(slug):
    """Any watch whose conv or title matches slug, in every state (a Fet'd one-answer watch leaves list())."""
    conn = db()
    rows = conn.execute("SELECT id, conv, title, state, extra FROM topics WHERE conv LIKE 'jarvis:watch-%'"
                        " AND (conv LIKE ? OR title LIKE ?)", (f"%{slug}%", f"%{slug}%")).fetchall()
    return conn, rows


def status(slug):
    conn, rows = find(slug)
    out = []
    for r in rows:
        w = json.loads(r["extra"] or "{}").get("watch") or {}
        ev = conn.execute("SELECT ts, act, src FROM events WHERE topic=? ORDER BY ts DESC LIMIT 1", (r["id"],)).fetchone()
        out.append({"id": r["id"], "title": r["title"], "state": r["state"], "answered": bool(w.get("hit")),
                    "hit": w.get("hit"), "gmail": w.get("gmail"),
                    "last_click": dict(ev) if ev else None})
    return out


def reopen(slug):
    """Back to open and pinned on top: for a one-answer watch closed before its answer came (2026-10-26)."""
    conn, rows = find(slug)
    done = []
    for r in rows:
        extra = json.loads(r["extra"] or "{}")
        extra["pin"] = top_pin(conn, r["id"].split(":")[0])
        conn.execute("UPDATE topics SET state='open', extra=? WHERE id=?", (json.dumps(extra, ensure_ascii=False), r["id"]))
        done.append(r["id"])
    conn.commit()
    return {"ok": bool(done), "reopened": done}


def main():
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)
    ad = sp.add_parser("add")
    ad.add_argument("slug")
    ad.add_argument("title")
    ad.add_argument("body")
    ad.add_argument("--gmail", required=True)
    ad.add_argument("--standing", action="store_true")
    ad.add_argument("--link", default="")
    ad.add_argument("--link-label", default="Obre")
    rm = sp.add_parser("remove")
    rm.add_argument("id")
    sp.add_parser("check")
    sp.add_parser("list")
    st = sp.add_parser("status")
    st.add_argument("slug")
    ro = sp.add_parser("reopen")
    ro.add_argument("slug")
    a = p.parse_args()
    if a.cmd == "add":
        print(json.dumps(add(a.title, a.body, a.gmail, a.standing, a.slug, a.link, a.link_label)))
    elif a.cmd == "remove":
        print(json.dumps(remove(a.id)))
    elif a.cmd == "check":
        check()
    elif a.cmd == "status":
        print(json.dumps(status(a.slug), ensure_ascii=False, indent=1))
    elif a.cmd == "reopen":
        print(json.dumps(reopen(a.slug)))
    else:
        for w in listing():
            print(w["id"], "|", w["name"], "|", w["gmail"], "|", "standing" if w["standing"] else
                  ("answered" if w["answered"] else "waiting"))


if __name__ == "__main__":
    main()
