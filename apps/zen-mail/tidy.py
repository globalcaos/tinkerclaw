"""Keep the mailbox's inbox equal to Today: whatever leaves Today is archived, never deleted.

Every move is logged to archived.jsonl (old id, new id, account, when), so any of it can be put back.
A new message in an archived thread lands in the inbox again and the topic reopens on the next sync.
"""
import datetime
import json

from common import DATA, db, gog, in_today, log, now_iso, outlook, settings, source_of


def _log_moves(rows):
    with open(DATA / "archived.jsonl", "a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def _each(call, ids, gone_ids=None):
    """One Outlook call for all ids; when one id is stale (Outlook gives a moved mail a new id, ErrorItemNotFound),
    redo it id by id and skip the ones Outlook no longer has, instead of failing the whole action (2026-10-19 19:19:
    Approve wrote the draft, then the archive step failed and the page said Approve did not work)."""
    try:
        return call(*ids)
    except RuntimeError as err:
        if "ErrorItemNotFound" not in str(err):
            raise
    out, gone = [], 0
    for i in ids:
        try:
            r = call(i)
            out += r if isinstance(r, list) else []
        except RuntimeError as err:
            if "ErrorItemNotFound" not in str(err):
                raise
            gone += 1
            if gone_ids is not None:
                gone_ids.append(i)
    log(f"[tidy] {gone} of {len(ids)} mails were no longer where Outlook had them; skipped")
    return out


def archive_conv(conn, acct, conv, mark_read=False):
    """Move one thread's inbox messages to Archive (Outlook) or drop the INBOX label (Gmail)."""
    kind = settings()["accounts"][acct]["kind"]
    msgs = conn.execute("SELECT id, unread FROM messages WHERE acct=? AND conv=? AND box='inbox'", (acct, conv)).fetchall()
    if not msgs:
        return 0
    if source_of(conv) != "email":
        # Jira, Teams and WhatsApp items (2026-10-15) have no mailbox to archive in: only the local copy leaves Today.
        conn.execute("UPDATE messages SET unread=CASE WHEN ? THEN 0 ELSE unread END WHERE acct=? AND conv=?",
                     (1 if mark_read else 0, acct, conv))
        conn.commit()
        return 0
    if kind == "outlook":
        ids = [m["id"] for m in msgs]
        gone = []
        if mark_read:
            unread = [m["id"] for m in msgs if m["unread"]]
            if unread:
                _each(lambda *x: outlook("mail", "mark-read", *x), unread, gone)
        moved = _each(lambda *x: outlook("mail", "archive", *x, timeout=300), [i for i in ids if i not in gone], gone) or []
        for i in set(gone):  # Outlook no longer has this id: never send it again (the pane still shows the mail)
            conn.execute("UPDATE messages SET box='gone' WHERE id=?", (i,))
        for mv in moved:
            conn.execute("UPDATE messages SET id=?, box='archived', unread=CASE WHEN ? THEN 0 ELSE unread END WHERE id=?",
                         (mv["newId"], 1 if mark_read else 0, mv["id"]))
            conn.execute("UPDATE topics SET reply_to=? WHERE reply_to=?", (mv["newId"], mv["id"]))
        _log_moves([{"acct": acct, "id": mv["id"], "new_id": mv["newId"], "at": now_iso()} for mv in moved])
    else:
        gog("gmail", "thread", "modify", conv, "--remove", "INBOX,UNREAD" if mark_read else "INBOX")
        conn.execute("UPDATE messages SET box='archived', unread=CASE WHEN ? THEN 0 ELSE unread END WHERE acct=? AND conv=? AND box='inbox'",
                     (1 if mark_read else 0, acct, conv))
        _log_moves([{"acct": acct, "thread": conv, "at": now_iso()}])
    conn.commit()
    return len(msgs)


def tidy_inbox(conn, acct):
    """Archive the inbox mail of every topic Today does not show (handled, waiting, set aside, already read)."""
    now = datetime.datetime.now(datetime.timezone.utc)
    unread = {r["conv"]: r["n"] for r in conn.execute("SELECT conv, SUM(unread) n FROM messages WHERE acct=? GROUP BY conv", (acct,))}
    moved = 0
    for t in conn.execute("SELECT * FROM topics WHERE acct=?", (acct,)).fetchall():
        if t["state"] == "later" or in_today(t, now, unread):
            continue  # still on the list, or only put off: it stays in the inbox
        try:
            moved += archive_conv(conn, acct, t["conv"])
        except Exception as err:  # one thread must not stop the tidy
            log(f"[tidy] {acct}: could not archive {t['id']}: {err}")
    log(f"[tidy] {acct}: {moved} messages archived")
    return moved


if __name__ == "__main__":
    conn = db()
    for acct in settings()["accounts"]:
        tidy_inbox(conn, acct)
