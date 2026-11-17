"""The 🕘 Recent list offers only PDFs the viewer may open (2026-11-12). A link under papers/ to a PDF outside
OPEN_ROOTS (a test's file in /tmp, linked by hand) was listed: test files sat in the owner's Recent list, and
each reader start asked the phone to keep their folders, which /api/folder refuses. Runs against a server
started with PDF_REVIEW_OPEN_ROOTS=<inside dir>, never the live one.
Usage: python3 test/history-roots.py <base url> <inside dir> <outside dir>"""
import json, sys, urllib.request
from pathlib import Path

BASE, INSIDE, OUTSIDE = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
ROOT = Path(__file__).resolve().parent.parent
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"

links = []
try:
    for name, folder in (("in", INSIDE), ("out", OUTSIDE)):
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{name}.pdf").write_bytes(PDF)
        link = ROOT / "papers" / "open" / "historyroots" / f"{name}.pdf"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.unlink(missing_ok=True)
        link.symlink_to(folder / f"{name}.pdf")
        links.append(link)
    with urllib.request.urlopen(BASE + "/api/history", timeout=10) as r:
        paths = {f["path"] for f in json.loads(r.read())["files"]}
    ok_in = "/papers/open/historyroots/in.pdf" in paths
    ok_out = "/papers/open/historyroots/out.pdf" not in paths
    print(("PASS " if ok_in else "FAIL ") + "a PDF inside the open folders is on the list")
    print(("PASS " if ok_out else "FAIL ") + "a PDF outside them is not")
    sys.exit(0 if ok_in and ok_out else 1)
finally:
    for link in links:
        link.unlink(missing_ok=True)
    if links:
        links[0].parent.rmdir()
