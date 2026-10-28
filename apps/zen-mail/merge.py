"""One matter, one topic (2026-10-19: one matter showed up as two separate topics; the point of Zen Mail is to
aggregate context from different sources and email threads into one).

Outlook and Gmail start a new conversation for a resend, a forward or a reply written as a new mail, so one matter can
arrive as several threads. Two rules join them:
  1. same subject once the RE:/FW:/Undeliverable: prefixes are gone (detect, here, every run);
  2. the model says two threads that share a person are the same matter (triage.py, "same_as").
A merge is stored in `merges` and never deletes anything: each run the sources write the mailbox's own conversation
id again, and apply() points those mails back at the lead thread before triage, so the pane, the attachments, the
butler, archiving and triage all see one thread. The member's topic is kept with state 'merged'; its chat moves over.
"""
import json
import re

from common import log, now_iso, source_of, topic_id

# One prefix at a time, repeated: "RE: RV: Undeliverable: Fuga d'aigua…" → "Fuga d'aigua…".
PREFIX = re.compile(
    r"^\s*(?:(?:re|fw|fwd|rv|res|tr|enc|aw|wg|回复|答复|转发)\s*(?:\[\d+\])?\s*[:：]|"
    r"(?:undeliverable|undelivered mail returned to sender|delivery status notification(?: \(failure\))?|"
    r"no se puede entregar|no entregado|automatic reply|respuesta automática|resposta automàtica|"
    r"accepted|declined|tentative|aceptado|rechazado|acceptat|rebutjat)\s*[:：])\s*", re.I)


def norm_subject(subject):
    """The subject without reply/forward/bounce prefixes, or "" when what is left is too short to name one matter
    ("Factura", "Hola" would join unrelated threads)."""
    s = subject or ""
    while True:
        n = PREFIX.sub("", s, count=1)
        if n == s:
            break
        s = n
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s if len(s) >= 15 and len(s.split()) >= 3 else ""


