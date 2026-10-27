"""python3 test_merge.py — the merge rules on a throwaway database (2026-10-19)."""
import os, sys, tempfile
os.environ["ZEN_MAIL_DATA"] = tempfile.mkdtemp(prefix="zen-merge-test-")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import db, source_of
import merge

ME = "owner@example.com"
assert merge.norm_subject("RE: RV: Undeliverable: Fuga d'aigua a casa (Townsville)") == "fuga d'aigua a casa (townsville)"
assert merge.norm_subject("回复：Custom thin-film pressure array, hi") == "custom thin-film pressure array, hi"
assert merge.norm_subject("Factura") == ""
assert source_of("jarvis:reminder-esta-usa") != "email"  # cards never go to Outlook (7b74617b9bc)

conn = db()
conn.execute("CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, acct TEXT, conv TEXT, box TEXT, from_name TEXT,"
             " from_addr TEXT, rcpts TEXT, subject TEXT, date TEXT, unread INT, body TEXT, has_att INT, link TEXT, labels TEXT)")
conn.execute("CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY, acct TEXT, conv TEXT, title TEXT, state TEXT, noise INT DEFAULT 0,"
             " private INT DEFAULT 0, extra TEXT, sig TEXT)")
conn.execute("CREATE TABLE IF NOT EXISTS chat(topic TEXT, who TEXT, text TEXT)")
def mail(i, conv, addr, subj, date):
    conn.execute("INSERT INTO messages(id, acct, conv, from_addr, subject, date) VALUES(?,?,?,?,?,?)", (i, "work", conv, addr, subj, date))
# Lena: first send bounced, resend answered by Lena in a new conversation -> one matter
mail("a1", "LEAK1", ME, "Fuga d'aigua a casa (Townsville) - pòlissa", "2026-10-01")
mail("a2", "LEAK1", "microsoftexchange329e@example.com", "Undeliverable: Fuga d'aigua a casa (Townsville) - pòlissa", "2026-10-02")
mail("b1", "LEAK2", ME, "Fuga d'aigua a casa (Townsville) - pòlissa", "2026-10-09")
mail("b2", "LEAK2", "adjuster@example.com", "RE: Fuga d'aigua a casa (Townsville) - pòlissa", "2026-10-13")
# two candidates answering one job ad -> two matters
mail("c1", "CAND1", "candidate1@example.com", "Programador de Sistemas y Robótica Móvil", "2026-10-05")
mail("d1", "CAND2", "candidate2@example.com", "RE: Programador de Sistemas y Robótica Móvil", "2026-10-06")
merge.detect(conn, "work", ME)
assert merge.lead_of(conn, "work", "LEAK1") == "LEAK2", "bounce + resend must join"
assert merge.lead_of(conn, "work", "CAND1") == "CAND1" and merge.lead_of(conn, "work", "CAND2") == "CAND2", "candidates must stay apart"
merge.apply(conn, "work")
assert conn.execute("SELECT COUNT(*) FROM messages WHERE conv='LEAK2'").fetchone()[0] == 4
assert merge.unmerge(conn, "work", "LEAK1")
assert conn.execute("SELECT COUNT(*) FROM messages WHERE conv='LEAK1'").fetchone()[0] == 2, "unmerge restores the thread"
merge.detect(conn, "work", ME)
assert merge.lead_of(conn, "work", "LEAK1") == "LEAK1", "a split pair never joins again"
print("merge tests: ok")
