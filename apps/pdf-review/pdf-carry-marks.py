#!/usr/bin/env python3
"""Copy the architect's review marks from an old PDF onto its rebuilt version.

    pdf-carry-marks.py OLD.pdf NEW.pdf      # rewrites NEW.pdf in place

A rebuild produces a fresh PDF with no annotations, so his comments vanished every time
(the architect 2026-10-16: "rebuilding the pdf deletes the comments, and they should be kept").
Highlights, underlines and strike-outs are re-anchored on the same words: the quoted text is
searched on the same page first, then on every page. A mark whose text is gone keeps its old
page and position. Notes, free text, ink and shapes keep their page and position.
"""
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

from importlib import util as _u
from pathlib import Path

_spec = _u.spec_from_file_location("pdf_comments", Path(__file__).with_name("pdf-comments.py"))
_pc = _u.module_from_spec(_spec)
_spec.loader.exec_module(_pc)

MARKUP = {"Highlight": "add_highlight_annot", "Underline": "add_underline_annot",
          "StrikeOut": "add_strikeout_annot", "Squiggly": "add_squiggly_annot"}


def _find(doc, start, quote):
    order = [start] + [i for i in range(len(doc)) if i != start]
    for i in order:
        hits = doc[i].search_for(quote, quads=True)
        if hits:
            return i, hits
    return None, None


def _style(src, dst):
    dst.set_info(content=src.info.get("content") or "", title=src.info.get("title") or "")
    colors = src.colors or {}
    if colors.get("stroke") or colors.get("fill"):
        dst.set_colors(stroke=colors.get("stroke"), fill=colors.get("fill"))
    if src.opacity is not None and src.opacity >= 0:
        dst.set_opacity(src.opacity)
    dst.update()


def carry(old_path, new_doc):
    """Add old_path's annotations to new_doc. Returns (carried, re-anchored, kept in place)."""
    carried = moved = stayed = 0
    with fitz.open(old_path) as old:
        for page in old:
            for a in page.annots() or []:
                kind = a.type[1]
                if kind in ("Popup", "Link", "Widget"):
                    continue
                pno = min(page.number, len(new_doc) - 1)
                verts = a.vertices or []
                if kind in MARKUP:
                    quote = _pc.marked_text(page, a)
                    hit_page, quads = _find(new_doc, pno, quote) if quote else (None, None)
                    if quads:
                        pno, moved = hit_page, moved + 1
                    else:
                        quads, stayed = [fitz.Quad(verts[i:i + 4]) for i in range(0, len(verts) - 3, 4)], stayed + 1
                    tp = new_doc[pno]
                    new = getattr(tp, MARKUP[kind])(quads)
                else:
                    tp = new_doc[pno]
                    if kind == "Text":
                        new = tp.add_text_annot(a.rect.tl, a.info.get("content") or "")
                    elif kind == "FreeText":
                        new = tp.add_freetext_annot(a.rect, a.info.get("content") or "")
                    elif kind == "Ink":
                        new = tp.add_ink_annot(verts)
                    elif kind == "Square":
                        new = tp.add_rect_annot(a.rect)
                    elif kind == "Circle":
                        new = tp.add_circle_annot(a.rect)
                    elif kind == "Line" and len(verts) >= 2:
                        new = tp.add_line_annot(fitz.Point(verts[0]), fitz.Point(verts[1]))
                    else:
                        print(f"[carry-marks] skipped a {kind} on p.{page.number + 1}", file=sys.stderr)
                        continue
                    stayed += 1
                _style(a, new)
                carried += 1
    return carried, moved, stayed


def carry_file(old_path, new_path):
    doc = fitz.open(new_path)
    counts = carry(old_path, doc)
    if counts[0]:
        doc.save(new_path, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
    doc.close()
    return counts


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    n, moved, stayed = carry_file(sys.argv[1], sys.argv[2])
    print(f"carried {n} marks ({moved} re-anchored on their text, {stayed} kept in place)")
