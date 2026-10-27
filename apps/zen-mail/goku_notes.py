#!/usr/bin/env python3
"""Search Goku's chats on the OrbisVision server, read only. SV2 testers report defects and results to Goku in their
Goku chat (sv2/docs/books/usecases/src/test-sheet.md, section 1), so this is where SV2 test evidence lives.

Usage: python3 -I goku_notes.py "<word>" ["<word>" ...] [--days 30] [--max 40]
Prints one line per message (what a colleague typed, or Goku's visible reply) holding every word, newest first.
Added 2026-10-22 (the architect: "The SV2 tests should be in the git and in the OrbisVision server, which you can use to get
more data")."""
import argparse
import json
import shlex
import subprocess
import sys

REMOTE = r'''
import json, os, re, sys, time, glob
words, days, cap = json.loads(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
cut = time.time() - days * 86400
# Goku runs on the Claude Code bridge: its real conversations are these transcripts, not ~/.openclaw/agents/*/sessions
# (that store held no tester message on 2026-10-22; these held 163 of 287 chats mentioning SV2).
files = [f for f in glob.glob(os.path.expanduser("~/.claude/projects/-home-administrador--openclaw-workspace/*.jsonl"))
         if os.path.getmtime(f) >= cut]
STAMP = re.compile(r"\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d\d-\d\d \d\d:\d\d[^\]]*\] (.*)", re.S)
hits, seen = [], set()
for f in sorted(files, key=os.path.getmtime, reverse=True):
    for line in open(f, errors="replace"):
        if '"type":"user"' not in line and '"type":"assistant"' not in line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        c = (o.get("message") or {}).get("content")
        text = c if isinstance(c, str) else " ".join(p.get("text", "") for p in c or [] if isinstance(p, dict) and p.get("type") == "text")
        if o.get("type") == "user":
            m = STAMP.search(text)
            if not m:
                continue  # tool results and system blocks, not what the person typed
            text = re.split(r"\n---\n\n\*\*After your reply|<!-- TINKERCLAW", m.group(1))[0]
        text = " ".join(text.split())
        low = text.lower()
        if text and text not in seen and all(w in low for w in words):
            seen.add(text)
            hits.append((o.get("timestamp", "")[:16], "colleague" if o["type"] == "user" else "Goku", text))
    if len(hits) >= cap * 3:
        break
hits.sort(key=lambda h: h[0], reverse=True)
for ts, who, text in hits[:cap]:
    print(f"{ts} | {who} | {text[:900]}")
print(f"({min(len(hits), cap)} of {len(hits)} matching messages in {len(files)} Goku chats of the last {days} days)")
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("words", nargs="+")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args()
    words = [w.lower() for w in a.words]
    # ssh joins its arguments into one remote shell line, so the word list is quoted for that shell.
    remote = "python3 - " + " ".join(shlex.quote(x) for x in (json.dumps(words), str(a.days), str(a.max)))
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "goku", remote],
                       input=REMOTE, capture_output=True, text=True, timeout=120)
    sys.stdout.write(r.stdout)
    if r.returncode:
        sys.stderr.write(r.stderr[-500:])
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
