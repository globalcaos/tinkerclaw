"""python3 test_promises.py — a promise the owner made comes back when its day passes (2026-10-27).

Jane Doe, the architect, asked for a revised document; the architect answered "Entre avui i demà hauria de tenir temps"
and the card went to "waiting", as if the ball were in the architect's court. Five days later the architect had to
ask "ja ho tens?". Now the owner's "I'll ..." goes to the model, a real promise is kept with its day, and the day
after it the card comes back to his list once, with a holding reply as the draft. Nothing is sent.
"""
import datetime, json, os, sys, tempfile
data = tempfile.mkdtemp(prefix="zen-promise-test-")
os.environ["ZEN_MAIL_DATA"] = data
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common
assert str(sys.modules["common"].DATA).startswith(tempfile.gettempdir()), "refusing to run against " + str(sys.modules["common"].DATA)  # 2026-10-27: a test run on an already-loaded common rewrote 58 real cards
common.log = lambda *a: None
cfg = dict(common.DEFAULT_SETTINGS)
cfg["accounts"] = {"personal": {"kind": "gmail", "label": "Personal", "address": "o@x.es", "sources": []}}
cfg["tz"], cfg["away"] = "Europe/Madrid", []
open(os.path.join(data, "settings.json"), "w").write(json.dumps(cfg))
import promises, triage
promises.log = triage.log = common.log

# 1. The shortlist over-matches on purpose; the model decides.
for said in ("T'ho envio aquesta nit", "Entre avui i demà hauria de tenir temps per revisar-ho",
             "Te lo envío mañana", "I'll send it tonight", "Ho reviso i et dic"):
    assert promises.PROMISE.search(said), said
for said in ("Ok, gràcies", "Perfecte!", "Thanks, got it", "Hola, bon dia"):
    assert not promises.PROMISE.search(said), said

conn = common.db()
now = datetime.datetime.now(datetime.timezone.utc)
iso = lambda d: d.isoformat(timespec="seconds")


def thread(conv, lines, start=0):
    for i, (who, text, hours_ago) in enumerate(lines, start):
        mine = who == "me"
        conn.execute("INSERT INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread, body)"
                     " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     (f"{conv}-{i}", "personal", conv, "inbox", "the architect" if mine else "Jane", "o@x.es" if mine else "wa:jane",
                      "[]", "WhatsApp chat with Jane", iso(now - datetime.timedelta(hours=hours_ago)), 0, text))
    conn.commit()


thread("wa:promise", [("jane", "Ja ho tens?", 30), ("me", "Ui, tens raó. T'ho envio aquesta nit", 29)])
thread("wa:delivered", [("jane", "Em passes la versió?", 30), ("me", "Et passo la versió nova, aquí la tens", 29)])
thread("wa:plain", [("jane", "Ens veiem dijous?", 30), ("me", "Perfecte, fins dijous", 29)])
sent = []
yesterday = (now - datetime.timedelta(days=1)).date().isoformat()


def fake_model(prompt, system, *a, **k):
    items = json.loads(prompt[prompt.index("["):prompt.rindex("]") + 1])
    sent.extend(items)
    out = []
    for it in items:
        promise = None  # like the model: owed while his last word is the promise, settled once he delivers
        delivered = "Aquí el tens" in it["messages"][-1]["text"]
        if it["id"] == common.topic_id("personal", "wa:promise") and not delivered:
            promise = {"what": "enviar el document revisat", "due": yesterday,
                       "late_draft": "Perdona el retard, t'ho envio de seguida."}
        out.append({"id": it["id"], "title": "El document per a l'arquitecte", "who": "Jane", "need": "none",
                    "summary": "s", "draft": None, "promise": promise})
    return json.dumps(out)


triage.ask_model = fake_model
triage.triage(conn, "personal", "o@x.es", common.settings(), "")
tid = {c: common.topic_id("personal", c) for c in ("wa:promise", "wa:delivered", "wa:plain")}
checked = {x["id"] for x in sent if x.get("owner_promise_check")}
assert checked == {tid["wa:promise"], tid["wa:delivered"]}, checked  # "Perfecte, fins dijous" never reaches the model


def topic(c):
    t = conn.execute("SELECT state, need, draft, extra FROM topics WHERE id=?", (tid[c],)).fetchone()
    return t["state"], t["need"], t["draft"], json.loads(t["extra"] or "{}").get("promise")


state, need, draft, p = topic("wa:promise")
assert (state, need) == ("waiting", "act") and p["what"] == "enviar el document revisat" and not p.get("broken"), topic("wa:promise")
assert topic("wa:delivered")[:2] == ("waiting", "none") and topic("wa:delivered")[3] is None, topic("wa:delivered")  # a delivery
assert topic("wa:plain")[:2] == ("waiting", "none") and topic("wa:plain")[3] is None, topic("wa:plain")

# 2. Its day has passed with no word since: back in the list, once, with the holding reply. Nothing is sent.
assert promises.check_due(conn) == 1
state, need, draft, p = topic("wa:promise")
assert (state, need, draft) == ("open", "reply", "Perdona el retard, t'ho envio de seguida."), topic("wa:promise")
assert p.get("broken"), p
conn.execute("UPDATE topics SET state='waiting' WHERE id=?", (tid["wa:promise"],)); conn.commit()
assert promises.check_due(conn) == 0  # raised once; "Ara no" or Fet is the owner's answer

# 3. He writes again with no new promise: whatever he owed is settled.
thread("wa:promise", [("me", "Aquí el tens, el document revisat", 1)], start=5)
triage.triage(conn, "personal", "o@x.es", common.settings(), "")
assert topic("wa:promise")[3] is None, topic("wa:promise")
print("ok: a promise is judged by the model, comes back once the day after it was due, and clears when he writes again")