def _ensure(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS merges(acct TEXT, conv TEXT, lead TEXT, why TEXT, at TEXT,"
                 " PRIMARY KEY(acct, conv))")
    # A pair split by unmerge() never joins again, by either rule.
    conn.execute("CREATE TABLE IF NOT EXISTS merge_blocks(acct TEXT, a TEXT, b TEXT, at TEXT, PRIMARY KEY(acct, a, b))")
    # Each moved mail keeps its own thread id, so a merge can always be taken back.
    if "orig_conv" not in {r[1] for r in conn.execute("PRAGMA table_info(messages)")}:
        conn.execute("ALTER TABLE messages ADD COLUMN orig_conv TEXT")


def lead_of(conn, acct, conv):
    _ensure(conn)
    r = conn.execute("SELECT lead FROM merges WHERE acct=? AND conv=?", (acct, conv)).fetchone()
    return r["lead"] if r else conv


def merge(conn, acct, member, lead, why):
    """Join `member` into `lead`. Returns False when they already are one."""
    _ensure(conn)
    member, lead = lead_of(conn, acct, member), lead_of(conn, acct, lead)
    if member == lead or conn.execute("SELECT 1 FROM merge_blocks WHERE acct=? AND ((a=? AND b=?) OR (a=? AND b=?))",
                                      (acct, member, lead, lead, member)).fetchone():
        return False
    conn.execute("INSERT OR REPLACE INTO merges(acct, conv, lead, why, at) VALUES(?,?,?,?,?)",
                 (acct, member, lead, why, now_iso()))
    conn.execute("UPDATE merges SET lead=? WHERE acct=? AND lead=?", (lead, acct, member))  # its own members follow
    mt, lt = topic_id(acct, member), topic_id(acct, lead)
    conn.execute("UPDATE chat SET topic=? WHERE topic=?", (lt, mt))
    old = conn.execute("SELECT extra FROM topics WHERE id=?", (mt,)).fetchone()
    if old:
        extra = json.loads(old["extra"] or "{}")
        extra["merged_into"] = lt
        conn.execute("UPDATE topics SET state='merged', extra=? WHERE id=?", (json.dumps(extra, ensure_ascii=False), mt))
    log(f"[merge] {acct}: {member[-12:]} joined {lead[-12:]} ({why})")
    return True


def apply(conn, acct):
    """Point every merged thread's mails at its lead. Run after the sources and before triage."""
    _ensure(conn)
    for r in conn.execute("SELECT conv, lead FROM merges WHERE acct=?", (acct,)).fetchall():
        conn.execute("UPDATE messages SET orig_conv=COALESCE(orig_conv, conv), conv=? WHERE acct=? AND conv=?",
                     (r["lead"], acct, r["conv"]))
    conn.commit()


def unmerge(conn, acct, member):
    """Take `member` back out of its lead: its mails return to their own thread, its topic opens again and is triaged
    afresh, the lead is triaged again without it, and the pair is blocked from joining again."""
    _ensure(conn)
    r = conn.execute("SELECT lead FROM merges WHERE acct=? AND conv=?", (acct, member)).fetchone()
    if not r:
        return False
    lead = r["lead"]
    conn.execute("DELETE FROM merges WHERE acct=? AND conv=?", (acct, member))
    conn.execute("INSERT OR REPLACE INTO merge_blocks(acct, a, b, at) VALUES(?,?,?,?)", (acct, member, lead, now_iso()))
    conn.execute("UPDATE messages SET conv=orig_conv, orig_conv=NULL WHERE acct=? AND orig_conv=?", (acct, member))
    for c in (member, lead):  # sig '' = triage both again on the next run
        conn.execute("UPDATE topics SET sig='' WHERE id=?", (topic_id(acct, c),))
    t = conn.execute("SELECT extra FROM topics WHERE id=?", (topic_id(acct, member),)).fetchone()
    if t:
        extra = json.loads(t["extra"] or "{}")
        extra.pop("merged_into", None)
        conn.execute("UPDATE topics SET state='open', extra=? WHERE id=?",
                     (json.dumps(extra, ensure_ascii=False), topic_id(acct, member)))
    log(f"[merge] {acct}: {member[-12:]} split from {lead[-12:]}")
    return True


# Bounce and delivery notices are nobody: a thread holding only these and the owner joins on subject alone.
SYSTEM_SENDER = re.compile(r"mailer-daemon|postmaster|microsoftexchange[0-9a-f]*@|bounce", re.I)


def detect(conn, acct, me):
    """Rule 1: mail threads that share a subject (prefixes stripped) are one matter, when they also share a person on
    the other side, or one of them has nobody but the owner and bounce notices (a resend after a bounce). The person
    test keeps apart the candidates who all answer one job ad under its subject. The lead is the thread with the
    newest mail, so the topic already worked in keeps its chat and its place. Noise and private (CV) topics stay out."""
    _ensure(conn)
    skip = {r["conv"] for r in conn.execute("SELECT conv FROM topics WHERE acct=? AND (noise=1 OR private=1)", (acct,))}
    keys, newest, people = {}, {}, {}
    for r in conn.execute("SELECT conv, subject, date, from_addr FROM messages WHERE acct=?", (acct,)):
        c = lead_of(conn, acct, r["conv"])
        if source_of(c) != "email" or c in skip or r["conv"] in skip:
            continue
        newest[c] = max(newest.get(c, ""), r["date"] or "")
        addr = (r["from_addr"] or "").lower()
        if addr and addr != me and not SYSTEM_SENDER.search(addr):
            people.setdefault(c, set()).add(addr)
        k = norm_subject(r["subject"])
        if k:
            keys.setdefault(k, set()).add(c)
    n = 0
    for k, convs in keys.items():
        convs = {lead_of(conn, acct, c) for c in convs}
        if len(convs) < 2:
            continue
        lead = max(convs, key=lambda c: newest.get(c, ""))
        for c in sorted(convs - {lead}):
            a, b = people.get(c, set()), people.get(lead, set())
            if a and b and not (a & b):
                continue  # different people under one subject (job-ad replies): not one matter
            n += merge(conn, acct, c, lead, "same subject: " + k[:60])
    conn.commit()
    return n
