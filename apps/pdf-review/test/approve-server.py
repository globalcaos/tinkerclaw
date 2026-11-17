#!/usr/bin/env python3
"""✓ Approve, the server side (2026-11-15): a paragraph printed blue stays blue until he approves it.
    .venv/bin/python test/approve-server.py     (starts its own server on a spare port, in a temp folder; exit 0 = PASS)
Two documents, one for each way a paragraph prints blue:
  marked.md  the .md wraps new text in nw (<span class="nw">, <div class="nw" markdown="1">); approving takes the
             marker off that paragraph only.
  stored.md  its build (build-stored.sh, the book chapters' rule) paints every unit not in .approved/stored.md;
             approving adds the paragraph there, and his own edit (POST /api/paragraph) is added as he saves it.
Checks: GET /api/approve lists exactly the blue paragraphs, each with its .md block and the end of its last line;
POST /api/approve answers at once, the rebuilt PDF prints that paragraph black and the others still blue; a
paragraph that changed meanwhile is refused (409); every approval is journaled."""
import json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP))
import server as S  # noqa: E402  the same block split and word reading the server uses

PORT = int(os.environ.get("APPROVE_SERVER_PORT", "18834"))
BASE = f"http://127.0.0.1:{PORT}"
fails = []


def check(name, ok, info=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  ({info})" if info else ""))
    if not ok:
        fails.append(name)


def call(method, route, body=None):
    req = urllib.request.Request(BASE + route, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


MARKED = """# Marked document

An old paragraph that has always been here and prints in the body grey.

Some old words with <span class="nw">a phrase added this round</span> in the middle of them.

<div class="nw" markdown="1">

A brand new paragraph, written this round, so it prints light blue.

A second new paragraph inside the same marked block.

</div>

The old closing paragraph.
"""

STORED = """# Stored document

The first paragraph, read and approved long ago.

The second paragraph, changed by an agent and not read yet.

- an old item of the list
- a new item of the list

The fourth paragraph, also new.
"""
APPROVED = """# Stored document

The first paragraph, read and approved long ago.

- an old item of the list
"""

# The book chapters' rule (book1/bible/assemble.py mark_new), small: a unit not in the approved text prints blue.
PAINT = r'''import re, sys
from pathlib import Path
UNIT = re.compile(r"\n\n|\n(?=[-*] |\d+\. )")
src, out = Path(sys.argv[1]), Path(sys.argv[2])
seen = {u.strip() for u in UNIT.split((src.parent / ".approved" / src.name).read_text(encoding="utf-8"))}
paras = []
for p in src.read_text(encoding="utf-8").split("\n\n"):
    s = p.strip()
    if not s or s.startswith(("#", "<", "![")):
        paras.append(p)
        continue
    units = UNIT.split(s)
    if len(units) == 1:
        paras.append(p if s in seen else '<div class="nw" markdown="1">\n\n' + s + "\n\n</div>")
    else:
        paras.append("\n".join(u if u.strip() in seen else u[:2] + '<span class="nw">' + u[2:] + "</span>" for u in units))
out.write_text("\n\n".join(paras), encoding="utf-8")
'''


def blue_words(pdf):
    """The words printed light blue, page by page, as one string."""
    import pymupdf as fitz
    with fitz.open(str(pdf)) as doc:
        return " ".join(s["text"].strip() for p in doc for b in p.get_text("dict")["blocks"] for ln in b.get("lines", [])
                        for s in ln["spans"] if s["color"] == S.NEW_RGB and s["text"].strip())


def built_after(pdf, t, timeout=90):
    """Wait until the server's Builder has written pdf after time t."""
    for _ in range(timeout * 4):
        if pdf.stat().st_mtime > t and not call("GET", f"/api/built?path={served[pdf.stem]}")[1].get("pending"):
            time.sleep(0.5)
            return True
        time.sleep(0.25)
    return False


with tempfile.TemporaryDirectory() as tmp:
    t = Path(tmp)
    env = {**os.environ, "TC_SESSION_KEY": ""}
    (t / "marked.md").write_text(MARKED, encoding="utf-8")
    subprocess.run([sys.executable, str(APP / "md2pdf.py"), str(t / "marked.md"), str(t / "marked.pdf")], check=True,
                   capture_output=True, env=env)
    (t / "stored.md").write_text(STORED, encoding="utf-8")
    (t / ".approved").mkdir()
    (t / ".approved" / "stored.md").write_text(APPROVED, encoding="utf-8")
    (t / "render").mkdir()
    (t / "paint.py").write_text(PAINT, encoding="utf-8")
    (t / "build-stored.sh").write_text(
        f'# builds stored.pdf: paints what is not approved, renders it elsewhere, then writes it over the PDF\n'
        f'set -e\npython3 paint.py stored.md render/stored.md\n'
        f'python3 {APP / "md2pdf.py"} render/stored.md render/stored-render.pdf\n'
        f'cp render/stored-render.pdf "${{MD2PDF_OUT:-stored.pdf}}"\n', encoding="utf-8")
    subprocess.run([sys.executable, str(APP / "md2pdf.py"), str(t / "stored.md"), str(t / "stored.pdf")], check=True,
                   capture_output=True, env=env)
    (t / "plain.md").write_text("# Plain\n\nNothing new in this one.\n", encoding="utf-8")
    subprocess.run([sys.executable, str(APP / "md2pdf.py"), str(t / "plain.md"), str(t / "plain.pdf")], check=True,
                   capture_output=True, env=env)
    old = time.time() - 60
    for name in ("marked.md", "stored.md", "plain.md"):
        os.utime(t / name, (old, old))
    key = f"approve-server-{os.getpid()}"
    served = {}
    for stem in ("marked", "stored", "plain"):
        link = APP / "papers" / "open" / "jarvistest" / f"{key}-{stem}.pdf"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.unlink(missing_ok=True)
        link.symlink_to(t / f"{stem}.pdf")
        served[stem] = f"/papers/open/jarvistest/{key}-{stem}.pdf"
    check("the stored document's build painted its new units blue",
          "changed by an agent" in blue_words(t / "stored.pdf") and "read and approved" not in blue_words(t / "stored.pdf"),
          blue_words(t / "stored.pdf")[:120])
    log = open(t / "server.log", "w")
    srv = subprocess.Popen([str(APP / ".venv/bin/python"), str(APP / "server.py")], stdout=log, stderr=log,
                           env={**os.environ, "PDF_REVIEW_PORT": str(PORT), "PDF_REVIEW_OPEN_ROOTS": tmp, "TC_SESSION_KEY": "",
                                "PDF_REVIEW_STATE": str(t / "state"), "PDF_REVIEW_TRASH": str(t / "trash")})
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(BASE + "/api/history", timeout=2)
                break
            except OSError:
                time.sleep(0.25)

        # ---- marked.md: the nw markers ----
        q = f"?path={served['marked']}"
        code, r = call("GET", f"/api/approve{q}")
        items = r.get("items", [])
        blocks = S.Handler._md_blocks(MARKED)
        want = [i for i, b in enumerate(blocks) if "phrase added" in b or "brand new" in b or "second new" in b]
        check("marked: the three blue paragraphs are listed, and only they", code == 200 and [it["index"] for it in items] == want,
              json.dumps([it["index"] for it in items]))
        check("marked: each comes with its .md block", all(it["old"] == blocks[it["index"]] for it in items))
        check("marked: each ends inside its page, on its last line",
              all(it["page"] == 1 and 0 < it["x"] < it["W"] and 0 < it["y0"] < it["y1"] < it["H"] for it in items),
              json.dumps(items[:1]))
        check("marked: each comes with its printed lines, the last one ending where the button goes",
              all(it["lines"] and all(len(l) == 5 and l[0] == it["page"] and l[1] < l[3] and l[2] < l[4] for l in it["lines"])
                  and abs(it["lines"][-1][3] - it["x"]) < 0.11 for it in items), json.dumps([it.get("lines") for it in items])[:300])
        brand = next(it for it in items if "brand new" in it["old"])
        t0 = time.time()
        a = time.time()
        code, r = call("POST", f"/api/approve{q}", {"index": brand["index"], "old": brand["old"]})
        check("marked: approving answers at once", code == 200 and r.get("how") == "marker" and time.time() - a < 1.0,
              f"{code} {r} {(time.time() - a) * 1000:.0f} ms")
        text = (t / "marked.md").read_text(encoding="utf-8")
        check("marked: the .md shows the same words", S.md_visible(text) == S.md_visible(MARKED))
        import markdown
        html = markdown.markdown(text, extensions=["extra"])
        check("marked: that paragraph left the nw block, the second one did not",
              '<p>A brand new paragraph' in html and '<div class="nw">\n<p>A second new paragraph' in html, html[:400])
        check("marked: the rebuilt PDF arrives", built_after(t / "marked.pdf", t0))
        bw = blue_words(t / "marked.pdf")
        check("marked: it prints black now, the other new text still blue",
              "brand new" not in bw and "second new" in bw and "phrase added" in bw, bw)
        code, r = call("GET", f"/api/approve{q}")
        left = [it["old"].split(" ", 3)[:3] for it in r.get("items", [])]
        check("marked: two blue paragraphs left", left == [["Some", "old", "words"], ["A", "second", "new"]], json.dumps(left))
        phrase = next(it for it in r["items"] if "phrase added" in it["old"])
        t0 = time.time()
        code, r = call("POST", f"/api/approve{q}", {"index": phrase["index"], "old": phrase["old"]})
        check("marked: a phrase inside an old paragraph: its span comes off", code == 200 and
              "Some old words with a phrase added this round in the middle of them." in (t / "marked.md").read_text(encoding="utf-8"), str(r))
        code, r = call("POST", f"/api/approve{q}", {"index": phrase["index"], "old": phrase["old"]})
        check("marked: the same paragraph again, now changed: refused, 409", code == 409, f"{code} {r}")

        # ---- stored.md: the approved text ----
        q = f"?path={served['stored']}"
        code, r = call("GET", f"/api/approve{q}")
        sblocks = S.Handler._md_blocks(STORED)
        got = [sblocks[it["index"]].strip() for it in r.get("items", [])]
        check("stored: the units not approved are listed", got == ["The second paragraph, changed by an agent and not read yet.",
                                                                   "- a new item of the list", "The fourth paragraph, also new."], json.dumps(got))
        second = r["items"][0]
        t0 = time.time()
        code, r = call("POST", f"/api/approve{q}", {"index": second["index"], "old": second["old"]})
        check("stored: approving adds it to the approved text, the .md stays as it was",
              code == 200 and r.get("how") == "store" and second["old"].strip() in (t / ".approved/stored.md").read_text(encoding="utf-8")
              and (t / "stored.md").read_text(encoding="utf-8") == STORED, str(r))
        check("stored: the rebuilt PDF arrives", built_after(t / "stored.pdf", t0))
        bw = blue_words(t / "stored.pdf")
        check("stored: that paragraph prints black, the others still blue",
              "changed by an agent" not in bw and "fourth paragraph" in bw and "new item" in bw, bw)
        item = next(it for it in call("GET", f"/api/approve{q}")[1]["items"] if "new item" in it["old"])
        t0 = time.time()
        code, r = call("POST", f"/api/approve{q}", {"index": item["index"], "old": item["old"]})
        check("stored: one list item is approved on its own", code == 200 and built_after(t / "stored.pdf", t0)
              and "new item" not in blue_words(t / "stored.pdf") and "fourth paragraph" in blue_words(t / "stored.pdf"),
              blue_words(t / "stored.pdf"))
        # His own edit of the last blue paragraph: his words are read, so they go into the approved text.
        cur = S.Handler._md_blocks((t / "stored.md").read_text(encoding="utf-8"))
        k = next(i for i, b in enumerate(cur) if "fourth paragraph" in b)
        t0 = time.time()
        code, r = call("POST", f"/api/paragraph{q}", {"index": k, "old": cur[k], "new": "The fourth paragraph, as he wrote it.",
                                                     "vis": "The fourth paragraph, as he wrote it.", "writer": True})
        check("stored: his own edit goes into the approved text as he saves it", code == 200 and
              "The fourth paragraph, as he wrote it." in (t / ".approved/stored.md").read_text(encoding="utf-8"), str(r))
        check("stored: ...and prints black", built_after(t / "stored.pdf", t0) and blue_words(t / "stored.pdf") == "",
              blue_words(t / "stored.pdf"))
        code, r = call("GET", f"/api/approve{q}")
        check("stored: nothing left to approve", code == 200 and r.get("items") == [], json.dumps(r))

        # ---- no blue at all, and no source ----
        code, r = call("GET", f"/api/approve?path={served['plain']}")
        check("plain: no blue, no buttons", code == 200 and r.get("has") is True and r.get("items") == [], json.dumps(r))
        code, r = call("GET", "/api/approve?path=/papers/open/jarvistest/no-such-file.pdf")
        check("a file that is not served: has nothing", code == 200 and r.get("has") is False, json.dumps(r))

        lines = (t / "state" / "approve-journal.jsonl").read_text(encoding="utf-8").splitlines()
        hows = [json.loads(x)["how"] for x in lines]
        check("every approval is journaled, with how", hows == ["marker", "marker", "store", "store"], json.dumps(hows))

        # ---- ✓ Approve all (2026-11-17): every blue paragraph in one request, one rebuild ----
        ZM = """# Batch marked

An old paragraph before anything new.

<div class="nw" markdown="1">

The first new paragraph inside a wrapper.

The second new paragraph inside the same wrapper.

</div>

Old words with <span class="nw">a new phrase</span> in them.

<div class="nw" markdown="1">

A lone new paragraph.

</div>

The old end.
"""
        ZS = """# Batch stored

The first paragraph, approved long ago.

The second paragraph, new.

- an old item
- a new item

The last paragraph, new as well.
"""
        (t / "zmarked.md").write_text(ZM, encoding="utf-8")
        (t / "zbatch.md").write_text(ZS, encoding="utf-8")
        (t / ".approved" / "zbatch.md").write_text("# Batch stored\n\nThe first paragraph, approved long ago.\n\n- an old item\n", encoding="utf-8")
        (t / "build-zbatch.sh").write_text(
            f'set -e\npython3 paint.py zbatch.md render/zbatch.md\npython3 {APP / "md2pdf.py"} render/zbatch.md render/zbatch-render.pdf\n'
            f'cp render/zbatch-render.pdf "${{MD2PDF_OUT:-zbatch.pdf}}"\n', encoding="utf-8")
        for stem in ("zmarked", "zbatch"):
            subprocess.run([sys.executable, str(APP / "md2pdf.py"), str(t / f"{stem}.md"), str(t / f"{stem}.pdf")], check=True,
                           capture_output=True, env=env)
            old_t = time.time() - 60
            os.utime(t / f"{stem}.md", (old_t, old_t))
            link = APP / "papers" / "open" / "jarvistest" / f"{key}-{stem}.pdf"
            link.unlink(missing_ok=True)
            link.symlink_to(t / f"{stem}.pdf")
            served[stem] = f"/papers/open/jarvistest/{key}-{stem}.pdf"
        n_journal = len(lines)

        q = f"?path={served['zmarked']}"
        code, r = call("GET", f"/api/approve{q}")
        zitems = r.get("items", [])
        head = r.get("head")
        check("approve all: the list comes with page 1's first line, for the button above it",
              isinstance(head, list) and len(head) == 4 and 0 < head[1] < head[3] / 4 and 0 < head[0] < head[2] / 3, json.dumps(head))
        check("approve all: four blue paragraphs in the marked document", len(zitems) == 4, json.dumps([it["old"][:24] for it in zitems]))
        t0 = time.time()
        stale = {"index": 99, "old": "A paragraph that is not in the text any more."}
        code, r = call("POST", f"/api/approve{q}", {"items": [{"index": it["index"], "old": it["old"]} for it in zitems] + [stale]})
        ztoken = r.get("undo")
        check("approve all: one request approves them all and answers at once", code == 200 and len(r.get("approved", [])) == 4
              and time.time() - t0 < 2.0, f"{code} {json.dumps(r)[:200]}")
        check("approve all: a paragraph that changed meanwhile is named, not approved", r.get("missed") == [stale["old"]], json.dumps(r.get("missed")))
        ztext = (t / "zmarked.md").read_text(encoding="utf-8")
        check("approve all: no nw marker left in the .md", 'class="nw"' not in ztext, ztext[:200])
        check("approve all: the .md shows the same words", S.md_visible(ztext) == S.md_visible(ZM))
        check("approve all: one rebuild, and it prints no blue", built_after(t / "zmarked.pdf", t0) and blue_words(t / "zmarked.pdf") == "",
              blue_words(t / "zmarked.pdf")[:120])
        code, r = call("GET", f"/api/approve{q}")
        check("approve all: nothing left to approve", code == 200 and r.get("items") == [] and r.get("head") is None, json.dumps(r)[:200])
        # ↶ Undo (2026-11-17): the .md goes back exactly as it was, and the rebuild prints them blue again.
        t0 = time.time()
        code, r = call("POST", f"/api/approve{q}", {"undo": ztoken})
        check("undo: the .md goes back exactly as it was", code == 200 and r.get("undone") == 4
              and (t / "zmarked.md").read_text(encoding="utf-8") == ZM, f"{code} {r}")
        check("undo: the rebuild prints them blue again", built_after(t / "zmarked.pdf", t0) and "first new paragraph" in blue_words(t / "zmarked.pdf"),
              blue_words(t / "zmarked.pdf")[:120])
        code, r = call("GET", f"/api/approve{q}")
        zitems = r.get("items", [])
        check("undo: the four are listed again", len(zitems) == 4, json.dumps([it["old"][:24] for it in zitems]))
        code, r = call("POST", f"/api/approve{q}", {"undo": ztoken})
        check("undo: a second undo is refused (409)", code == 409, f"{code} {r}")
        code, r = call("POST", f"/api/approve{q}", {"items": [{"index": it["index"], "old": it["old"]} for it in zitems]})
        token2 = r.get("undo")
        mine = (t / "zmarked.md").read_text(encoding="utf-8") + "\nA line he added afterwards.\n"
        (t / "zmarked.md").write_text(mine, encoding="utf-8")
        code, r = call("POST", f"/api/approve{q}", {"undo": token2})
        check("undo: refused once the text changed since (409), and his change stays", code == 409
              and (t / "zmarked.md").read_text(encoding="utf-8") == mine, f"{code} {r}")

        q = f"?path={served['zbatch']}"
        code, r = call("GET", f"/api/approve{q}")
        sitems = r.get("items", [])
        check("approve all, stored: three units listed", len(sitems) == 3, json.dumps([it["old"][:24] for it in sitems]))
        t0 = time.time()
        code, r = call("POST", f"/api/approve{q}", {"items": [{"index": it["index"], "old": it["old"]} for it in sitems]})
        store = (t / ".approved" / "zbatch.md").read_text(encoding="utf-8")
        check("approve all, stored: every unit goes into the approved text, the .md stays as it was",
              code == 200 and all(it["old"].strip() in store for it in sitems) and (t / "zbatch.md").read_text(encoding="utf-8") == ZS,
              f"{code} {json.dumps(r)[:160]}")
        check("approve all, stored: the rebuilt PDF prints no blue", built_after(t / "zbatch.pdf", t0) and blue_words(t / "zbatch.pdf") == "",
              blue_words(t / "zbatch.pdf")[:120])
        code, r = call("POST", f"/api/approve{q}", {"items": []})
        check("approve all: an empty list approves nothing (409)", code == 409, f"{code} {r}")

        zl = (t / "state" / "approve-journal.jsonl").read_text(encoding="utf-8").splitlines()[n_journal:]
        zj = [json.loads(x) for x in zl]
        hows = [x["how"] for x in zj if x.get("all")]
        check("approve all: one journal line per paragraph, marked as approve all, and one for the undo",
              hows == ["marker"] * 8 + ["store"] * 3 and sum(1 for x in zj if x.get("undo")) == 1 and len(zj) == 12, json.dumps([x.get("how", "undo") for x in zj]))
    finally:
        srv.terminate()
        srv.wait(timeout=10)
        for stem in served:
            (APP / "papers" / "open" / "jarvistest" / f"{key}-{stem}.pdf").unlink(missing_ok=True)
        if fails:
            print((t / "server.log").read_text(encoding="utf-8")[-3000:])

print("PASS" if not fails else f"FAIL: {len(fails)}")
sys.exit(1 if fails else 0)
