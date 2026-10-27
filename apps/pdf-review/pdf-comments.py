#!/usr/bin/env python3
"""List the review comments inside a PDF: page, kind, the text it marks, the note.

Reads standard PDF annotations, which is what pdf.js writes when you save
(highlight, free text, ink, sticky note, comment). Usage:

    pdf-comments.py paper.pdf          # markdown, one line per comment
    pdf-comments.py paper.pdf --json
"""
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


def marked_text(page, annot):
    """Text under a highlight/underline/strike-out, joined across its quads."""
    verts = annot.vertices or []
    parts = []
    for i in range(0, len(verts) - 3, 4):
        quad = fitz.Quad(verts[i:i + 4])
        text = page.get_textbox(quad.rect).strip()
        if text:
            parts.append(text)
    return " ".join(" ".join(parts).split())


def comments(path):
    out = []
    with fitz.open(path) as doc:
        for page in doc:
            for annot in page.annots() or []:
                kind = annot.type[1]
                if kind in ("Popup", "Link", "Widget"):
                    continue
                note = (annot.info.get("content") or "").strip()
                quote = ""
                if kind in ("Highlight", "Underline", "StrikeOut", "Squiggly"):
                    quote = marked_text(page, annot)
                elif kind in ("Ink", "Square", "Circle", "Line", "Polygon", "PolyLine"):
                    quote = " ".join(page.get_textbox(annot.rect).split())
                out.append({
                    "page": page.number + 1,
                    "kind": kind,
                    "quote": quote,
                    "note": note,
                    "author": annot.info.get("title") or "",
                    "rect": [round(v, 1) for v in annot.rect],
                })
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    found = comments(sys.argv[1])
    if "--json" in sys.argv:
        print(json.dumps(found, ensure_ascii=False, indent=2))
        return
    if not found:
        print("No comments in this PDF.")
        return
    for c in found:
        line = f"- p.{c['page']} · {c['kind']}"
        if c["quote"]:
            line += f' · "{c["quote"]}"'
        if c["note"]:
            line += f" → {c['note']}"
        print(line)


if __name__ == "__main__":
    main()
