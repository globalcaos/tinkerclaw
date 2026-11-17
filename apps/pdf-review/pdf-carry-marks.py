#!/usr/bin/env python3
"""Copy the architect's review marks from an old PDF onto its rebuilt version.

    pdf-carry-marks.py OLD.pdf NEW.pdf      # rewrites NEW.pdf in place
    pdf-carry-marks.py OLD.pdf NEW.pdf --since BASE.pdf   # only the marks OLD has and BASE had not

--since is the offline sync (2026-11-10): the phone marked up its copy (BASE) while the server's file moved
on to NEW (a clean rebuild after Apply comments, a paragraph edit). Only his new marks go across, so
comments an agent already applied and removed are not put back. Since 2026-11-15 --since also carries what he
undid: a mark BASE had and OLD no longer has is removed from NEW, and a note whose text he changed is changed.
A carry never doubles a mark: one already on NEW (the same kind, note and words, or place) is left alone, so
the same marks can be sent again after a lost answer.

    pdf-carry-marks.py --apply-round PDF BUILT   # an Apply rebuild (md2pdf.py): carry onto BUILT the marks PDF
                                                 # has that this round's marked copy has not
    pdf-carry-marks.py --rebuild PDF BUILT       # the same, and every mark when there is no copy of a round
                                                 # (a build script run by hand: book1/bible/chapter_pdf.py)

A rebuild produces a fresh PDF with no annotations, so his comments vanished every time
(2026-10-16: rebuilding the pdf deleted its comments; they must be kept).
Highlights, underlines and strike-outs are re-anchored on the same words. A quote with one match
in the new PDF goes there. A quote with several ("no", "Mara,") goes to the ONE candidate whose
surrounding words best match the words around it in the old PDF, ties broken by the nearest
relative position (2026-11-14: a rebuild that added three pages put 8 short-quote marks on every
match of the first page that had one). A mark whose text is gone, or with no confident candidate,
keeps its old page and position and is reported on stderr. Notes, free text, ink and shapes keep
their page and position.
"""
import re
import sys
import time
from difflib import SequenceMatcher
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


CONTEXT = 6  # words compared on each side of a mark
MIN_CONTEXT = 3  # context words that must match to pick one of several candidates


def _norm(word):
    return re.sub(r"[^\w]", "", word.lower())


def _words(doc):
    """Every word of the document in reading order: (page number, Rect, normalised text)."""
    out = []
    for page in doc:
        for w in page.get_text("words", sort=True):
            n = _norm(w[4])
            if n:
                out.append((page.number, fitz.Rect(w[:4]), n))
    return out


def _under(words, pno, quads):
    """Indexes of the words on page pno that the mark covers (most of the word, or most of the quad)."""
    idx = []
    for k, (p, r, _) in enumerate(words):
        if p != pno:
            continue
        for q in quads:
            inter = r & q.rect
            if not inter.is_empty and inter.get_area() > 0.5 * min(r.get_area(), q.rect.get_area()):
                idx.append(k)
                break
    return idx


def _context_score(old, lo, hi, new, s, k):
    """Words around the candidate new[s:s+k] that match those around old[lo:hi+1]."""
    def tokens(ws, a, b):
        return [w[2] for w in ws[max(0, a):max(0, b)]]
    before = SequenceMatcher(None, tokens(old, lo - CONTEXT, lo), tokens(new, s - CONTEXT, s), autojunk=False)
    after = SequenceMatcher(None, tokens(old, hi + 1, hi + 1 + CONTEXT), tokens(new, s + k, s + k + CONTEXT), autojunk=False)
    return sum(b.size for b in before.get_matching_blocks()) + sum(b.size for b in after.get_matching_blocks())


def _anchor(old_words, page, quads, quote, new_doc, new_words):
    """Where the mark goes in new_doc: (page number, quads), or (None, reason) to keep it in place."""
    idx = _under(old_words, page.number, quads)
    if not idx:
        hits = [(i, h) for i in range(len(new_doc)) for h in new_doc[i].search_for(quote, quads=True)]
        if len(hits) == 1:
            return hits[0][0], [hits[0][1]]
        return None, f"{len(hits)} matches and no words under it to compare"
    lo, hi = idx[0], idx[-1]
    want = [w[2] for w in old_words[lo:hi + 1]]
    k = len(want)
    cands = [s for s in range(len(new_words) - k + 1)
             if new_words[s][2] == want[0] and [w[2] for w in new_words[s:s + k]] == want]
    if not cands:
        return None, "its words are not in the rebuilt PDF"
    if len(cands) > 1:
        rel = lo / max(1, len(old_words))
        scored = sorted(cands, key=lambda s: (-_context_score(old_words, lo, hi, new_words, s, k),
                                              abs(s / max(1, len(new_words)) - rel)))
        best = _context_score(old_words, lo, hi, new_words, scored[0], k)
        avail = min(lo, CONTEXT) + min(len(old_words) - hi - 1, CONTEXT)
        if best < min(MIN_CONTEXT, avail):
            return None, f"{len(cands)} matches, none with its surrounding words"
        cands = scored[:1]
    sel = new_words[cands[0]:cands[0] + k]
    pno = sel[0][0]
    rects = [r for p, r, _ in sel if p == pno]
    clip = fitz.Rect(rects[0])
    for r in rects[1:]:
        clip |= r
    hits = new_doc[pno].search_for(quote, quads=True, clip=clip + (-1, -1, 1, 1))
    return pno, hits or [r.quad for r in rects]


