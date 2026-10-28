"""Promises the owner made and has not kept (2026-10-27: a Zen Mail counterpart of Claude Code's commitment check).

Claude Code's autonomous loop check re-reads the conversation on a timer and acts on the "I'll also..." / "next I'll..."
commitments it made and did not honor. Zen Mail had the reverse blind spot: when the owner wrote last, triage filed the
thread as waiting on the OTHER side, with no model call, even when his last words were "t'ho envio aquesta nit". The
ball was in his court and nothing said so (measured 2026-10-27: 22 promises in 90 days of WhatsApp direct chats, 2
chased by the other person after 2.1 and 5 days, both while the card sat in "waiting").

Two halves, as in the loop check:
  1. Find (triage.py): this shortlist picks threads whose owner tail holds a promise-like phrase; only those go to the
     model, which keeps a real, still-pending promise ({what, due, late_draft}) and drops the rest ("et passo la
     versió" with the file attached is a delivery, not a promise). Stored in topics.extra.promise.
  2. Break (check_due, every sync, no model): the day after "due", if the owner has not written in that thread since,
     the card comes back to his list once, with the holding reply as its draft. Nothing is ever sent.
"""
import datetime
import json
import re

from common import log, now_iso, settings
import owner

# A shortlist, not a judge: it over-matches on purpose ("et passo" also delivers) and the model decides.
PROMISE = re.compile(r"""(?ix)
 \b(i'?ll|i\s+will|i'?m\s+going\s+to|let\s+me\s+(check|see|look|get\s+back)|will\s+(send|get\s+back|check|confirm|share|call))\b
 | \b(tomorrow|tonight|later\s+today|by\s+(monday|tuesday|wednesday|thursday|friday|the\s+end\s+of))\b
 | \b(te|os|le|les|se)\s+(lo\s+|la\s+|los\s+|las\s+)?(env[ií]o|enviar[ée]|mando|mandar[ée]|paso|pasar[ée]|digo|dir[ée]|confirmo|confirmar[ée]|llamo|llamar[ée])\b
 | \b(lo|la|los|las)\s+(miro|reviso|preparo|mirar[ée]|revisar[ée])\b
 | \b(mañana|esta\s+noche|esta\s+tarde|en\s+cuanto\s+pueda|ahora\s+te|luego\s+te)\b
 | \b(revisar[ée]|enviar[ée]|preparar[ée]|llamar[ée]|mirar[ée]|contestar[ée])\b
 | \b(t'?ho|us\s+ho|li\s+ho|t'|et|us|li)\s*(envio|enviar[ée]|passo|passar[ée]|dic|dir[ée]|confirmo|confirmar[ée]|truco|trucar[ée])\b
 | \b(ho\s+miro|ho\s+reviso|ho\s+preparo|ho\s+mirar[ée])\b
 | \b(dem[àa]|aquesta\s+nit|aquesta\s+tarda|despr[ée]s\s+t)\b
 | \bhauria\s+de\s+tenir\s+temps\b
""")


def owner_tail(msgs, me):
    """The owner's own messages since the other side last wrote (msgs oldest first)."""
    tail = []
    for m in reversed(msgs):
        if m["from_addr"] != me:
            break
        tail.append(m)
    return tail[::-1]


def shortlist(msgs, me):
    """True when the owner wrote last and his last words look like a promise."""
    return any(PROMISE.search((m["body"] or "")[:1500]) for m in owner_tail(msgs, me))


def clean(p, made):
    """The model's "promise" field, checked: {what, due, made, late_draft} or None."""
    if not isinstance(p, dict) or not (p.get("what") or "").strip():
        return None
    try:
        due = datetime.date.fromisoformat(str(p.get("due") or "")[:10]).isoformat()
    except ValueError:
        return None
    draft = p.get("late_draft")
    return {"what": p["what"].strip()[:120], "due": due, "made": made,
            "late_draft": draft.strip() if isinstance(draft, str) and draft.strip() else None}


def store(conn, tid, p):
    """Write (or with None, drop) topics.extra.promise; the rest of extra (esc, pin) is kept."""
    row = conn.execute("SELECT extra FROM topics WHERE id=?", (tid,)).fetchone()
    if not row:
        return
    extra = json.loads(row["extra"] or "{}")
    old = extra.get("promise")
    if p is None:
        if old is None:
            return
        extra.pop("promise", None)
    else:
        if old and old.get("made") == p["made"] and old.get("broken"):
            p = dict(p, broken=old["broken"])  # the same promise re-triaged: it has already been raised once
        extra["promise"] = p
    conn.execute("UPDATE topics SET extra=? WHERE id=?", (json.dumps(extra, ensure_ascii=False), tid))


def check_due(conn, now_utc=None, dry=False):
    """The breaker. A promise whose day has passed, with no word from the owner since, puts its card back in his list
    once: state open, the holding reply as the draft when there is no draft yet. Returns how many came back."""
    now_utc = now_utc or datetime.datetime.now(datetime.timezone.utc)
    today = owner.focus(now_utc)["local"][:10]
    cfg = settings()
    back = 0
    for acct, spec in cfg["accounts"].items():
        me = (spec.get("address") or "").lower()
        rows = conn.execute("SELECT id, acct, conv, title, draft, extra FROM topics WHERE acct=? AND state IN"
                            " ('waiting','approved') AND extra LIKE '%\"promise\"%'", (acct,)).fetchall()
        for t in rows:
            extra = json.loads(t["extra"] or "{}")
            p = extra.get("promise") or {}
            if not p.get("due") or p.get("broken") or p["due"] >= today:
                continue
            last_mine = conn.execute("SELECT MAX(date) d FROM messages WHERE acct=? AND conv=? AND from_addr=?",
                                     (acct, t["conv"], me)).fetchone()["d"] or ""
            if last_mine > (p.get("made") or ""):
                store(conn, t["id"], None)  # he wrote again since: triage will judge the new words
                continue
            back += 1
            if dry:
                log(f"[promises] would raise: {t['title']} (promised {p['what']} by {p['due']})")
                continue
            p["broken"] = now_iso()
            extra["promise"] = p
            draft = t["draft"] or p.get("late_draft")
            conn.execute("UPDATE topics SET state='open', need=?, draft=?, extra=?, updated=? WHERE id=?",
                         ("reply" if draft else "act", draft, json.dumps(extra, ensure_ascii=False), now_iso(), t["id"]))
            log(f"[promises] {t['title']}: promised {p['what']} by {p['due']}, not done; back in the list")
    conn.commit()
    return back
