"""Pin a reminder card the architect asks for in chat (2026-10-18). One command instead of a hand-written insert.

    python3 remind.py <slug> <pin> "<title>" "<body>" [--link URL] [--link-label TEXT] [--acct work|personal]

Sender is `reminder`, so the dams' two-day expiry (sender `jarvis`) never closes it; only "Fet" does.
Restart is not needed: /api/state reads the table on every call."""
import argparse
import json
import sys

from common import db, now_iso, topic_id

p = argparse.ArgumentParser()
p.add_argument("slug"); p.add_argument("pin", type=int); p.add_argument("title"); p.add_argument("body")
p.add_argument("--link", default=""); p.add_argument("--link-label", default="Obre")
p.add_argument("--acct", default="work")
a = p.parse_args()
conn, stamp, conv = db(), now_iso(), "jarvis:reminder-" + a.slug
acts = ([{"k": "open", "label": a.link_label}] if a.link else []) + [{"k": "done", "label": "Fet"}, {"k": "later", "label": "Ara no"}]
conn.execute("INSERT OR REPLACE INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread, body,"
             " has_att, link, labels) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
             (f"{conv}@{a.acct}", a.acct, conv, "inbox", "Recordatori", "reminder", "[]", a.title, stamp, 1, a.body, 0, a.link, "[]"))
conn.execute("INSERT OR REPLACE INTO topics(id, acct, conv, title, who, sender, need, urgency, importance, summary, facts,"
             " draft, state, noise, private, last_date, sig, updated, extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,'open',0,0,?,?,?,?)",
             (topic_id(a.acct, conv), a.acct, conv, a.title, "Recordatori", "reminder", "act", 2, 2, a.body, "[]", stamp,
              "reminder", stamp, json.dumps({"stream": "reminder", "pin": a.pin, "link": a.link, "actions": acts}, ensure_ascii=False)))
conn.commit()
print(json.dumps({"ok": True, "conv": conv, "pin": a.pin}))
