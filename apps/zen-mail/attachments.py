"""Mail attachments: list them for a topic and open one with the computer's own default app (2026-10-16:
any attachment opens, the same way TinkerClaw does it, in the operating system's default app).

Listing is lazy: the first time a topic with attachments is opened, each message's list is fetched once (Outlook:
`outlook.mjs mail attachments`; Gmail: the thread's parts) and kept in `messages.atts`. Opening downloads the file
once into ~/.cache/zen-mail/attachments/ (owner-only) and hands it to xdg-open, detached, like TinkerClaw's
config.openExternalFile. A file that can run a program is never opened with one click: its folder opens instead.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

from common import HOME, gog, log, outlook, settings, source_of

CACHE = HOME / ".cache" / "zen-mail" / "attachments"

# Kinds that run code when opened. One click on these from a stranger's mail is how a machine is taken over, so the
# folder opens instead and he decides (2026-10-16).
RUNNABLE = {".desktop", ".sh", ".bash", ".run", ".bin", ".appimage", ".exe", ".msi", ".bat", ".cmd", ".com", ".scr",
            ".ps1", ".vbs", ".js", ".jse", ".jar", ".py", ".pl", ".rb", ".deb", ".rpm", ".apk", ".lnk", ".reg", ".hta"}


def _opener():
    if os.environ.get("ZEN_MAIL_OPENER"):  # tests swap the opener so nothing pops up on the owner's screen
        return [os.environ["ZEN_MAIL_OPENER"]]
    if sys.platform == "darwin":
        return ["open"]
    if sys.platform.startswith("win"):
        return ["cmd", "/c", "start", ""]
    return ["xdg-open"]


def _gmail_parts(payload, out):
    for p in (payload or {}).get("parts") or []:
        body = p.get("body") or {}
        if p.get("filename") and body.get("attachmentId"):
            disp = " ".join(h.get("value", "") for h in p.get("headers") or [] if h.get("name", "").lower() == "content-disposition")
            if not disp.lower().startswith("inline") or not (p.get("mimeType") or "").startswith("image/"):
                out.append({"id": body["attachmentId"], "name": p["filename"], "mime": p.get("mimeType") or "",
                            "size": body.get("size") or 0})
        _gmail_parts(p, out)
    return out


def list_for_topic(conn, tid):
    """{message id: [{id, name, mime, size}]} for the topic's messages that carry attachments. Mail only."""
    t = conn.execute("SELECT * FROM topics WHERE id=?", (tid,)).fetchone()
    if not t or source_of(t["conv"]) != "email" or t["private"]:
        return {}
    kind = settings()["accounts"][t["acct"]]["kind"]
    msgs = conn.execute("SELECT id, atts FROM messages WHERE acct=? AND conv=? AND has_att=1", (t["acct"], t["conv"])).fetchall()
    todo = [m["id"] for m in msgs if m["atts"] is None]
    if todo and kind == "gmail":
        found = {}
        thread = gog("gmail", "thread", "get", t["conv"])
        for m in (thread.get("thread", thread) or {}).get("messages", []):
            found[m["id"]] = _gmail_parts(m.get("payload"), [])
        for mid in todo:
            conn.execute("UPDATE messages SET atts=? WHERE id=?", (json.dumps(found.get(mid, [])), mid))
    elif todo:
        for mid in todo:
            try:
                rows = outlook("mail", "attachments", mid, timeout=60)
            except Exception as err:  # one message failing must not hide the others
                log(f"[attachments] list failed for {mid[-12:]}: {err}")
                continue
            atts = [{"id": a["id"], "name": a.get("name") or "attachment", "mime": a.get("contentType") or "",
                     "size": a.get("size") or 0} for a in rows if not a.get("isInline")]
            conn.execute("UPDATE messages SET atts=? WHERE id=?", (json.dumps(atts, ensure_ascii=False), mid))
    conn.commit()
    out = {}
    for m in conn.execute("SELECT id, atts FROM messages WHERE acct=? AND conv=? AND has_att=1", (t["acct"], t["conv"])):
        atts = json.loads(m["atts"] or "[]")
        if atts:
            out[m["id"]] = atts
    return out


def _safe_name(name):
    name = os.path.basename((name or "").replace("\\", "/")).strip().lstrip(".")
    name = re.sub(r"[\x00-\x1f/]", "_", name)
    return name[:180] or "attachment"


