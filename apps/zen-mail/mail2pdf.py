#!/usr/bin/env python3
"""Save one email as a PDF, for receipts that arrive only as an email body (the butler's tool, 2026-10-16).

    python3 -I mail2pdf.py gmail <messageId> "<out.pdf>"
    python3 -I mail2pdf.py outlook <messageId> "<out.pdf>"

Chrome prints it with the network blocked, so no remote image loads and no tracking pixel tells the sender the mail
was opened. The output must sit under ~/Documents (the butler's topic folders) or /tmp/jarvis/ (test probes,
so a probe never lands where the delete guard forbids cleanup); anything else is refused.
"""
import base64
import html
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUTLOOK_CLI  # noqa: E402


def gmail(mid):
    m = json.loads(subprocess.run(["gog", "gmail", "get", mid, "--format", "full", "--json", "--no-input"],
                                  capture_output=True, text=True, check=True).stdout)
    m = m.get("message", m)
    p = m.get("payload") or {}
    hdr = {h["name"].lower(): h["value"] for h in p.get("headers", [])}

    def find(part, mime):
        if part.get("mimeType") == mime and (part.get("body") or {}).get("data"):
            d = part["body"]["data"]
            return base64.urlsafe_b64decode(d + "=" * (-len(d) % 4)).decode("utf-8", "replace")
        for q in part.get("parts") or []:
            r = find(q, mime)
            if r:
                return r
        return ""

    body = find(p, "text/html") or "<pre>" + html.escape(find(p, "text/plain")) + "</pre>"
    return hdr.get("from", ""), hdr.get("date", ""), hdr.get("subject", ""), body


def outlook(mid):
    m = json.loads(subprocess.run(["node", str(OUTLOOK_CLI), "mail", "read", mid], capture_output=True, text=True, check=True).stdout)
    frm = m.get("from") or {}
    frm = f"{frm.get('name', '')} <{frm.get('address', '')}>" if isinstance(frm, dict) else str(frm)
    body = m.get("body") or ""
    if "<" not in body:
        body = "<pre>" + html.escape(body) + "</pre>"
    return frm, m.get("date", ""), m.get("subject", ""), body


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("gmail", "outlook"):
        sys.exit(__doc__)
    kind, mid, out = sys.argv[1], sys.argv[2], os.path.abspath(sys.argv[3])
    if not out.startswith((os.path.expanduser("~/Documents/"), "/tmp/jarvis/")) or not out.lower().endswith(".pdf"):
        sys.exit("refused: the PDF must be written under ~/Documents or /tmp/jarvis and end in .pdf")
    frm, date, subj, body = (gmail if kind == "gmail" else outlook)(mid)
    head = (f"<meta charset='utf-8'><p style='font:12px sans-serif;color:#555'>{html.escape(frm)}<br>{html.escape(date)}"
            f"<br><b>{html.escape(subj)}</b></p><hr>")
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as f:
        f.write(head + body)
    # 2026-10-22: the Pi has Chromium, not google-chrome; four helpers in one run could not save a receipt.
    browser = next((b for b in ("google-chrome", "chromium", "chromium-browser") if shutil.which(b)), "google-chrome")
    profile = tempfile.mkdtemp(prefix="mail2pdf-")  # never the live relay browser's profile
    try:
        subprocess.run([browser, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--user-data-dir={profile}", "--password-store=basic",
                        "--host-resolver-rules=MAP * ~NOTFOUND", f"--print-to-pdf={out}", "file://" + f.name],
                       capture_output=True, timeout=90)
    finally:
        os.unlink(f.name)
        shutil.rmtree(profile, ignore_errors=True)
    if not os.path.exists(out):
        sys.exit("chrome did not write the PDF")
    os.chmod(out, 0o600)
    print(json.dumps({"saved": out, "bytes": os.path.getsize(out), "subject": subj}))


if __name__ == "__main__":
    main()
