#!/usr/bin/env python3
"""Drive the architect's comment flow in the real viewer and report what survives.

    python3 test/comment-flow.py            # run WITHOUT -I (Playwright lives in user site-packages)

Builds papers/open/zz-hltest/cf.pdf, selects "brown" with no tool active, clicks pdf.js's floating
comment button, types a note, saves, clicks the fresh highlight (must open the note before any
refresh), reloads, and prints the comments on disk. Exit 0 = all green.

Gotchas this encodes (2026-10-16, six failed probes): the viewer's CSP forbids page.wait_for_function
(poll with evaluate instead); a text-layer span's bounding_box() can be None, so measure the word
with a DOM Range; a fresh highlight is a `.highlightEditor.disabled` that the text layer covers, so
Playwright's .click() on it times out (click by coordinates). The file is overwritten on each run:
no cleanup needed, and AEGIS blocks deleting test files unasked.
"""
import subprocess, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "papers/open/zz-hltest/cf.pdf"
NOTE = "COMMENT FLOW NOTE"


def comments():
    return subprocess.run(["python3", str(ROOT / "pdf-comments.py"), str(OUT)], capture_output=True, text=True).stdout.strip()


def main():
    md = OUT.with_suffix(".src.md")  # not the sibling name, so the server's watcher leaves it alone
    md.write_text("# R\n\nThe quick brown fox jumps over the lazy dog.\n")
    OUT.unlink(missing_ok=True)
    subprocess.run(["python3", str(ROOT / "md2pdf.py"), str(md), str(OUT)], check=True)
    ok = True
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome")
        pg = b.new_page(viewport={"width": 1300, "height": 900})
        pg.goto(f"http://127.0.0.1:18820/viewer/web/viewer.html?file=/papers/open/zz-hltest/{OUT.name}")
        for _ in range(30):
            if pg.evaluate("(window.PDFViewerApplication && PDFViewerApplication.pagesCount) || 0") > 0:
                break
            pg.wait_for_timeout(500)
        pg.wait_for_timeout(1500)
        r = pg.evaluate("""(()=>{for(const n of document.querySelectorAll('.textLayer span')){const t=n.firstChild;
          if(!t||t.nodeType!=3)continue;const i=t.data.indexOf('brown');if(i<0)continue;const g=document.createRange();
          g.setStart(t,i);g.setEnd(t,i+5);const b=g.getBoundingClientRect();return [b.x,b.y,b.width,b.height]}return null})()""")
        y = r[1] + r[3] / 2
        pg.mouse.move(r[0] + 2, y); pg.mouse.down(); pg.mouse.move(r[0] + r[2] - 2, y, steps=5); pg.mouse.up()
        pg.wait_for_timeout(600)
        pg.locator("button.commentButton:visible").first.click(); pg.wait_for_timeout(800)
        pg.fill("#commentManagerTextInput", NOTE); pg.click("#commentManagerSaveButton")
        pg.wait_for_timeout(2500)
        c = pg.evaluate("(()=>{const r=document.querySelector('.highlightEditor').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
        pg.mouse.click(5, 300); pg.wait_for_timeout(300); pg.mouse.click(*c); pg.wait_for_timeout(800)
        shown = pg.evaluate(f"[...document.querySelectorAll('*')].some(e=>e.offsetParent&&e.children.length==0&&(e.innerText||'').includes('{NOTE}'))")
        print("fresh highlight click opens the note:", shown); ok &= shown
        pg.reload(); pg.wait_for_timeout(3000)
        after = pg.locator(".annotationCommentButton").count()
        print("comment buttons after refresh:", after); ok &= after == 1
        b.close()
    disk = comments()
    print("on disk:", disk); ok &= NOTE in disk
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
