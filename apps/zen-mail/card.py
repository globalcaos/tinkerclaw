#!/usr/bin/env python3
"""One call to inspect or stock a Zen Mail card (2026-10-27: updating Lena's claim card took 17 probes of zen.db).

Usage:
  python3 -I card.py show <words in the title or sender>   # card, its messages, butler needs/notes, folder, attach list
  python3 -I card.py attach <topic id> <file>...           # copy files into <folder>/attach and list them on the card
A send attaches exactly the latest butler row's `files`, read from <folder>/attach (server._write_draft); this keeps
both in step. Draft text: card_reply.py."""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import db  # noqa: E402


def show(words):
    conn = db()
    like = "%" + words + "%"
    for t in conn.execute("SELECT * FROM topics WHERE title LIKE ? OR who LIKE ? OR sender LIKE ? ORDER BY last_date DESC",
                          (like, like, like)):
        print(f"== {t['id']}  [{t['state']}]  {t['title']}\n   need: {t['need']}  summary: {t['summary']}")
        for m in conn.execute("SELECT date, from_addr, body FROM messages WHERE conv=? AND acct=? ORDER BY date",
                              (t["conv"], t["acct"])):
            print(f"   {m['date'][:16]} {m['from_addr']}: {(m['body'] or '').strip()[:400]!r}")
        b = conn.execute("SELECT * FROM butler WHERE topic=? ORDER BY ts DESC LIMIT 1", (t["id"],)).fetchone()
        if b:
            print(f"   folder: {b['folder']}\n   files: {b['files']}\n   needs: {b['needs']}\n   note: {b['note']}")
            att = os.path.join(b["folder"] or "", "attach")
            print(f"   attach/: {sorted(os.listdir(att)) if os.path.isdir(att) else 'none'}")
        print(f"   draft: {t['draft']!r}\n")


def attach(topic, paths):
    conn = db()
    b = conn.execute("SELECT ts, folder, files FROM butler WHERE topic=? ORDER BY ts DESC LIMIT 1", (topic,)).fetchone()
    if not b or not b["folder"]:
        sys.exit(f"{topic} has no butler folder")
    dest = os.path.join(b["folder"], "attach")
    os.makedirs(dest, exist_ok=True)
    for p in paths:
        shutil.copy2(p, dest)
    files = sorted(os.listdir(dest))
    conn.execute("UPDATE butler SET files=? WHERE topic=? AND ts=?", (json.dumps(files, ensure_ascii=False), topic, b["ts"]))
    conn.commit()
    size = sum(os.path.getsize(os.path.join(dest, f)) for f in files) / 1e6
    print(f"{topic}: {len(files)} files, {size:.1f} MB in {dest}")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "show":
        show(" ".join(sys.argv[2:]))
    elif len(sys.argv) >= 4 and sys.argv[1] == "attach":
        attach(sys.argv[2], sys.argv[3:])
    else:
        sys.exit(__doc__)
