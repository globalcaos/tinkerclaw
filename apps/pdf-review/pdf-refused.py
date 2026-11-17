#!/usr/bin/env python3
"""Every upload and paragraph edit the viewer's server refused, turned back into something readable. One call.

    pdf-refused.py                 list them, newest last: when, which file, why, and the notes each one holds
    pdf-refused.py ch03            only those whose file name contains "ch03"
    pdf-refused.py --out DIR       also write each one back as a PDF into DIR (never over the original)

server.py keeps each refused save under state/refused/ as <file>.<UTC>.bin plus a .json beside it (status,
reason, the save's query and headers); md2pdf.py keeps there a marked file a clean rebuild replaced with no marked
copy of its round; a refused paragraph edit is a .json with the old and the new text. A part save (only what pdf.js
appended, `keep`/`len`/`crc`) is rebuilt against the files that could have been its start: the PDF itself, its
-before-edit.pdf, its -marques-oscar-N.pdf copies and the other kept uploads; the crc32 says which one fits.
"""
import json
import os
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = Path(os.environ.get("PDF_REVIEW_STATE") or ROOT / "state") / "refused"


def candidates(meta):
    f = Path(meta.get("file", ""))
    out = [f, f.with_name(f.stem + "-before-edit.pdf"), *sorted(f.parent.glob(f.stem + "-marques-oscar-*.pdf"))]
    out += sorted(STATE.glob(f.name + ".*.bin"))
    return [c for c in out if c.is_file()]


def recover(meta, body):
    """The marked PDF this upload carried, or (None, why)."""
    q, h = meta.get("query") or {}, meta.get("headers") or {}
    if "keep" in q and not (h.get("X-Made-Length") or h.get("X-Base-Length")):  # a part: only what pdf.js appended
        try:
            n, total, crc = int(q["keep"]), int(q["len"]), int(q["crc"], 16)
        except (KeyError, ValueError):
            return None, "a part with no keep/len/crc"
        for c in candidates(meta):
            head = c.read_bytes()[:n]
            whole = head + body
            if len(head) == n and len(whole) == total and zlib.crc32(whole) == crc:
                return whole, None
        return None, f"a part of {len(body)} bytes; none of {len(candidates(meta))} candidate files is its start"
    if not body.startswith(b"%PDF-"):
        return None, "not a PDF"
    if h.get("X-Since-Length") or h.get("X-Made-Length"):
        k = int(h.get("X-Since-Length") or 0)
        return (body[:len(body) - k] if k else body), None
    if h.get("X-Base-Length"):
        return body[int(h["X-Base-Length"]):], None
    if meta.get("base_length"):
        return body[int(meta["base_length"]):], None
    return body, None


def notes(pdf):
    py = ROOT / ".venv/bin/python"
    r = subprocess.run([str(py if py.exists() else sys.executable), str(ROOT / "pdf-comments.py"), str(pdf)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return "(not readable as a PDF: " + (r.stderr.strip().splitlines() or ["?"])[-1][:160] + ")"
    return r.stdout.strip()


def main(argv):
    out_dir = None
    if "--out" in argv:
        i = argv.index("--out")
        out_dir = Path(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
        out_dir.mkdir(parents=True, exist_ok=True)
    want = argv[0] if argv else ""
    if not STATE.is_dir():
        print(f"nothing refused ({STATE} does not exist)")
        return 0
    items = sorted(STATE.glob("*.json"), key=lambda p: p.stat().st_mtime)
    shown = 0
    for side in items:
        try:
            meta = json.loads(side.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        name = Path(meta.get("file", side.name)).name
        if want and want not in name:
            continue
        shown += 1
        print(f"== {meta.get('at', '?')}  {name}  {meta.get('status')}: {meta.get('why', '')}  [{side.name}]")
        if meta.get("kind") == "paragraph":
            print(f"   paragraph {meta.get('index')}, his words:\n   {meta.get('new', '')}")
            if meta.get("current"):
                print(f"   the paragraph there now:\n   {meta['current']}")
            continue
        binp = STATE / (meta.get("bin") or "")
        if not meta.get("bin") or not binp.is_file():
            print("   (no body kept)")
            continue
        pdf, why = recover(meta, binp.read_bytes())
        if pdf is None:
            print(f"   not recoverable as a PDF: {why}")
            continue
        if out_dir:
            dest = out_dir / f"{Path(name).stem}.{side.stem.rsplit('.', 1)[-1]}.pdf"
            dest.write_bytes(pdf)
            print(f"   written: {dest}")
            print("   " + notes(dest).replace("\n", "\n   "))
        else:
            with tempfile.NamedTemporaryFile(suffix=".pdf") as t:
                t.write(pdf)
                t.flush()
                print("   " + notes(t.name).replace("\n", "\n   "))
    if not shown:
        print("nothing refused" + (f" for {want}" if want else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
