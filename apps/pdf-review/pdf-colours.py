#!/usr/bin/env python3
"""What colour does a PDF's text really print in? One call to check a review round's marking.

    pdf-colours.py FILE.pdf [FILE.pdf ...]       # per file: share of new text, its first line, top colours
    pdf-colours.py FILE.pdf --json
    pdf-colours.py FILE.pdf --colour '#0b2f7a'   # count another colour as new text

A review round prints its new or changed text in NEW, the `.nw` rule in md2pdf.py; test/new-text-colour.py
keeps the two equal. Read the built PDF, never the source: until 2026-11-14 md2pdf gave every paragraph its
own grey, so a colour on a wrapping <div class="nw"> never reached the page, and a pdftotext hit (the words
are there) was taken as proof that they were blue.
"""
import collections
import json
import sys
from pathlib import Path

try:  # PyMuPDF; the Pi's system Python has none, the reader's .venv does (2026-10-21)
    import pymupdf as fitz
except ImportError:
    try:
        import fitz
    except ImportError:
        import os
        _venv = Path(__file__).resolve().parent / ".venv"
        if (_venv / "bin" / "python").is_file() and Path(sys.prefix).resolve() != _venv.resolve():
            os.execv(str(_venv / "bin" / "python"), [str(_venv / "bin" / "python"), __file__, *sys.argv[1:]])
        raise

NEW = "#1e90ff"  # the .nw rule in md2pdf.py


def spans(pdf):
    """(page number, text, '#rrggbb') for every text span that is not blank."""
    with fitz.open(pdf) as doc:
        for pno, page in enumerate(doc, 1):
            for block in page.get_text("dict")["blocks"]:
                for line in block.get("lines", []):
                    for span in line["spans"]:
                        if span["text"].strip():
                            yield pno, span["text"].strip(), "#%06x" % span["color"]


def census(pdf, new=NEW):
    """Characters per text colour, the new-text share, and the first span in the new-text colour."""
    cols, first = collections.Counter(), None
    for pno, text, colour in spans(pdf):
        cols[colour] += len(text)
        if colour == new and first is None:
            first = (pno, text)
    total = sum(cols.values())
    return {"file": str(pdf), "chars": total, "new": cols[new],
            "share": round(100 * cols[new] / total, 1) if total else 0.0,
            "first_new": first, "colours": cols.most_common(6)}


def main(argv):
    new = NEW
    if "--colour" in argv:
        i = argv.index("--colour")
        new = "#" + argv[i + 1].lower().lstrip("#")
        del argv[i:i + 2]
    as_json = "--json" in argv
    files = [a for a in argv if a != "--json"]
    if not files:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    rows = [census(f, new) for f in files]
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return 0
    for r in rows:
        first = f'p.{r["first_new"][0]} "{r["first_new"][1][:60]}"' if r["first_new"] else "none"
        top = " · ".join(f"{c} {100 * n // max(r['chars'], 1)}%" for c, n in r["colours"])
        print(f'{Path(r["file"]).name}: new text {r["share"]}% ({r["new"]} of {r["chars"]} chars), first {first} | {top}')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
