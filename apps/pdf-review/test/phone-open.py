"""The phone's way in (2026-10-21): POST /api/open links a PDF from an allowed folder, /api/opened puts it at
the top of /api/history, a file that is gone drops off the list, and /api/voices only lists voices this
machine can speak. Runs against the live server.
Usage: python3 test/phone-open.py [base url, default http://127.0.0.1:18820]"""
import json, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18820"
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


inside = Path.home() / "Downloads" / f"pdfr-phone-test-{int(time.time())}.pdf"
outside = Path("/tmp") / inside.name
link = None
try:
    inside.parent.mkdir(exist_ok=True)
    inside.write_bytes(PDF)
    outside.write_bytes(PDF)
    code, got = call("POST", "/api/open", {"path": str(inside)})
    check(code == 200 and got.get("path", "").startswith("/papers/open/"), "a PDF in ~/Downloads opens")
    link = ROOT / got.get("path", "/x").lstrip("/")
    check(call("POST", "/api/open", {"path": str(outside)})[0] == 403, "a PDF in /tmp is refused")
    check(call("POST", "/api/open", {"path": "/etc/hostname"})[0] == 404, "a file that is not a PDF is refused")
    call("POST", "/api/opened?path=" + urllib.parse.quote(got.get("path", "")))
    files = call("GET", "/api/history")[1].get("files", [])
    check(bool(files) and files[0]["path"] == got.get("path"), "the opened file is first in the history")
    inside.unlink()
    files = call("GET", "/api/history")[1].get("files", [])
    check(all(f["path"] != got.get("path") for f in files), "a file that is gone is left out")
    voices = call("GET", "/api/voices")[1]
    check(voices.get("default") in voices.get("voices", []), "the default voice is one the server has")
finally:
    for p in (inside, outside):
        p.unlink(missing_ok=True)
    if link and link.is_symlink():
        link.unlink()
sys.exit(1 if fails else 0)
