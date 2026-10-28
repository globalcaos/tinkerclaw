"""python3 test_wa_names.py — a WhatsApp contact shows under the owner's phone-book name (2026-10-27).

the architect: "Who the fuck is jdthinking by the way??? You have access to my contact list in the phone". Cards named the
architect by the profile name he typed on WhatsApp. The phone book (people database) and WhatsApp's own lid -> number
table now name him; a contact the phone book lacks keeps the profile name, and missing files change nothing.
"""
import json, os, sqlite3, sys, tempfile
tmp = tempfile.mkdtemp(prefix="zen-wa-names-")
os.environ["ZEN_MAIL_DATA"] = tmp
os.environ["ZEN_MAIL_PEOPLE_ALIASES"] = os.path.join(tmp, "_aliases.json")
os.environ["ZEN_MAIL_WA_STORE"] = os.path.join(tmp, "whatsmeow.db")
os.environ["ZEN_MAIL_WHATSAPP_DB"] = os.path.join(tmp, "history.db")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common, sources
assert str(sys.modules["common"].DATA).startswith(tempfile.gettempdir()), "refusing to run against " + str(sys.modules["common"].DATA)  # 2026-10-27: a test run on an already-loaded common rewrote 58 real cards

# Missing files: no names, no error.
assert sources._phonebook_names() == {}

json.dump({
    "jane": {"displayName": "Jane Doe Architect", "phones": ["+34600000009"], "lids": []},
    "anna": {"displayName": "Anna", "phones": ["+34600000001"], "lids": ["111:3@lid"]},
    "num": {"displayName": "+34 600 000 002", "phones": ["+34600000002"], "lids": []},
}, open(os.environ["ZEN_MAIL_PEOPLE_ALIASES"], "w"))
s = sqlite3.connect(os.environ["ZEN_MAIL_WA_STORE"])
s.execute("CREATE TABLE whatsmeow_lid_map(lid TEXT, pn TEXT)")
s.execute("INSERT INTO whatsmeow_lid_map VALUES('10000000000099', '34600000009')")
s.commit(); s.close()

book = sources._phonebook_names()
assert book["10000000000099@lid"] == "Jane Doe Architect", book  # lid -> number -> phone book
assert book["34600000009@s.whatsapp.net"] == "Jane Doe Architect", book
assert book["111@lid"] == "Anna", book  # a stored lid, device suffix dropped
assert "34600000002@s.whatsapp.net" not in book, book  # a bare number is no name
assert sources._bare_jid("10000000000099:26@lid") == "10000000000099@lid"

# End to end: the archive says "jdthinking"; the card says Jane Doe Architect.
h = sqlite3.connect(os.environ["ZEN_MAIL_WHATSAPP_DB"])
h.execute("CREATE TABLE messages(id TEXT, chat_jid TEXT, chat_name TEXT, sender_jid TEXT, sender_name TEXT,"
          " sender_pushname TEXT, from_me INT, timestamp INT, message_type TEXT, text_content TEXT, caption TEXT)")
import time
now = int(time.time())
h.execute("INSERT INTO messages VALUES('m1','10000000000099@lid','jdthinking','10000000000099:26@lid','',"
          "'jdthinking',0,?,'text','Com ho fem?','')", (now - 60,))
h.execute("INSERT INTO messages VALUES('m2','999@lid','Stranger','999@lid','','Stranger',0,?,'text','hola','')", (now - 60,))
h.commit(); h.close()
sources.WHATSAPP_DB = os.environ["ZEN_MAIL_WHATSAPP_DB"]
conn = common.db()
sources.fetch_whatsapp(conn, "personal", 7, "me@x")
rows = {r["id"]: r for r in conn.execute("SELECT id, from_name, subject FROM messages")}
assert rows["wa:m1"]["from_name"] == "Jane Doe Architect", dict(rows["wa:m1"])
assert rows["wa:m1"]["subject"] == "WhatsApp chat with Jane Doe Architect", dict(rows["wa:m1"])
assert rows["wa:m2"]["from_name"] == "Stranger", dict(rows["wa:m2"])  # not in the phone book: profile name stays
print("ok: WhatsApp senders show their phone-book name; unknown ones keep their profile name")