def _style(src, dst):
    dst.set_info(content=src.info.get("content") or "", title=src.info.get("title") or "")
    colors = src.colors or {}
    if colors.get("stroke") or colors.get("fill"):
        dst.set_colors(stroke=colors.get("stroke"), fill=colors.get("fill"))
    if src.opacity is not None and src.opacity >= 0:
        dst.set_opacity(src.opacity)
    dst.update()


def _key(page, a):
    return (page.number, a.type[1], tuple(round(v) for v in a.rect), (a.info.get("content") or "").strip())


def marks_in(path):
    with fitz.open(path) as doc:
        return {_key(page, a) for page in doc for a in page.annots() or []}


SKIP_KINDS = ("Popup", "Link", "Widget")
NEAR = 8  # points: two notes or drawings this close, of one kind and one text, are one mark


def describe(page, a):
    """What names a mark across rebuilds and carries: its kind, its note, and the words under it or its place."""
    kind = a.type[1]
    r = a.rect
    quote = ""
    if kind in MARKUP:
        try:
            quote = " ".join(_norm(w) for w in (_pc.marked_text(page, a) or "").split() if _norm(w))
        except Exception:
            quote = ""
    return {"kind": kind, "note": (a.info.get("content") or "").strip(), "page": page.number, "quote": quote,
            "rect": fitz.Rect(r), "tl": (r.x0, r.y0), "c": ((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)}


def same_mark(x, y, moved=False):
    """One mark seen twice? moved=False: both on the same layout (the device's file and the version it was made on,
    or a placement on the target and what the target holds): the place must match, so two highlights of one word with
    one note stay two. moved=True (a rebuild in between): the words and the note decide."""
    if x["kind"] != y["kind"] or x["note"] != y["note"] or x["page"] != y["page"] and not (moved and len(x["quote"]) >= 12):
        return False
    if moved and (x["quote"] or y["quote"]):
        return x["quote"] == y["quote"]
    near = lambda p, q: abs(p[0] - q[0]) <= NEAR and abs(p[1] - q[1]) <= NEAR
    if x["quote"] or y["quote"]:
        return x["quote"] == y["quote"] and (near(x["tl"], y["tl"]) or (x["rect"] & y["rect"]).get_area() > 0.5 * min(x["rect"].get_area(), y["rect"].get_area()))
    return near(x["tl"], y["tl"]) or near(x["c"], y["c"])


def placed(d, pno, quads=None):
    """d as it will sit on the target: its page there and, for a highlight, the rectangle of its new quads."""
    out = {**d, "page": pno}
    if quads:
        r = fitz.Rect(quads[0].rect)
        for q in quads[1:]:
            r |= q.rect
        out.update(rect=r, tl=(r.x0, r.y0), c=((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
    return out


def marks_of(doc):
    return [(page, a, describe(page, a)) for page in doc for a in page.annots() or [] if a.type[1] not in SKIP_KINDS]


def carry(old_path, new_doc, skip=frozenset(), since_path=None):
    """Add old_path's annotations to new_doc, except those in `skip` (keys from marks_in) and those already on
    new_doc. With since_path (the version old_path was marked on): only the marks made since go across, and the
    marks since_path had that old_path no longer has (deleted, or a note rewritten) are taken off new_doc.
    Returns (carried, re-anchored, kept in place)."""
    carried = moved = stayed = 0
    new_words = _words(new_doc)
    there = [d for _, _, d in marks_of(new_doc)]
    before = []
    if since_path:
        with fitz.open(since_path) as since:
            before = [d for _, _, d in marks_of(since)]
    with fitz.open(old_path) as old:
        old_words = _words(old)
        now = [d for _, _, d in marks_of(old)]
        # Undone on the device since the version it was marked on: off the new file too (one match each).
        for gone in (b for b in before if not any(same_mark(b, n) for n in now)):
            for page in new_doc:
                hit = next((a for a in page.annots() or [] if a.type[1] not in SKIP_KINDS and same_mark(gone, describe(page, a), moved=True)), None)
                if hit:
                    page.delete_annot(hit)
                    there = [d for _, _, d in marks_of(new_doc)]
                    print(f"[carry-marks] removed a {gone['kind']} on p.{page.number + 1} undone on the device", file=sys.stderr)
                    break
        for page in old:
            for a in page.annots() or []:
                kind = a.type[1]
                if kind in SKIP_KINDS or _key(page, a) in skip:
                    continue
                d = describe(page, a)
                if any(same_mark(d, b) for b in before):
                    continue  # on the version it was marked on already: not new
                pno = min(page.number, len(new_doc) - 1)
                verts = a.vertices or []
                if kind in MARKUP:
                    quote = _pc.marked_text(page, a)
                    old_quads = [fitz.Quad(verts[i:i + 4]) for i in range(0, len(verts) - 3, 4)]
                    hit_page, quads = (_anchor(old_words, page, old_quads, quote, new_doc, new_words)
                                       if quote else (None, None))
                    if hit_page is not None:
                        pno, moved = hit_page, moved + 1
                    else:
                        if quote:
                            print(f"[carry-marks] p.{page.number + 1} {kind} \"{quote[:60]}\": {quads}; "
                                  f"kept in place on p.{pno + 1}", file=sys.stderr)
                        quads, stayed = old_quads, stayed + 1
                    tp = new_doc[pno]
                    if any(same_mark(placed(d, pno, [q if isinstance(q, fitz.Quad) else fitz.Quad(q) for q in quads]), t) for t in there):
                        continue  # already on the new file (carried before): never twice
                    new = getattr(tp, MARKUP[kind])(quads)
                else:
                    tp = new_doc[pno]
                    if any(same_mark(placed(d, pno), t) for t in there):
                        continue
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
                there.append(describe(tp, new))
                carried += 1
    return carried, moved, stayed


def carry_file(old_path, new_path, since=None):
    doc = fitz.open(new_path)
    n0 = sum(1 for _ in marks_of(doc))
    counts = carry(old_path, doc, marks_in(since) if since else frozenset(), since)
    if counts[0] or sum(1 for _ in marks_of(doc)) != n0:
        doc.save(new_path, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
    doc.close()
    return counts


APPLYING = Path(__file__).resolve().parent / "state" / "applying"
ROUND_TTL = 30 * 60


def round_copy(pdf):
    """This Apply round's marked copy of pdf: the newest <stem>-marques-oscar-N.pdf beside it made after Apply was
    pressed (the time the server wrote inside state/applying/<name>.flag; its mtime when it holds none), or in the
    last 30 minutes when the flag is gone. None when there is none.
    Made = its inode change time: `cp -p` keeps the old modification time, never the change time."""
    pdf = Path(pdf).resolve()
    flag = APPLYING / (pdf.name + ".flag")
    try:
        since = flag.stat().st_mtime - 5
    except OSError:
        since = time.time() - ROUND_TTL
    try:  # the press time the server wrote inside the flag: renewing the flag (touch) moves only its mtime (2026-11-15)
        since = min(since, time.mktime(time.strptime(flag.read_text(encoding="utf-8").strip()[:19], "%Y-%m-%d %H:%M:%S")) - 5)
    except (OSError, ValueError):
        pass
    best, n_best = None, -1
    for c in pdf.parent.glob(f"{glob_escape(pdf.stem)}-marques-oscar-*.pdf"):
        m = re.fullmatch(re.escape(pdf.stem) + r"-marques-oscar-(\d+)\.pdf", c.name)
        if m and int(m.group(1)) > n_best:
            best, n_best = c, int(m.group(1))
    if best and best.stat().st_ctime >= since:
        return best
    return None


def glob_escape(t):
    return re.sub(r"([*?\[])", r"[\1]", t)


def carry_round(pdf, built):
    """An Apply rebuild: carry onto `built` the marks the live pdf has that this round's marked copy has not (made
    while the agent worked), and the undoing of marks he removed since the copy. Answers (copy, counts) or
    (None, None) when there is no copy of this round."""
    copy = round_copy(pdf)
    if not copy or not Path(pdf).is_file():
        return None, None
    return copy, carry_file(str(pdf), str(built), str(copy))


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3 and args[0] in ("--apply-round", "--rebuild"):
        copy, counts = carry_round(args[1], args[2])
        if copy:
            print(f"carried {counts[0]} marks made after {copy.name}")
        elif args[0] == "--rebuild" and Path(args[1]).is_file():  # no Apply round: every mark stays
            n, moved, stayed = carry_file(args[1], args[2])
            print(f"no marked copy of this round: carried all {n} marks")
        else:
            print("no marked copy of this round: nothing carried")
        sys.exit(0)
    since = None
    if len(args) == 4 and args[2] == "--since":
        since, args = args[3], args[:2]
    if len(args) != 2:
        sys.exit(__doc__)
    n, moved, stayed = carry_file(args[0], args[1], since)
    print(f"carried {n} marks ({moved} re-anchored on their text, {stayed} kept in place)")
