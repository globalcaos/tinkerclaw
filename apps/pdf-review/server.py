#!/usr/bin/env python3
"""Loopback server for pdf-review: the viewer files, plus three small endpoints.

  GET  /api/voices               installed Piper voices
  POST /api/tts {text, voice}    one sentence as WAV, synthesised offline by Piper
  GET  /api/bookmark?doc=<id>    where the reader stopped in that document
  PUT  /api/bookmark?doc=<id>    save it (body: JSON)
  PUT  /api/save?path=<url path> overwrite the original PDF behind a papers/ link (body: the PDF)
  POST /api/marks/pull?path=<url path>  ask the open viewer to hand over its unsaved marks
  GET  /api/marks?path=<url path>        those marks, once the viewer has answered (404 until then)
  POST /api/origin?path=<url path>  record which chat made this file (body: {"session": "..."})
  GET  /api/origin?path=<url path>   whether a chat is recorded (200 yes, 404 no)
  POST /api/redo?path=<url path>     wake that chat: read the comments and redo the document
  POST /api/open {path}              link a PDF on disk under papers/open/ and answer its url path
  POST /api/opened?path=<url path>   the viewer opened this file: put it at the top of the history
  GET  /api/history                  every PDF opened with the viewer that still exists, newest first

Bookmarks live in state/bookmarks.json, keyed by the PDF's fingerprint, so a
renamed or moved copy of the same file still finds its place.
"""
import io
import json
import os
import sys
import threading
import time
import wave
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state" / "bookmarks.json"
APPLYING = ROOT / "state" / "applying"  # <pdf name>.flag: Apply comments pressed, an agent owns the next rebuild
APPLYING_TTL = 30 * 60  # a flag older than this is ignored, so a chat that never rebuilt cannot block his edits
ORIGINS = ROOT / "state" / "origins.json"
HISTORY = ROOT / "state" / "history.json"  # url path -> {file, at}: what the viewer opened, for the phone's list
# /api/open serves a PDF from these folders only (the same roots Tinker's file links may open).
OPEN_ROOTS = [Path.home() / d for d in ("Documents", "Downloads", "Desktop", "Pictures", "src", ".openclaw")]
VOICES_DIR = Path.home() / ".local/share/piper-voices"
# Kokoro voices are listed as "kokoro:<id>"; a/b prefix = American/British English.
KOKORO_VOICES = ["af_heart", "af_bella", "am_michael", "bf_emma", "bm_george", "bm_lewis"]
PIPER_DEFAULT = "en_GB-alan-medium"  # male British, the architect 2026-10-22


def _has_kokoro():
    # The Pi has no GPU and no torch (2026-10-21): there the reader speaks with Piper only.
    import importlib.util
    return all(importlib.util.find_spec(m) for m in ("torch", "kokoro"))


HAS_KOKORO = _has_kokoro()
DEFAULT_VOICE = "kokoro:af_heart" if HAS_KOKORO else PIPER_DEFAULT
PORT = int(os.environ.get("PDF_REVIEW_PORT", 18820))

_voices = {}
_voice_lock = threading.Lock()
_state_lock = threading.Lock()
# Marks the open viewer has not saved yet, keyed by the served URL path. The viewer polls
# /api/marks/want and answers with a POST; a reader waits on /api/marks. Loopback only, and the
# answer is dropped once read, so a mark never sits here longer than one question.
_marks = {}
_marks_lock = threading.Lock()
_MARKS_TTL = 30
_origins_lock = threading.Lock()


def load_origins():
    try:
        return json.loads(ORIGINS.read_text())
    except (OSError, ValueError):
        return {}


_kokoro = {}


