"""python3 test_triage.py — a re-triage never closes or empties a card the owner is working (2026-10-23).

At 20:32 the hourly sync re-read the ERP thread, the model rated it "read" with no draft, and triage overwrote the
draft the topic chat had written for the architect at 20:15 and closed the card because its mail was already read. He was
typing on it. A card with an owner message in its chat keeps its draft and stays open; an untouched one still closes.
"""
import json, os, sys, tempfile
os.environ["ZEN_MAIL_DATA"] = tempfile.mkdtemp(prefix="zen-triage-test-")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
common.log = lambda *a: None
import triage
triage.log = common.log

conn = common.db()
for conv in ("worked", "untouched"):
    conn.execute("INSERT INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread, body)"
                 " VALUES(?,?,?,?,?,?,?,?,?,?,?)", (conv + "-1", "work", conv, "inbox", "Zen", "z@x.es", "[]",
                 "ERP", "2026-10-23T10:15:00Z", 0, "I need access by Tuesday."))
    tid = common.topic_id("work", conv)
    conn.execute("INSERT INTO topics(id, acct, conv, title, need, state, draft) VALUES(?,?,?,?,?,?,?)",
                 (tid, "work", conv, "ERP", "reply", "open", "MY DRAFT"))
conn.execute("INSERT INTO chat(topic, ts, who, text) VALUES(?,?,?,?)",
             (common.topic_id("work", "worked"), "2026-10-23T18:14:52+00:00", "me", "insist on my ERP access"))
conn.commit()


def fake_model(prompt, system, *a, **k):
    ids = [x["id"] for x in json.loads(prompt[prompt.index("["):prompt.rindex("]") + 1])]
    return json.dumps([{"id": i, "need": "read", "title": "ERP", "draft": None} for i in ids])


triage.ask_model = fake_model
triage.triage(conn, "work", "o@x.es", common.settings(), "")
got = {c: conn.execute("SELECT state, draft FROM topics WHERE id=?", (common.topic_id("work", c),)).fetchone()
       for c in ("worked", "untouched")}
assert tuple(got["worked"]) == ("open", "MY DRAFT"), tuple(got["worked"])
assert got["untouched"][0] == "done", tuple(got["untouched"])
print("ok: a card the owner talked on keeps its draft and stays open; an untouched read card still closes")
