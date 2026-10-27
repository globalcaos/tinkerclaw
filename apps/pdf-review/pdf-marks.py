#!/usr/bin/env python3
"""Read the marks in the pdf-review window that have not been saved yet.

pdf.js keeps annotations in the browser until Save. When the file has none, the comments are still
in the open window. This asks the server, the window answers on its next poll (about two seconds),
and the marks come back here. Nothing is written to the PDF.

    pdf-marks.py papers/open/<hash>/<file>.pdf     # or any path the viewer is serving
    pdf-marks.py --wait 8 <path>                    # seconds to wait for the window (default 6)

Prints one line per mark, then a line saying how many edits are pending. Exit 2 when the window
does not answer (it is closed, or the viewer code is older than this script).
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:18820"
ROOT = Path(__file__).resolve().parent


def served_path(arg):
    p = Path(arg).expanduser().resolve()
    try:
        rel = p.relative_to(ROOT)
    except ValueError:
        sys.exit(f"{p} is not under {ROOT}, so the viewer cannot be serving it")
    return "/" + rel.as_posix()


def main(argv):
    wait = 6
    args = []
    it = iter(argv)
    for a in it:
        if a == "--wait":
            wait = float(next(it))
        else:
            args.append(a)
    if len(args) != 1:
        sys.exit(__doc__)
    where = served_path(args[0])
    q = urllib.parse.urlencode({"path": where})
    try:
        urllib.request.urlopen(f"{BASE}/api/marks/want?path={q}", timeout=3).read()
    except OSError as err:
        sys.exit(f"the viewer server did not answer: {err}")
    deadline = time.time() + wait
    body = None
    while time.time() < deadline:
        try:
            body = urllib.request.urlopen(f"{BASE}/api/marks?path={q}", timeout=3).read()
            break
        except urllib.error.HTTPError as err:
            if err.code != 404:
                raise
        time.sleep(0.5)
    if body is None:
        sys.exit("no answer from the viewer window: it is closed, or it is running an older viewer")
    data = json.loads(body)
    marks = data.get("marks") or []
    if not marks:
        print(f"No marks read. Pending edits in the window: {data.get('pending', 0)}.")
        return
    for m in marks:
        line = f"- p.{m.get('page')} · {m.get('kind')}"
        if m.get("note"):
            line += f" → {m['note']}"
        print(line)
    print(f"{len(marks)} mark(s). Pending edits in the window: {data.get('pending', 0)}.")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