def kokoro(lang="a"):
    # PyTorch Kokoro on the GPU: ~45x real time on the RTX 3080; CPU only if CUDA is gone.
    with _voice_lock:
        if lang not in _kokoro:
            import torch
            from kokoro import KPipeline
            dev = "cuda" if torch.cuda.is_available() else "cpu"
            _kokoro[lang] = (KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", device=dev), threading.Lock())
        return _kokoro[lang]


def voice(name):
    if not (VOICES_DIR / f"{name}.onnx").is_file():
        name = PIPER_DEFAULT
    with _voice_lock:
        if name not in _voices:
            from piper import PiperVoice
            _voices[name] = (PiperVoice.load(str(VOICES_DIR / f"{name}.onnx")), threading.Lock())
        return _voices[name]


def synthesize(text, name):
    if HAS_KOKORO and name.startswith("kokoro:") and name[7:] in KOKORO_VOICES:
        import numpy as np
        vid = name[7:]
        k, lock = kokoro(vid[0])
        with lock:
            audio = np.concatenate([r.audio.cpu().numpy() for r in k(text, voice=vid) if r.audio is not None])
        rate = 24000
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        return buf.getvalue()
    v, lock = voice(name)
    buf = io.BytesIO()
    with lock, wave.open(buf, "wb") as w:
        v.synthesize_wav(text, w)
    return buf.getvalue()


def load_bookmarks():
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


_history_lock = threading.Lock()


def write_json(path, obj):
    path.parent.mkdir(exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    os.replace(tmp, path)


def load_history():
    try:
        return json.loads(HISTORY.read_text())
    except (OSError, ValueError):
        return {}


def link_pdf(pdf):
    """Link a PDF under papers/open/<hash of its folder>/ (the same place open-pdf uses); its url path."""
    import hashlib
    folder = ROOT / "papers" / "open" / hashlib.sha1(str(pdf.parent).encode()).hexdigest()[:10]
    folder.mkdir(parents=True, exist_ok=True)
    link = folder / pdf.name
    if link.is_symlink():
        if link.resolve() != pdf:
            link.unlink()
    elif link.exists():
        raise RuntimeError(f"{link} is a real file, not a link this viewer made; leaving it alone")
    if not link.is_symlink():
        link.symlink_to(pdf)
    return "/" + link.relative_to(ROOT).as_posix()


def history_list():
    """Every PDF the viewer opened that still exists, newest first. Only links count: a PDF reaches the
    viewer as a link under papers/ (open-pdf, /api/open, a paper put up for review); the real files
    there are the tests' fixtures. A link made before the history was kept counts from its date."""
    with _history_lock:
        h = load_history()
    seen = {}
    for link in (ROOT / "papers").rglob("*.pdf"):
        where = "/" + link.relative_to(ROOT).as_posix()
        try:
            at = h[where]["at"] if where in h else int(link.lstat().st_mtime * 1000)
        except OSError:
            continue
        if not link.is_file():  # a link to a file that is gone
            continue
        if not link.is_symlink():  # a real file under papers/ is a test fixture, not something he opened
            continue
        target = link.resolve()
        prev = seen.get(target)
        if prev is None or at > prev["at"]:
            seen[target] = {"path": where, "name": target.name, "dir": str(target.parent), "at": at}
    return sorted(seen.values(), key=lambda e: -e["at"])


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Without it Chrome reuses a cached viewer.html/autoreload.js without asking, so a viewer
        # change never reaches an open window. no-cache = keep the copy, but revalidate (a cheap 304).
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def _doc(self):
        return (parse_qs(urlparse(self.path).query).get("doc") or [""])[0]

    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/api/voices":
            names = [f"kokoro:{v}" for v in KOKORO_VOICES] if HAS_KOKORO else []
            names += sorted(p.stem for p in VOICES_DIR.glob("*.onnx"))
            return self._json({"default": DEFAULT_VOICE, "voices": names})
        if route == "/api/bookmark":
            return self._json(load_bookmarks().get(self._doc()) or {})
        if route == "/api/marks/want":
            return self._marks_want()
        if route == "/api/marks":
            return self._marks_get()
        if route == "/api/origin":
            return self._origin_get()
        if route == "/api/source":
            return self._source_get()
        if route == "/api/paragraph":
            return self._paragraph_get()
        if route == "/api/history":
            return self._json({"files": history_list()})
        return super().do_GET()

    def _served_path(self):
        # The same check /api/save uses: a URL path under papers/, nothing else.
        rel = unquote((parse_qs(urlparse(self.path).query).get("path") or [""])[0]).lstrip("/")
        link = ROOT / rel
        papers = (ROOT / "papers").resolve()
        if (not rel.startswith("papers/") or ".." in Path(rel).parts or not link.is_file()
                or not link.absolute().is_relative_to(papers)):
            return None
        return "/" + rel

    def _marks_want(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        with _marks_lock:
            entry = _marks.setdefault(where, {"want": 0, "got": None})
            entry["want"] = time.time()
            got = entry["got"] if entry["got"] and time.time() - entry["got"]["at"] < _MARKS_TTL else None
        self._json({"want": True, "have": got is not None})

    def _marks_get(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        with _marks_lock:
            got = (_marks.get(where) or {}).get("got")
            if not got or time.time() - got["at"] >= _MARKS_TTL:
                return self.send_error(404, "no marks yet")
            _marks[where]["got"] = None
        self._json(got["marks"])

    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/api/marks":
            return self._marks_post()
        if route == "/api/origin":
            return self._origin_post()
        if route == "/api/redo":
            return self._redo()
        if route == "/api/reveal":
            return self._reveal()
        if route == "/api/edit":
            return self._edit()
        if route == "/api/paragraph":
            return self._paragraph_post()
        if route == "/api/open":
            return self._open()
        if route == "/api/opened":
            return self._opened()
        if route == "/api/clientlog":
            return self._clientlog()
        if urlparse(self.path).path != "/api/tts":
            return self.send_error(404)
        req = self._body()
        text = " ".join(str(req.get("text", "")).split())
        if not text:
            return self.send_error(400, "empty text")
        audio = synthesize(text, str(req.get("voice") or DEFAULT_VOICE))
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def _clientlog(self):
        # What a viewer sees on its own screen (viewer/web/clientlog.js, 2026-10-22): the phone's WebView
        # failed silently while every desktop test drew fine. One line per event, capped.
        try:
            n = min(int(self.headers.get("Content-Length") or 0), 8000)
            line = self.rfile.read(n).decode("utf-8", "replace").replace("\n", " ")
        except (ValueError, OSError) as e:
            line = f"unreadable: {e}"
        sys.stderr.write(f"CLIENT {time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
        sys.stderr.flush()
        self.send_response(204)
        self.end_headers()

    def _open(self):
        # A PDF link tapped on the phone: link the file under papers/open/ (as open-pdf does on the
        # desktop) and answer the url path the viewer opens. Only a .pdf inside OPEN_ROOTS.
        raw = str(self._body().get("path") or "")
        pdf = Path(unquote(raw[7:]) if raw.startswith("file://") else raw).expanduser().resolve()
        if pdf.suffix.lower() != ".pdf" or not pdf.is_file():
            return self._json({"error": f"not a PDF on disk: {pdf}"}, 404)
        if not any(pdf.is_relative_to(r) for r in OPEN_ROOTS):
            return self._json({"error": f"outside the folders the viewer may open: {pdf}"}, 403)
        try:
            where = link_pdf(pdf)
        except RuntimeError as err:
            return self._json({"error": str(err)}, 409)
        self._json({"path": where, "name": pdf.name})

    def _opened(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        link = ROOT / where.lstrip("/")
        if not link.is_symlink():  # a real file under papers/ is a test fixture: not a read of the architect's
            return self._json({"ok": True, "recorded": False})
        with _history_lock:
            h = {k: v for k, v in load_history().items() if (ROOT / k.lstrip("/")).is_file()}
            h[where] = {"file": str(link.resolve()), "at": int(time.time() * 1000)}
            write_json(HISTORY, h)
        self._json({"ok": True, "recorded": True})

    def _origin_get(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        with _origins_lock:
            session = load_origins().get(where)
        if not session:
            return self.send_error(404, "no chat recorded for this file")
        self._json({"session": session})

    def _origin_post(self):
        # A chat registers itself as the maker of a file, so the viewer's Redo button knows which
        # chat to wake. Loopback only, and only for a file served from papers/.
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        session = str(self._body().get("session") or "").strip()
        if not session:
            return self.send_error(400, "no session")
        if ":fractal:" in session or ":cron:" in session:
            # A background reflection or cron opening the file must not steal Redo from the architect's chat (2026-10-23).
            return self._json({"ok": False, "ignored": "background session"})
        with _origins_lock:
            origins = load_origins()
            origins[where] = session
            ORIGINS.parent.mkdir(exist_ok=True)
            tmp = ORIGINS.with_suffix(".tmp")
            tmp.write_text(json.dumps(origins, ensure_ascii=False, indent=1))
            os.replace(tmp, ORIGINS)
        self._json({"ok": True})

    def _source_target(self):
        where = self._served_path()
        if not where:
            return None
        md = (ROOT / where.lstrip("/")).resolve().with_suffix(".md")
        return md if md.is_file() else None

    def _source_get(self):
        # The viewer shows ✏️ Edit text only when the PDF has a sibling .md it is built from.
        md = self._source_target()
        self._json({"has": bool(md), "path": str(md) if md else None})

    # ---- ✏️ Edit text: pick a paragraph in the viewer, edit it in a popup (2026-10-16) -----------------
    @staticmethod
    def _md_split(text):
        # Units are paragraphs, and each list item on its own. Separators are kept so a join restores
        # the file exactly: parts = [unit, sep, unit, sep, ...].
        import re
        return re.split(r"(\n\n|\n(?=[-*] |\d+\. ))", text)

    @classmethod
    def _md_blocks(cls, text):
        return cls._md_split(text)[0::2]

    @staticmethod
    def _letters(t):
        import re
        t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)          # images
        t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)        # links -> their text
        t = re.sub(r"<[^>]+>", " ", t)                          # html tags
        return re.sub(r"[^a-z0-9]", "", t.lower())

    def _paragraph_get(self):
        # The viewer sends the text under the click; answer with the source block that contains it.
        import difflib
        md = self._source_target()
        if not md:
            return self._json({"error": "this PDF has no .md source next to it"}, 404)
        q = self._letters(unquote((parse_qs(urlparse(self.path).query).get("q") or [""])[0]))
        if len(q) < 6:
            return self._json({"error": "click on a line of text"}, 400)
        blocks = self._md_blocks(md.read_text(encoding="utf-8"))
        best, score = None, 0
        for i, b in enumerate(blocks):
            lb = self._letters(b)
            if not lb:
                continue
            m = difflib.SequenceMatcher(None, q, lb, autojunk=False).find_longest_match(0, len(q), 0, len(lb))
            if m.size > score:
                best, score = i, m.size
        if best is None or score < min(12, len(q) * 0.6):
            return self._json({"error": "no matching paragraph found"}, 404)
        self._json({"index": best, "text": blocks[best], "score": score})

    def _paragraph_post(self):
        # Replace one block of the source. Refuses if the block changed since it was shown.
        md = self._source_target()
        if not md:
            return self._json({"error": "this PDF has no .md source next to it"}, 404)
        req = self._body()
        parts = self._md_split(md.read_text(encoding="utf-8"))
        blocks = parts[0::2]
        i = req.get("index")
        if not isinstance(i, int) or not (0 <= i < len(blocks)) or blocks[i] != req.get("old"):
            return self._json({"error": "the paragraph changed meanwhile; pick it again"}, 409)
        new = str(req.get("new", "")).strip("\n")
        if not new.strip():
            return self._json({"error": "empty paragraph; delete it in the source instead"}, 400)
        parts[2 * i] = new.replace("\n\n", "\n")  # one unit stays one unit
        tmp = md.with_suffix(".md.tmp")
        tmp.write_text("".join(parts), encoding="utf-8")
        os.replace(tmp, md)
        # His own edit: rebuild now, keeping his marks (the watcher then sees the PDF is newer and skips it).
        pdf = md.with_suffix(".pdf")
        import subprocess
        pdf.with_name(pdf.stem + "-before-edit.pdf").write_bytes(pdf.read_bytes())
        r = subprocess.run(["python3", str(ROOT / "md2pdf.py"), str(md), str(pdf), "--keep-marks"],
                           capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            return self._json({"error": f"rebuild failed: {r.stderr[-300:]}"}, 500)
        self._json({"ok": True})

    def _edit(self):
        # ✏️ Edit text: open the PDF's Markdown source in the desktop's editor. Saving it rebuilds the
        # PDF (watch_sources below) and the open viewer reloads it (2026-10-16).
        md = self._source_target()
        if not md:
            return self._json({"error": "this PDF has no .md source next to it"}, 404)
        import subprocess
        try:
            subprocess.Popen(["gio", "open", str(md)], start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as err:
            return self._json({"error": f"no editor: {err}"}, 500)
        self._json({"ok": True, "path": str(md)})

    def _reveal(self):
        # 📂 Folder: open the file manager on the real file (the papers/ link followed), with it
        # selected, so the architect can move, rename or copy it (2026-10-16, replacing the Save buttons).
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        target = (ROOT / where.lstrip("/")).resolve()
        import subprocess
        shown = subprocess.run(
            ["dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.FileManager1",
             "--type=method_call", "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems",
             f"array:string:{target.as_uri()}", "string:"],
            capture_output=True, text=True, timeout=10,
        ).returncode == 0
        if not shown:
            try:
                subprocess.Popen(["nautilus", "--select", str(target)], start_new_session=True,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError as err:
                return self._json({"error": f"no file manager: {err}"}, 500)
        self._json({"ok": True, "path": str(target)})

    def _redo(self):
        # Wake the chat that made this file and tell it to read the comments and redo the document.
        # The wake goes through longjob, the same path a finished job uses to report back.
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        with _origins_lock:
            session = load_origins().get(where)
        if not session:
            return self._json({"error": "no chat recorded for this file"}, 409)
        target = (ROOT / where.lstrip("/")).resolve()
        text = (
            f"[pdf-review] Apply comments pressed on {target.name} at {time.strftime('%H:%M')}. "
            f"The comments are saved in {target}. First copy it aside as the next FREE '<name>-marques-oscar-N.pdf' "
            f"(never overwrite an existing copy), then run "
            f"python3 {ROOT}/pdf-comments.py '{target}', apply every comment to the source and "
            f"rebuild the PDF OVER THIS SAME FILE ({target}) with "
            f"python3 {ROOT}/md2pdf.py <source.md> '{target}' (no flag: it rebuilds clean), so the open viewer "
            f"reloads it with no processed comment left on it. Never pass --keep-marks here. A comment you could not apply: name it in the chat. "
            f"A mark with NO text (a bare ink '?', a circle): do not guess an edit and do not rebuild; ask what it means "
            f"(2026-10-23: a guessed edit on a bare '?' was undone, and the rebuild wiped comments still being typed). "
            f"Right before rebuilding, compare the PDF's mtime with your copy; newer = the architect saved again, re-read the comments first. "
            f"After rebuilding, wait ~15 s and confirm with pdftotext that the PDF still holds your edit: an open viewer once saved its stale copy over a rebuild (2026-10-23 11:54, fixed 8421563). "
            f"Raw annotations: {ROOT}/.venv/bin/python (system python has no PyMuPDF). Update the PDF only: "
            f"no website, no other files, no publishing, until the architect says so."
        )
        APPLYING.mkdir(parents=True, exist_ok=True)
        (APPLYING / (target.name + ".flag")).write_text(time.strftime("%F %T"))  # the watcher leaves this PDF to the agent
        import subprocess
        cmd = ["node", str(Path.home() / ".claude/skills/longjob/scripts/longjob.mjs"), "run",
               "--id", f"pdfredo-{time.strftime('%m%d-%H%M%S')}", "--label", "Apply PDF comments",
               "--session", session, "--cmd", "true", "--wake-text", text]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as err:
            return self._json({"error": str(err)}, 500)
        if r.returncode != 0:
            return self._json({"error": (r.stderr or "wake failed").strip()[:300]}, 500)
        self.log_message("redo %s -> %s", target.name, session)
        self._json({"ok": True})

    def _marks_post(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        with _marks_lock:
            _marks.setdefault(where, {"want": 0, "got": None})["got"] = {
                "at": time.time(), "marks": self._body()
            }
        self._json({"ok": True})

    def _save(self):
        # Only a PDF reached through a link under papers/ is written, and it is written where the link
        # points (the original file), replaced atomically so a reader never sees half a file.
        rel = unquote((parse_qs(urlparse(self.path).query).get("path") or [""])[0]).lstrip("/")
        link = (ROOT / rel)
        papers = (ROOT / "papers").resolve()
        if not rel.startswith("papers/") or ".." in Path(rel).parts or not link.is_file():
            return self.send_error(404, "not a served paper")
        if not link.absolute().is_relative_to(papers):
            return self.send_error(403)
        target = link.resolve()
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if target.suffix.lower() != ".pdf" or not data.startswith(b"%PDF-"):
            return self.send_error(400, "not a PDF")
        fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".saving", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.chmod(tmp, target.stat().st_mode & 0o777)
            os.replace(tmp, target)
        except OSError as err:
            Path(tmp).unlink(missing_ok=True)
            return self.send_error(500, str(err))
        self.log_message("saved %s (%d bytes)", target, len(data))
        self._json({"ok": True, "bytes": len(data), "file": str(target)})

    def do_PUT(self):
        if urlparse(self.path).path == "/api/save":
            return self._save()
        doc = self._doc()
        if urlparse(self.path).path != "/api/bookmark" or not doc:
            return self.send_error(404)
        mark = self._body()
        with _state_lock:
            marks = load_bookmarks()
            marks[doc] = mark
            STATE.parent.mkdir(exist_ok=True)
            tmp = STATE.with_suffix(".tmp")
            tmp.write_text(json.dumps(marks, ensure_ascii=False, indent=1))
            os.replace(tmp, STATE)
        self._json({"ok": True})

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/bookmark"):
            super().log_message(fmt, *args)


def watch_sources():
    """Rebuild a reviewed PDF when its sibling .md is newer: the architect edited the text himself, so his marks are kept.
    Skipped while an Apply-comments flag is up (state/applying/): then the agent rebuilds clean (2026-10-16)."""
    import subprocess
    while True:
        try:
            for link in (ROOT / "papers").rglob("*.pdf"):
                try:
                    pdf = link.resolve()
                    md = pdf.with_suffix(".md")
                    if md.is_file() and pdf.is_file() and md.stat().st_mtime > pdf.stat().st_mtime + 1:
                        flag = APPLYING / (pdf.name + ".flag")
                        if flag.is_file() and time.time() - flag.stat().st_mtime < APPLYING_TTL:
                            continue  # Apply comments is running: the agent rebuilds clean itself
                        # Keep the current PDF (and any comment marks in it) before the rebuild replaces it.
                        pdf.with_name(pdf.stem + "-before-edit.pdf").write_bytes(pdf.read_bytes())
                        r = subprocess.run(["python3", str(ROOT / "md2pdf.py"), str(md), str(pdf), "--keep-marks"],
                                           capture_output=True, text=True, timeout=180)
                        print(f"[md2pdf] {md.name} -> {pdf.name}: {'ok' if r.returncode == 0 else r.stderr[-300:]}", flush=True)
                except OSError:
                    continue
        except Exception as err:  # never let the watcher die
            print(f"[md2pdf] watcher error: {err}", flush=True)
        time.sleep(2)


if __name__ == "__main__":
    if HAS_KOKORO:
        threading.Thread(target=lambda: [kokoro(l) for l in "ab"], daemon=True).start()
    threading.Thread(target=watch_sources, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(ROOT))).serve_forever()
