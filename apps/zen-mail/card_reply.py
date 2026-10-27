#!/usr/bin/env python3
"""Write the main chat's answer back onto a Zen Mail card (the other half of server.chat's hand-off, 2026-10-23).

Usage: python3 -I card_reply.py <topic id> --text-file <file> [--draft-file <file>]
The text becomes a Jarvis line in the card's chat; a draft file replaces the card's reply (marked "Reply updated").
Files, not arguments, so quotes and new lines in a Catalan or Spanish reply survive the shell."""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import db, now_iso  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("topic")
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--draft-file")
    a = ap.parse_args()
    text = open(a.text_file, encoding="utf-8").read().strip()
    draft = open(a.draft_file, encoding="utf-8").read().strip() if a.draft_file else ""
    conn = db()
    if not conn.execute("SELECT 1 FROM topics WHERE id=?", (a.topic,)).fetchone():
        sys.exit(f"unknown topic {a.topic}")
    if draft:
        conn.execute("UPDATE topics SET draft=?, state=CASE WHEN state IN ('done','approved') THEN 'open' ELSE state END"
                     " WHERE id=?", (draft, a.topic))
    conn.execute("INSERT INTO chat(topic, ts, who, text, changed) VALUES(?,?,?,?,?)",
                 (a.topic, now_iso(), "jarvis", text, 1 if draft else 0))
    conn.commit()
    print(f"written to {a.topic}: {len(text)} chars" + (f", draft {len(draft)} chars" if draft else ""))


if __name__ == "__main__":
    main()
