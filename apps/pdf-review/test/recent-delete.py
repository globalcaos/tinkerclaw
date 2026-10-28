"""The 🕘 Recent list's long-press menu (2026-10-27, the architect: "There is currently no way to delete current files. On long
press the option should pop up"). POST /api/hide takes a file off the list and a later open brings it back;
POST /api/trash moves the real PDF into the trash with its .trashinfo, so a file manager can restore it; a test
fixture or a path outside papers/ is refused. Runs against a server started with PDF_REVIEW_TRASH=<trash dir>, never
the live one (its trash is the owner's).
Usage: python3 test/recent-delete.py <base url> <trash dir the server was started with>"""
import json, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

BASE, TRASH = sys.argv[1], Path(sys.argv[2])
ROOT = Path(__file__).resolve().parent.parent
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


fails = 0


def check(ok, what):
    global fails
    fails += not ok
    print(("PASS " if ok else "FAIL ") + what)


def listed(where):
    return any(f["path"] == where for f in call("GET", "/api/history")[1].get("files", []))


pdf = Path.home() / "Downloads" / f"pdfr-delete-test-{int(time.time())}.pdf"
link, moved = None, []
try:
    pdf.parent.mkdir(exist_ok=True)
    pdf.write_bytes(PDF)
    code, got = call("POST", "/api/open", {"path": str(pdf)})
    where = got.get("path", "")
    link = ROOT / where.lstrip("/")
    q = "?path=" + urllib.parse.quote(where)
    call("POST", "/api/opened" + q)
    check(listed(where), "an opened PDF is on the list")
    check(call("POST", "/api/hide" + q)[0] == 200 and not listed(where), "Remove from this list takes it off")
    check(pdf.is_file(), "removing it from the list leaves the file alone")
    time.sleep(0.01)
    call("POST", "/api/opened" + q)
    check(listed(where), "opening it again brings it back")
    check(call("POST", "/api/trash?path=" + urllib.parse.quote("/etc/hostname"))[0] == 404, "a path outside papers/ is refused")
    fixture = next((p for p in (ROOT / "papers").rglob("*.pdf") if p.is_file() and not p.is_symlink()), None)
    if fixture:
        fq = "?path=" + urllib.parse.quote("/" + fixture.relative_to(ROOT).as_posix())
        check(call("POST", "/api/trash" + fq)[0] == 403 and fixture.is_file(), "a test fixture is never trashed")
    code, got = call("POST", "/api/trash" + q)
    went = Path(got.get("trash", "/nonexistent"))
    moved = [went, TRASH / "info" / (went.name + ".trashinfo")]
    check(code == 200 and not pdf.exists() and went.is_file() and went.is_relative_to(TRASH), "Delete moves the PDF into the trash")
    info = moved[1].read_text() if moved[1].is_file() else ""
    check(urllib.parse.quote(str(pdf)) in info and "DeletionDate=" in info, "the trash keeps where it came from")
    check(not listed(where), "a trashed PDF drops off the list")
finally:
    pdf.unlink(missing_ok=True)
    for p in moved:
        p.unlink(missing_ok=True)
    if link and link.is_symlink():
        link.unlink()
sys.exit(1 if fails else 0)
