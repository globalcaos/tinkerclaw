#!/usr/bin/env python3
"""The carry rules the "no mark is lost" contract leans on (2026-11-15). No server, no browser.

    .venv/bin/python test/carry-since.py

a. --since carries what he undid too: a note deleted on the device leaves the newer file, a rewritten note is
   rewritten there, a new mark arrives, an untouched one stays once.
b. Sending the same marks again (an answer lost on the way) changes nothing: a carry never doubles a mark.
c. An Apply rebuild through a folder's own build script (the book's chapters: build-chapters.sh) keeps the mark made
   after the round's marked copy and drops the one in the copy.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
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


def page_pdf(path, lines, top=72):
    d = fitz.open()
    p = d.new_page()
    for i, t in enumerate(lines):
        p.insert_text((72, top + 20 * i), t, fontsize=12)
    d.save(path)


def notes(path):
    with fitz.open(path) as d:
        return sorted((a.info.get("content") or "") for p in d for a in p.annots() or [] if a.type[1] not in carry.SKIP_KINDS)


def hl(page, word, note):
    a = page.add_highlight_annot(page.search_for(word)[0])
    a.set_info(content=note)
    a.update()


with tempfile.TemporaryDirectory(prefix="carry-since-") as tmp:
    t = Path(tmp)
    lines = ["Alpha opens the page", "Bravo comes second", "Charlie is third", "Delta closes it"]
    base, marked, target = t / "base.pdf", t / "marked.pdf", t / "target.pdf"
    page_pdf(base, lines)
    d = fitz.open(base)
    hl(d[0], "Alpha", "keep me")
    d[0].add_text_annot((300, 100), "edit me")
    d[0].add_text_annot((300, 200), "delete me")
    d.saveIncr()
    d.close()
    # the device: deletes one note, rewrites another, adds a highlight (an incremental save, as pdf.js makes)
    shutil.copy(base, marked)
    d = fitz.open(marked)
    for a in d[0].annots():
        if a.info.get("content") == "edit me":
            a.set_info(content="edited on the device")
            a.update()
    d[0].delete_annot(next(a for a in d[0].annots() if a.info.get("content") == "delete me"))
    hl(d[0], "Charlie", "new on the device")
    d.saveIncr()
    d.close()
    # the server's file moved on: rebuilt with a line more above (words shift), the base's marks carried by a rebuild
    page_pdf(target, ["A heading the rebuild added"] + lines)
    carry.carry_file(str(base), str(target))
    check(notes(target) == sorted(["keep me", "edit me", "delete me"]), f"a. the rebuild carried the base's marks: {notes(target)}")
    carry.carry_file(str(marked), str(target), str(base))
    want = sorted(["keep me", "edited on the device", "new on the device"])
    check(notes(target) == want, f"a. --since: deleted gone, edited rewritten, new added, untouched once: {notes(target)}")
    carry.carry_file(str(marked), str(target), str(base))
    check(notes(target) == want, f"b. the same marks sent again change nothing: {notes(target)}")
    carry.carry_file(str(marked), str(target))
    check(notes(target) == want, f"b. even without --since, nothing is doubled: {notes(target)}")

    # b2. two marks alike but in two places (the same word twice, no note) stay two through a carry and a replay
    twin, twin_t = t / "twin.pdf", t / "twin-target.pdf"
    page_pdf(twin, ["no and no again", "and then no once more"])
    d = fitz.open(twin)
    pg = d[0]
    for r in pg.search_for("no")[:3]:
        pg.add_highlight_annot(r)
    d.saveIncr()
    d.close()
    page_pdf(twin_t, ["no and no again", "and then no once more"])
    carry.carry_file(str(twin), str(twin_t))
    carry.carry_file(str(twin), str(twin_t))
    with fitz.open(twin_t) as d:
        n = sum(1 for a in d[0].annots() or [] if a.type[1] == "Highlight")
    check(n == 3, f"b2. three bare highlights of one word stay three, also when sent twice: {n}")

    # c. an Apply round through the folder's own build script
    folder = t / "book"
    folder.mkdir()
    pdf, md, clean = folder / "ch01.pdf", folder / "ch01.md", folder / "clean.pdf"
    md.write_text("# ch01\n\nAlpha opens the page\n")
    page_pdf(clean, ["Alpha opens the page, as the comment asked", "Bravo comes second", "Charlie is third"])
    (folder / "build-chapters.sh").write_text(f"#!/bin/bash\n# builds ch01.pdf\ncp {clean} \"$MD2PDF_OUT\"\n")
    page_pdf(pdf, lines)
    d = fitz.open(pdf)
    hl(d[0], "Alpha", "applied by the round")
    d.saveIncr()
    d.close()
    flag = ROOT / "state" / "applying" / "ch01.pdf.flag"
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text("test")
    try:
        shutil.copy(pdf, folder / "ch01-marques-oscar-1.pdf")  # the agent's copy of this round
        d = fitz.open(pdf)
        hl(d[0], "Charlie", "made while the agent worked")
        d.saveIncr()
        d.close()
        env = {k: v for k, v in os.environ.items() if k != "TC_SESSION_KEY"}
        r = subprocess.run([sys.executable, str(ROOT / "md2pdf.py"), str(md), str(pdf)], capture_output=True, text=True, env=env)
        check(r.returncode == 0, f"c. md2pdf ran the folder's script ({r.stderr.strip()[-200:]})")
        check(notes(pdf) == ["made while the agent worked"], f"c. the applied mark is gone, the later one stays: {notes(pdf)}")
        check(not flag.exists(), "c. the clean rebuild took the Apply flag away")
    finally:
        flag.unlink(missing_ok=True)

    # c2. the same round with the flag renewed by `touch` a minute after the copy (the story recipe renews it right
    # before the first edit): the copy still counts, because the round starts at the press time written inside the
    # flag. 2026-11-15 10:59, ch02: the renewal hid the round's copy and the clean rebuild set the marked file aside.
    page_pdf(pdf, lines)
    d = fitz.open(pdf)
    hl(d[0], "Alpha", "applied by the round")
    d.saveIncr()
    d.close()
    flag.write_text(time.strftime("%F %T"))
    try:
        shutil.copy(pdf, folder / "ch01-marques-oscar-2.pdf")  # this round's copy
        renewed = time.time() + 60
        os.utime(flag, (renewed, renewed))  # the renewal, a minute after the copy
        d = fitz.open(pdf)
        hl(d[0], "Charlie", "made while the agent worked")
        d.saveIncr()
        d.close()
        r = subprocess.run([sys.executable, str(ROOT / "md2pdf.py"), str(md), str(pdf)], capture_output=True, text=True, env=env)
        check(r.returncode == 0, f"c2. md2pdf ran ({r.stderr.strip()[-200:]})")
        check(notes(pdf) == ["made while the agent worked"], f"c2. renewed flag: the applied mark is gone, the later one stays: {notes(pdf)}")
    finally:
        flag.unlink(missing_ok=True)

print("all passed" if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
