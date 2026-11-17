#!/usr/bin/env python3
"""The writer's server side (2026-11-15): POST /api/paragraph with writer: true saves at once and builds later.
    .venv/bin/python test/writer-server.py     (starts its own server on a spare port, in a temp folder; exit 0 = PASS)
Checks: the answer comes before any build; a block that would show other words than the ones typed is refused (422);
a block changed meanwhile is refused (409); Enter's new paragraphs and a deleted paragraph land in the .md; several
quick saves make one build; /api/built says which version of the .md the PDF holds."""
import json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("WRITER_SERVER_PORT", "18833"))
BASE = f"http://127.0.0.1:{PORT}"
fails = []


def check(name, ok, info=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  ({info})" if info else ""))
    if not ok:
        fails.append(name)


def call(method, route, body=None):
    req = urllib.request.Request(BASE + route, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    def body(raw):
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}  # an error page, not JSON
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, body(r.read())
    except urllib.error.HTTPError as e:
        return e.code, body(e.read())


with tempfile.TemporaryDirectory() as tmp:
    t = Path(tmp)
    md, pdf = t / "doc.md", t / "doc.pdf"
    md.write_text("# Doc\n\nFirst paragraph with **bold**.\n\nSecond paragraph.\n\nThird paragraph.\n", encoding="utf-8")
    subprocess.run([sys.executable, str(APP / "md2pdf.py"), str(md), str(pdf)], check=True, capture_output=True,
                   env={**os.environ, "TC_SESSION_KEY": ""})
    old = time.time() - 60
    os.utime(md, (old, old))
    key = f"writer-server-{os.getpid()}"
    link = APP / "papers" / "open" / "jarvistest" / f"{key}.pdf"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.unlink(missing_ok=True)
    link.symlink_to(pdf)
    served = f"/papers/open/jarvistest/{key}.pdf"
    log = open(t / "server.log", "w")
    srv = subprocess.Popen([str(APP / ".venv/bin/python"), str(APP / "server.py")], stdout=log, stderr=log,
                           env={**os.environ, "PDF_REVIEW_PORT": str(PORT), "PDF_REVIEW_OPEN_ROOTS": tmp,
                                "PDF_REVIEW_STATE": str(t / "state"), "PDF_REVIEW_TRASH": str(t / "trash")})
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(BASE + "/api/history", timeout=2)
                break
            except OSError:
                time.sleep(0.25)
        q = f"?path={served}"
        code, src = call("GET", f"/api/source{q}&text=1")
        check("source comes with each block's words", code == 200 and src["vis"][1] == "First paragraph with bold.", str(src.get("vis")))
        blocks = src["text"].split("\n\n")
        built0 = call("GET", f"/api/built{q}")[1]

        a = time.time()
        code, r = call("POST", f"/api/paragraph{q}", {"index": 1, "old": blocks[1], "new": "First paragraph with **bold** words.",
                                                      "vis": "First paragraph with bold words.", "writer": True})
        took = time.time() - a
        check("a save answers at once, before any build", code == 200 and took < 1.0, f"{took * 1000:.0f} ms")
        check("the .md holds it", "First paragraph with **bold** words." in md.read_text(encoding="utf-8"))
        saved1 = int(r["saved"])
        check("/api/built: a build is due", call("GET", f"/api/built{q}")[1]["pending"] is True)

        code, r = call("POST", f"/api/paragraph{q}", {"index": 2, "old": "Second paragraph.", "new": "Second *para*",
                                                      "vis": "Second paragraph.", "writer": True})
        check("a block that would show other words is refused", code == 422 and r.get("shows") == "Second para", json.dumps(r))
        check("...and nothing is written", "Second *para*" not in md.read_text(encoding="utf-8"))

        code, r = call("POST", f"/api/paragraph{q}", {"index": 2, "old": "Not what is there.", "new": "x", "vis": "x", "writer": True})
        check("a block changed meanwhile is refused", code == 409)

        code, r = call("POST", f"/api/paragraph{q}", {"index": 2, "old": "Second paragraph.", "new": "Second.\n\nAnd a new one.",
                                                      "vis": "Second. And a new one.", "writer": True})
        check("Enter: one block becomes two", code == 200 and "Second.\n\nAnd a new one.\n\nThird" in md.read_text(encoding="utf-8"))
        last = call("GET", f"/api/source{q}&text=1")[1]["text"].split("\n\n")[4]  # holds the file's final newline
        code, r = call("POST", f"/api/paragraph{q}", {"index": 4, "old": last, "new": "", "vis": "", "writer": True})
        text = md.read_text(encoding="utf-8")
        check("all its words deleted: the block goes, and one separator with it", code == 200 and text.endswith("And a new one.\n") and "Third" not in text, repr(text[-40:]))
        saved_last = int(r["saved"])

        for _ in range(60):
            b = call("GET", f"/api/built{q}")[1]
            if not b["pending"] and b["built"] and int(b["built"]) >= saved_last:
                break
            time.sleep(0.5)
        check("/api/built: the PDF holds the last save", b["built"] and int(b["built"]) >= saved_last >= saved1, json.dumps(b))
        builds = (t / "server.log").read_text().count("[md2pdf] doc.md -> doc.pdf: ok")
        check("four quick saves, at most two builds", 1 <= builds <= 2, f"{builds} builds")
        journal = [json.loads(line) for line in (t / "state" / "edit-journal.jsonl").read_text().splitlines()]
        check("the journal has the three saves, old and new", len(journal) == 3 and journal[0]["old"] == blocks[1], f"{len(journal)}")
        check("the box's old way still works (no writer flag)", call("POST", f"/api/paragraph{q}", {"index": 1, "old": "First paragraph with **bold** words.", "new": "First.\n\nStill one block."})[0] == 200
              and "First.\nStill one block." in md.read_text(encoding="utf-8"))
        code, _ = call("GET", "/viewer/web/fonts/..%2Fetc%2Fpasswd.ttf")
        check("the font route serves fonts only", code == 404)
    finally:
        srv.terminate()
        srv.wait(5)
        link.unlink(missing_ok=True)

print("FAIL" if fails else "PASS")
sys.exit(1 if fails else 0)
