#!/usr/bin/env python3
"""pdf-carry-marks.py puts each mark on ONE place in the rebuilt PDF, chosen by the words around it.

    .venv/bin/python test/carry-marks.py      # fixture PDFs built here, in a temp dir; no server needed

a. A short quote ("no", "Mara,") that occurs on several pages, with three pages inserted before it:
   the mark lands on the right occurrence, once.
b. A unique quote: the mark sits exactly where a plain search puts it (the behaviour before the fix).
c. A quote that is gone: the mark keeps its page and position, and a warning goes to stderr.
Written 2026-11-14 after a rebuild moved 8 review comments onto the wrong words.
"""
import contextlib, io, sys, tempfile
from importlib import util
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:
    import fitz

ROOT = Path(__file__).resolve().parents[1]
spec = util.spec_from_file_location("carry", ROOT / "pdf-carry-marks.py")
carry = util.module_from_spec(spec)
spec.loader.exec_module(carry)
fails = 0


def check(ok, what):
    global fails
    print(("PASS" if ok else "FAIL"), what)
    fails += not ok


def build(path, pages):
    doc = fitz.open()
    for text in pages:
        doc.new_page().insert_textbox(fitz.Rect(50, 60, 545, 800), text, fontsize=11)
    doc.save(path)


def mark(path, pno, within, quote, note):
    """Highlight `quote` inside the phrase `within` on page pno."""
    doc = fitz.open(path)
    page = doc[pno]
    area = page.search_for(within)[0]
    a = page.add_highlight_annot(page.search_for(quote, clip=area + (-1, -1, 1, 1), quads=True))
    a.set_info(content=note)
    a.update()
    doc.saveIncr()
    doc.close()


def highlights(path):
    with fitz.open(path) as doc:
        return [(p.number, fitz.Rect(a.rect), a.info.get("content")) for p in doc for a in p.annots() or []]


def run(old, new):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        counts = carry.carry_file(str(old), str(new))
    return counts, err.getvalue()


def centre(rect):  # a highlight's rect is padded past its text, so test where its middle is
    return fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)


def where(path, pno, phrase):
    with fitz.open(path) as doc:
        return doc[pno].search_for(phrase)[0]


BODY = [
    "Mara, she said no to the offer at the harbour. Nobody knows why, and nothing in the letters explains it.",
    "The captain answered no without looking up from the chart. Mara, the boy asked again by the mast, "
    "and the answer was still no. The wind dropped before noon.",
    "In the end they all said no together, and Mara, laughing, rowed home alone.",
]
INSERTED = [
    "Prologue. Mara, it began, was a name nobody chose. She said no to her father once.",
    "A second page of new material. No, the harbour was not yet built, and no ship came.",
    "A third inserted page. Mara, the narrator, says no more about it.",
]

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)

    # a. short quotes on several pages, three pages inserted before them
    old, new = tmp / "a-old.pdf", tmp / "a-new.pdf"
    build(old, BODY)
    mark(old, 1, "answer was still no", "no", "his no")
    mark(old, 1, "Mara, the boy", "Mara,", "his Mara")
    build(new, INSERTED + BODY)
    counts, err = run(old, new)
    hl = highlights(new)
    check(len(hl) == 2, f"a: two marks in, two marks out (got {len(hl)})")
    no = [h for h in hl if h[2] == "his no"]
    mara = [h for h in hl if h[2] == "his Mara"]
    check(len(no) == 1 and no[0][0] == 4 and where(new, 4, "answer was still no").contains(centre(no[0][1])),
          f"a: \"no\" lands once, on p.5 in \"answer was still no\" (got {[(h[0] + 1, tuple(round(v) for v in h[1])) for h in no]})")
    check(len(mara) == 1 and mara[0][0] == 4 and where(new, 4, "Mara, the boy").contains(centre(mara[0][1])),
          f"a: \"Mara,\" lands once, on p.5 in \"Mara, the boy\" (got {[(h[0] + 1, tuple(round(v) for v in h[1])) for h in mara]})")
    check(counts == (2, 2, 0) and not err, f"a: counts {counts}, stderr {err.strip()!r}")

    # b. a unique quote: same place a plain search gives
    old, new = tmp / "b-old.pdf", tmp / "b-new.pdf"
    build(old, ["The quick brown fox jumps over the lazy dog, and the dog does not care."])
    mark(old, 0, "quick brown fox", "quick brown fox", "fox note")
    build(new, INSERTED[:2] + ["Some edits above. The quick brown fox jumps over the lazy dog, and the dog does not care."])
    with fitz.open(new) as d:  # what the code before the fix made: a highlight on the plain search hit
        pg = d[2]
        want = fitz.Rect(pg.add_highlight_annot(pg.search_for("quick brown fox", quads=True)).rect)
        del pg
    counts, err = run(old, new)
    hl = highlights(new)
    check(len(hl) == 1 and hl[0][0] == 2 and max(abs(a - b) for a, b in zip(hl[0][1], want)) < 0.5,
          f"b: unique quote on p.3 where a plain search puts it {tuple(round(v) for v in want)} "
          f"(got {[(h[0] + 1, tuple(round(v) for v in h[1])) for h in hl]})")
    check(counts == (1, 1, 0) and not err, f"b: counts {counts}, stderr {err.strip()!r}")

    # c. a quote that vanished: kept in place, reported
    old, new = tmp / "c-old.pdf", tmp / "c-new.pdf"
    build(old, ["Keep this line. This sentence will be cut entirely by the editor."])
    mark(old, 0, "cut entirely", "cut entirely", "cut note")
    before = highlights(old)
    build(new, ["Keep this line. The editor rewrote the rest."])
    counts, err = run(old, new)
    hl = highlights(new)
    check(len(hl) == 1 and hl[0][0] == 0 and abs(hl[0][1] - before[0][1]) < 1.5,
          f"c: vanished quote keeps p.1 and its old position (got {[(h[0] + 1, tuple(round(v) for v in h[1])) for h in hl]})")
    check(counts == (1, 0, 1) and "[carry-marks]" in err and "cut entirely" in err,
          f"c: counts {counts}, stderr {err.strip()!r}")

print(f"{fails} failed" if fails else "all passed")
sys.exit(1 if fails else 0)
