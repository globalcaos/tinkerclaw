#!/usr/bin/env python3
"""Review marks: a rebuild keeps them, and a tiny highlight still opens its comment.

    python3 test/marks.py        # needs server.py on 127.0.0.1:18820; NOT under python3 -I (fitz, playwright)

1. md2pdf --keep-marks (the architect's own text edit): highlight + sticky note survive, highlight follows its words;
   a default rebuild (after Apply comments) leaves none.
2. A one-letter highlight opens its comment from 4 px past its edge (normal view, fresh page each case).
Written 2026-10-16 after both fixes took ~15 hand-made probe calls.
"""
import shutil, subprocess, sys, tempfile
from pathlib import Path

import fitz
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DIR = ROOT / "papers" / "open" / "zz-hltest"  # the standing test folder; copy in, never symlink
fails = 0


def check(ok, what):
    global fails
    print(("PASS" if ok else "FAIL"), what)
    fails += not ok


def comments(pdf):
    out = subprocess.run(["python3", str(ROOT / "pdf-comments.py"), str(pdf)], capture_output=True, text=True).stdout
    return out


with tempfile.TemporaryDirectory() as tmp:
    md, pdf = Path(tmp) / "d.md", Path(tmp) / "d.pdf"
    md.write_text("# T\n\nA b c word here.\n\nThe quick brown fox jumps.\n")
    subprocess.run(["python3", str(ROOT / "md2pdf.py"), str(md), str(pdf)], check=True)
    d = fitz.open(pdf); p = d[0]
    a = p.add_highlight_annot(p.search_for("quick brown fox", quads=True)); a.set_info(content="fox note"); a.update()
    a = p.add_highlight_annot(p.search_for(" b ", quads=True)); a.set_info(content="tiny note"); a.update()
    p.add_text_annot((50, 50), "sticky").update(); d.saveIncr(); d.close()
    DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy(pdf, DIR / "tiny.pdf")
    md.write_text("# T\n\nA b c word here.\n\n" + "Filler sentence. " * 400 + "\n\nThe quick brown fox jumps.\n")
    subprocess.run(["python3", str(ROOT / "md2pdf.py"), str(md), str(pdf), "--keep-marks"], check=True, capture_output=True)
    c = comments(pdf)
    check("p.2 · Highlight · \"quick brown fox\" → fox note" in c, "rebuild: highlight kept and moved with its text")
    check("sticky" in c and "tiny note" in c, "rebuild: sticky note and tiny highlight kept")
    subprocess.run(["python3", str(ROOT / "md2pdf.py"), str(md), str(pdf), "--keep-marks"], check=True, capture_output=True)
    check(comments(pdf).count("fox note") == 1, "second rebuild: no duplicates")
    # Apply comments: the default rebuild is clean (the architect 2026-10-16: a processed comment must not linger).
    subprocess.run(["python3", str(ROOT / "md2pdf.py"), str(md), str(pdf)], check=True, capture_output=True)
    check("fox note" not in comments(pdf) and "sticky" not in comments(pdf), "default rebuild (after Apply comments): no marks left")

URL = "http://127.0.0.1:18820/viewer/web/viewer.html?file=/papers/open/zz-hltest/tiny.pdf"
with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    for label, dx, dy, want in [("centre", 0, 0, True), ("4 px past the edge", 13.5, 0, True), ("8 px below centre", 0, 8, True)]:
        pg = b.new_page(viewport={"width": 1200, "height": 900})
        pg.goto(URL); pg.wait_for_timeout(3500)
        r = pg.evaluate("""(()=>{const e=[...document.querySelectorAll('.highlightAnnotation')]
          .find(e=>e.getBoundingClientRect().width<30);if(!e)return null;const r=e.getBoundingClientRect();
          return [r.x+r.width/2,r.y+r.height/2,e.classList.contains('tiny')]})()""")
        if not r:
            check(False, "tiny highlight rendered"); pg.close(); break
        pg.mouse.click(r[0] + dx, r[1] + dy); pg.wait_for_timeout(800)
        shown = pg.evaluate("[...document.querySelectorAll('p.richText')].some(e=>e.offsetParent&&e.innerText.includes('tiny note'))")
        check(shown == want and r[2], f"tiny highlight click, {label}")
        pg.close()
    b.close()
sys.exit(1 if fails else 0)
