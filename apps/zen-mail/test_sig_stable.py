"""python3 test_sig_stable.py — a thread is triaged again only when something real changed (2026-10-27).

Two mail threads from the same person list each other as "maybe the same matter", with their titles. Every triage
rewrites titles, and the titles were part of each other's signature, so the pair re-triaged each other on every sync:
28 work threads re-read by the model every 15 minutes for nothing. A second run with no new mail must triage none.
"""
import itertools, json, os, sys, tempfile
os.environ["ZEN_MAIL_DATA"] = tempfile.mkdtemp(prefix="zen-sig-test-")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
assert str(sys.modules["common"].DATA).startswith(tempfile.gettempdir()), "refusing to run against " + str(sys.modules["common"].DATA)  # 2026-10-27: a test run on an already-loaded common rewrote 58 real cards
common.log = lambda *a: None
import triage
triage.log = common.log

conn = common.db()
for conv, subj in (("order-1", "Order 1"), ("order-2", "Order 2")):
    conn.execute("INSERT INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread, body)"
                 " VALUES(?,?,?,?,?,?,?,?,?,?,?)", (conv, "work", conv, "inbox", "Ana Puig", "ana@sup.es", "[]",
                 subj, "2026-10-27T10:00:00Z", 1, "Can you confirm the delivery date?"))
conn.commit()
counter = itertools.count()


def fake_model(prompt, system, *a, **k):
    ids = [x["id"] for x in json.loads(prompt[prompt.index("["):prompt.rindex("]") + 1])]
    n = next(counter)  # a new title AND a flip between "reply" and "none" (noise) on every call: model answers vary
    return json.dumps([{"id": i, "need": "reply" if n % 2 else "none", "title": f"Ana asks for a date ({n})", "draft": "Hola"}
                       for i in ids])


triage.ask_model = fake_model
# The signature reads mail only, so with no new mail nothing is triaged again, whatever the model answered.
runs = [triage.triage(conn, "work", "o@x.es", common.settings(), "") for _ in range(3)]
assert runs == [2, 0, 0], f"re-triaged threads with no new mail (runs: {runs})"
print("ok: new titles alone do not make a thread look new")