def _download(m, att):
    """The attachment's file in the cache, downloaded the first time (owner-only, never executable)."""
    folder = CACHE / hashlib.sha1(f"{m['id']}|{att['id']}".encode()).hexdigest()[:16]
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(CACHE, 0o700)
    path = folder / _safe_name(att.get("name"))
    if not path.exists() or path.stat().st_size == 0:
        kind = settings()["accounts"][m["acct"]]["kind"]
        if kind == "gmail":
            gog("gmail", "attachment", m["id"], att["id"], "--out", str(path))
        else:
            outlook("mail", "attachment", m["id"], att["id"], "--save", str(path), timeout=180)
        os.chmod(path, 0o600)
    return path


def _find(conn, msg_id, att_id):
    m = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    att = next((a for a in json.loads((m["atts"] if m else None) or "[]") if a.get("id") == att_id), None)
    return m, att


def open_attachment(conn, msg_id, att_id):
    m, att = _find(conn, msg_id, att_id)
    if not m:
        return {"ok": False, "error": "that message is no longer here; check again"}
    if not att:
        return {"ok": False, "error": "that attachment is no longer listed"}
    path = _download(m, att)
    runnable = path.suffix.lower() in RUNNABLE
    target = path.parent if runnable else path
    subprocess.Popen(_opener() + [str(target)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    return {"ok": True, "name": path.name, "folder_only": runnable}


# ─── text, for the topic chat (2026-10-16) ──────────────────────────────────────────────────────────────────────────
# the architect asked the chat about a card-movements list that came as an .xls; the chat only had the mail text and said it
# could not see it. Now the chat gets the attachments' text: PDFs through pdftotext, office files and spreadsheets
# through LibreOffice (its own profile, so an open LibreOffice window is not disturbed). Read once, kept beside the file.

TEXT_KINDS = {".pdf": "pdf", ".txt": "plain", ".csv": "plain", ".md": "plain", ".xls": "calc", ".xlsx": "calc",
              ".xlsm": "calc", ".ods": "calc", ".doc": "writer", ".docx": "writer", ".odt": "writer", ".rtf": "writer"}
LO_PROFILE = "file:///tmp/zen-mail-libreoffice"


def _extract(path):
    kind = TEXT_KINDS.get(path.suffix.lower())
    side = path.with_name(path.name + ".txt")
    if side.exists():
        return side.read_text(encoding="utf-8", errors="replace")
    text = ""
    if kind == "plain":
        text = path.read_text(encoding="utf-8", errors="replace")
    elif kind == "pdf":
        text = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, timeout=60).stdout
    elif kind in ("calc", "writer"):
        target = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1" if kind == "calc" else "txt:Text"
        out = path.parent / "converted"
        out.mkdir(exist_ok=True)
        subprocess.run(["soffice", f"-env:UserInstallation={LO_PROFILE}", "--headless", "--convert-to", target,
                        "--outdir", str(out), str(path)], capture_output=True, timeout=120)
        made = sorted(out.glob(path.stem + "*"))
        text = "\n\n".join(f.read_text(encoding="utf-8", errors="replace") for f in made)
    if text:
        side.write_text(text, encoding="utf-8")
        os.chmod(side, 0o600)
    return text


def texts_for_topic(conn, tid, per_file=12000, total=30000):
    """[{name, from, text}] for the topic's readable attachments, newest mail first, within a size budget."""
    out, used = [], 0
    try:
        listed = list_for_topic(conn, tid)
    except Exception as err:
        log(f"[attachments] no list for the chat: {err}")
        return out
    for mid, atts in listed.items():
        m = conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        for att in atts:
            name = att.get("name") or ""
            if os.path.splitext(name)[1].lower() not in TEXT_KINDS or used >= total:
                continue
            try:
                text = _extract(_download(m, att))[:per_file]
            except Exception as err:
                log(f"[attachments] could not read {name}: {err}")
                continue
            # Card, account and contract numbers never go to a model whole: keep the last four digits.
            text = re.sub(r"\b\d[\d ]{10,}\d\b", lambda x: "…" + re.sub(r"\D", "", x.group(0))[-4:], text)
            if text.strip():
                out.append({"name": name, "from": m["from_name"] or m["from_addr"], "date": (m["date"] or "")[:10], "text": text})
                used += len(text)
    return out
