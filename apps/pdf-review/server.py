#!/usr/bin/env python3
"""Loopback server for pdf-review: the viewer files, plus three small endpoints.

  GET  /api/voices               installed Piper voices
  POST /api/tts {text, voice}    one sentence as WAV, synthesised offline by Piper
  GET  /api/bookmark?doc=<id>    where the reader stopped in that document
  PUT  /api/bookmark?doc=<id>    save it (body: JSON)
  PUT  /api/save?path=<url path> overwrite the original PDF behind a papers/ link (body: the PDF). With base=<version>
                                 and X-Made-Length (+ X-Since-Length) a file that moved on gets the marks carried
                                 onto it instead; a refused body is kept under state/refused/ (pdf-refused.py)
  GET  /api/caps                 what /api/save understands, for a viewer newer than this server
       &base=<signature>              ...only if the file is still that version; else 409, or with
                                      X-Base-Length the body is base PDF + marked PDF and the marks
                                      added since base are carried onto the newer file (offline sync)
       &keep=<n>&len=<total>&crc=<hex>  ...the body is only what follows the first n bytes of the file
                                      here; 422 when that does not rebuild a file of that length and crc32
  GET  /api/folder?path=<url path>   every PDF beside that one, linked and served, with its version (fetch ahead)
  POST /api/delta?path=<url path>    body: the chunk table of the caller's copy; answer: how to rebuild the
                                      file here from that copy (copy ranges + the new bytes), see build_delta
  GET  /api/watch?path=<url path>&sig=<signature>&wait=<s>  answers when the file is no longer that version
                                      or someone wants the open viewer's marks, else after the wait
  GET  /api/offline-manifest         the viewer's files, for the service worker (sw.js)
  GET  /api/marks/want?path=<url path>  ask the open viewer to hand over its unsaved marks
  GET  /api/marks?path=<url path>        those marks, once the viewer has answered (404 until then)
  POST /api/origin?path=<url path>  record which chat made this file (body: {"session": "..."})
  GET  /api/origin?path=<url path>   whether a chat is recorded (200 yes, 404 no)
  POST /api/redo?path=<url path>     wake that chat: read the comments and redo the document
  POST /api/open {path}              link a PDF on disk under papers/open/ and answer its url path
  POST /api/opened?path=<url path>   the viewer opened this file: put it at the top of the history
  GET  /api/history                  every PDF opened with the viewer that still exists, newest first; `blue` = how
                                      many paragraphs wait for ✓ Approve, where already known (never scanned here)
  GET  /api/blue?path=<url path>&path=…  {blue: {path: n}}: paragraphs waiting for ✓ Approve in each file, scanned
                                      when not known yet (the 🕘 Recent list paints those names blue)
  GET  /api/books                    every PDF in the book folders (~/.config/pdf-review/books), opened or not, sorted
                                      by name, each with its kind (chapters, notes, marked, earlier, backups) and its
                                      url path once linked: the book tabs beside 🕘 Recent
  POST /api/hide?path=<url path>     take that file off the history list (opening it again brings it back)
  POST /api/trash?path=<url path>    move the PDF behind that link to the trash (~/.local/share/Trash, restorable)
  GET  /api/source?path=<url path>&text=1   the .md a PDF is built from, and each block's words as they show (vis)
  POST /api/paragraph?path=<url path>  replace one block of that .md (the ✏️ writer and the Markdown box); the
                                      PDF is rebuilt in the background (Builder), the answer comes at once
  GET  /api/built?path=<url path>    which version of the .md the PDF on disk was built from, and whether a
                                      build is due: the open viewer swaps the new file in only when it holds
                                      every edit it typed
  GET  /api/approve?path=<url path>  the paragraphs that print blue (new text he has not approved), each with its
                                      .md block and where its last line ends: the viewer's ✓ Approve buttons
  POST /api/approve?path=<url path>  {index, old}: he has read that paragraph. It goes into the approved text its
                                      build paints by (<folder>/.approved/<name>.md), or its nw marker comes off;
                                      the PDF is rebuilt in the background and prints it black.
                                      {items: [{index, old}, ...]}: ✓ Approve all, every one in one request and one
                                      rebuild; answers which were approved, which had changed meanwhile, and an
                                      undo token. {undo: token}: puts the .md and the approved text back as they
                                      were before that Approve all, if nothing changed them since
  GET  /viewer/web/fonts/<name>.ttf  a font installed here, by PostScript name: the writer types in the PDF's own face

Bookmarks live in state/bookmarks.json, keyed by the PDF's fingerprint, so a
renamed or moved copy of the same file still finds its place.
"""
import datetime
import email.utils
import gzip
import io
import json
import os
import re
import struct
import sys
import threading
import time
import wave
import zlib
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdflock import file_lock  # noqa: E402  one lock per PDF, shared with md2pdf.py

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state" / "bookmarks.json"
APPLYING = ROOT / "state" / "applying"  # <pdf name>.flag: Apply comments pressed, an agent owns the next rebuild
APPLYING_TTL = 30 * 60  # a flag older than this is ignored, so a chat that never rebuilt cannot block his edits
ORIGINS = ROOT / "state" / "origins.json"
# PDF_REVIEW_STATE: a test server's own folder for the files below, so its edits never reach his journal.
TEXT_STATE = Path(os.environ.get("PDF_REVIEW_STATE") or ROOT / "state")
EDIT_DRAFTS = TEXT_STATE / "edit-drafts.json"  # real pdf path -> the Edit paragraph box left open: index, old, text, caret, at
EDIT_JOURNAL = TEXT_STATE / "edit-journal.jsonl"  # every saved paragraph edit, old and new block: what he changed, in order
# Every upload or paragraph edit this server refused (409, 422, a failed carry): the body as sent plus a .json beside
# it, so a refusal never throws his marks or his words away (2026-11-15). pdf-refused.py lists and recovers them.
REFUSED = TEXT_STATE / "refused"
REFUSED_DAYS = 30  # older ones are removed when a new one is kept
BUILT_FROM = TEXT_STATE / "built-from.json"  # real pdf path -> {md, pdf}: the .md version (mtime_ns) each PDF was built from
HISTORY = ROOT / "state" / "history.json"  # url path -> {file, at}: what the viewer opened, for the phone's list
HIDDEN = ROOT / "state" / "hidden.json"  # real file -> ms it was taken off the list; a later open shows it again
# The book folders (2026-11-19, need: every PDF of the books at hand, opened or not, by kind and by name): one folder
# per line (~ allowed, a line starting with # is a comment), read at each request. PDF_REVIEW_BOOKS (":"-separated):
# the tests' own folders instead; a test server without it has none. None set up: the 🕘 Recent dialog has no book tabs.
BOOKS_CONF = Path.home() / ".config" / "pdf-review" / "books"
# The freedesktop trash, so a file manager can put a deleted PDF back (2026-10-27). PDF_REVIEW_TRASH: the tests' own.
TRASH = Path(os.environ.get("PDF_REVIEW_TRASH") or Path.home() / ".local/share/Trash")
# /api/open serves a PDF from these folders only (the same roots Tinker's file links may open).
# PDF_REVIEW_OPEN_ROOTS (":"-separated): the tests' own folders instead.
OPEN_ROOTS = ([Path(r) for r in os.environ["PDF_REVIEW_OPEN_ROOTS"].split(":") if r] if os.environ.get("PDF_REVIEW_OPEN_ROOTS")
              else [Path.home() / d for d in ("Documents", "Downloads", "Desktop", "Pictures", "src", ".openclaw")])
# The server rebuilds a PDF from its .md, and so runs a build*.sh beside it (md2pdf.py), only inside these: his
# own document folders. A PDF opened from Downloads, a mail attachment or /tmp is someone else's folder; its
# .md and build*.sh are never run (burn review 2026-11-13 F1). PDF_REVIEW_BUILD_ROOTS (":"-separated), else a
# test server's own PDF_REVIEW_OPEN_ROOTS, else ~/Documents.
BUILD_ROOTS = [Path(r).resolve() for r in (os.environ.get("PDF_REVIEW_BUILD_ROOTS") or os.environ.get("PDF_REVIEW_OPEN_ROOTS")
                                            or str(Path.home() / "Documents")).split(":") if r]


def rebuilds_here(pdf):
    """True for a PDF (its real path) whose .md this server may rebuild it from."""
    return any(Path(pdf).is_relative_to(r) for r in BUILD_ROOTS)
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


def open_link(pdf):
    """Where a PDF's link goes: papers/open/<hash of its folder>/<name> (the same place open-pdf uses)."""
    import hashlib
    return ROOT / "papers" / "open" / hashlib.sha1(str(pdf.parent).encode()).hexdigest()[:10] / pdf.name


def link_pdf(pdf):
    """Link a PDF under papers/open/<hash of its folder>/ (the same place open-pdf uses); its url path."""
    link = open_link(pdf)
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        if link.resolve() != pdf:
            link.unlink()
    elif link.exists():
        raise RuntimeError(f"{link} is a real file, not a link this viewer made; leaving it alone")
    if not link.is_symlink():
        link.symlink_to(pdf)
    return "/" + link.relative_to(ROOT).as_posix()


def load_hidden():
    try:
        return json.loads(HIDDEN.read_text())
    except (OSError, ValueError):
        return {}


def trash(pdf):
    """Move a file into the freedesktop trash with its .trashinfo (original path, date): restorable from any file
    manager. Answers where it went."""
    import shutil
    from urllib.parse import quote
    files, info = TRASH / "files", TRASH / "info"
    files.mkdir(parents=True, exist_ok=True)
    info.mkdir(parents=True, exist_ok=True)
    name, n = pdf.name, 1
    while (files / name).exists() or (info / f"{name}.trashinfo").exists():
        name, n = f"{pdf.stem}.{n}{pdf.suffix}", n + 1
    (info / f"{name}.trashinfo").write_text(
        f"[Trash Info]\nPath={quote(str(pdf))}\nDeletionDate={time.strftime('%Y-%m-%dT%H:%M:%S')}\n")
    shutil.move(str(pdf), str(files / name))
    return files / name


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
        # 2026-11-12: /api/folder refuses a folder outside OPEN_ROOTS, so a link made by hand to a test's
        # file in /tmp was listed, and every reader start then failed to keep its folder.
        if not any(target.is_relative_to(r) for r in OPEN_ROOTS):
            continue
        prev = seen.get(target)
        if prev is None or at > prev["at"]:
            seen[target] = {"path": where, "name": target.name, "dir": str(target.parent), "at": at}
    hidden = load_hidden()  # taken off the list by a long press, unless opened again since
    return sorted((e for t, e in seen.items() if hidden.get(str(t), 0) < e["at"]), key=lambda e: -e["at"])


def book_roots():
    """The book folders that exist: PDF_REVIEW_BOOKS, else none on a test server (its own PDF_REVIEW_OPEN_ROOTS),
    else BOOKS_CONF."""
    if os.environ.get("PDF_REVIEW_BOOKS") is not None:
        lines = os.environ["PDF_REVIEW_BOOKS"].split(":")
    elif os.environ.get("PDF_REVIEW_OPEN_ROOTS"):
        return []
    else:
        try:
            lines = BOOKS_CONF.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
    roots = []
    for line in (raw.strip() for raw in lines):
        if not line or line.startswith("#"):
            continue
        folder = Path(line).expanduser().resolve()
        if folder.is_dir() and folder not in roots:
            roots.append(folder)
    return roots


def book_kind(rel):
    """The book tab a PDF goes in, from its path inside the book folder: a copy under a backup* folder, a marked copy
    kept before an Apply round (-marques-oscar-N), the build before a text edit (-before-edit), a chapter (in a folder
    named chapters), or one of the book's other documents."""
    if any(part.lower().startswith("backup") for part in rel.parts[:-1]):
        return "backups"
    if re.search(r"-marques-oscar-\d+$", rel.stem):
        return "marked"
    if rel.stem.endswith("-before-edit"):
        return "earlier"
    if rel.parent.name.lower() == "chapters":
        return "chapters"
    return "notes"


def by_name(name):
    """Sort key for a file name: letters without case, numbers by value (ch2 before ch10, -oscar-9 before -oscar-10),
    a file before its own copies (ch01.pdf, then ch01-before-edit.pdf)."""
    stem, _, ext = name.casefold().rpartition(".")
    parts = re.split(r"(\d+)", stem or ext)
    return [int(p) if i % 2 else p for i, p in enumerate(parts)], ext


def book_list():
    """Every PDF under the book folders, opened or not, sorted by name; one name in several folders (the backups):
    the newest backup first. path: its url path when the link /api/open would make exists already, else None (the
    dialog links it when he taps it). Nothing is linked here, so the 🕘 Recent list does not change."""
    out = []
    for root in book_roots():
        for folder, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".")]  # .approved/ and the like
            for name in names:
                if name.startswith(".") or not name.lower().endswith(".pdf"):
                    continue
                pdf = Path(folder) / name
                try:
                    at = int(pdf.stat().st_mtime * 1000)
                except OSError:  # a link to a file that is gone
                    continue
                rel = pdf.relative_to(root)
                link = open_link(pdf)
                linked = link.is_symlink() and link.resolve() == pdf.resolve()
                out.append({"kind": book_kind(rel), "name": name, "file": str(pdf),
                            "dir": (Path(root.name) / rel.parent).as_posix(),
                            "path": "/" + link.relative_to(ROOT).as_posix() if linked else None, "at": at})
    out.sort(key=lambda f: f["dir"], reverse=True)  # backup folders start with their date: the newest first
    out.sort(key=lambda f: by_name(f["name"]))
    return out


def signature(path, date_time_string):
    """The file's version as the viewer sees it on a HEAD: "<Last-Modified>|<Content-Length>"."""
    st = path.stat()
    return f"{date_time_string(st.st_mtime)}|{st.st_size}"


# ---- less data on the wire (2026-11-11) ------------------------------------------------------------
# A rebuilt PDF is mostly the old one: the pictures, the fonts and the untouched pages are the same
# bytes at other offsets. Both sides cut a file after each "endstream", "endobj" or "stream" + newline
# (a cut is accepted when the chunk is at least MIN_CHUNK long). The device sends length, crc32 and
# adler32 of each chunk of its copy; the answer says which ranges of that copy to reuse and carries
# only the rest. The device checks the rebuilt file's crc32, so a wrong match can never be kept.
# viewer/web/delta.js holds the same cut rule: change both or neither.
_CUT = re.compile(rb"endstream|endobj|stream\r?\n")
MIN_CHUNK = 32


def pdf_chunks(data):
    p = 0
    for m in _CUT.finditer(data):
        e = m.end()
        if e - p >= MIN_CHUNK:
            yield p, e
            p = e
    if p < len(data):
        yield p, len(data)


def build_delta(table, new):
    """table: (length, crc32, adler32) of each chunk of the caller's copy, flat. Answer: "PDL1", the new
    length, its crc32, the step count, then steps: 0 + offset + length (reuse that range of your copy)
    or 1 + length + bytes (new data). All little endian, 32 bit."""
    have, off = {}, 0
    for i in range(0, len(table) - 2, 3):
        have.setdefault((table[i], table[i + 1], table[i + 2]), off)
        off += table[i]
    steps, fresh = [], bytearray()
    for s, e in pdf_chunks(new):
        piece = new[s:e]
        at = have.get((e - s, zlib.crc32(piece), zlib.adler32(piece)))
        if at is None:
            fresh += piece
            continue
        if fresh:
            steps.append((1, bytes(fresh)))
            fresh = bytearray()
        if steps and steps[-1][0] == 0 and steps[-1][1] + steps[-1][2] == at:
            steps[-1] = (0, steps[-1][1], steps[-1][2] + e - s)
        else:
            steps.append((0, at, e - s))
    if fresh:
        steps.append((1, bytes(fresh)))
    out = [struct.pack("<4sIII", b"PDL1", len(new), zlib.crc32(new), len(steps))]
    for st in steps:
        out.append(struct.pack("<BII", 0, st[1], st[2]) if st[0] == 0 else struct.pack("<BI", 1, len(st[1])) + st[1])
    return b"".join(out)


# The viewer's own files are text that shrinks to a third (6.8 MB -> 2.1 MB for the offline copy the
# phone installs). Compressed once per file version and kept in memory. Never a PDF: its Content-Length
# is half of the version signature the viewer compares.
_GZ_TYPES = {".mjs", ".js", ".css", ".html", ".json", ".ftl", ".svg", ".wasm", ".txt", ".properties"}
_gz_cache = {}
_gz_lock = threading.Lock()
WATCH_MAX = 50  # seconds one /api/watch may wait
WANT_SECS = 10  # how long a request for the viewer's marks stays open


def gz_file(path, st):
    key = str(path)
    with _gz_lock:
        hit = _gz_cache.get(key)
        if hit and hit[0] == (st.st_mtime_ns, st.st_size):
            return hit[1]
    body = gzip.compress(path.read_bytes(), 6)
    with _gz_lock:
        _gz_cache[key] = ((st.st_mtime_ns, st.st_size), body)
    return body


def offline_manifest():
    """What the service worker keeps so the viewer opens with no network: the viewer and pdf.js files,
    without source maps, the sample PDF, CJK maps and the other languages (fetched and kept when used)."""
    out = []
    for top in ("viewer/web", "viewer/build"):
        for f in sorted((ROOT / top).rglob("*")):
            rel = f.relative_to(ROOT).as_posix()
            if not f.is_file() or f.suffix == ".map" or f.suffix == ".pdf" or "/cmaps/" in rel:
                continue
            if "/locale/" in rel and not ("/locale/en-US/" in rel or rel.endswith("locale.json")):
                continue
            out.append("/" + rel)
    out += [f"/viewer/web/fonts/{n}.ttf" for n in PRINT_FONTS if (font_path(n) or "").lower().endswith(".ttf")]
    return out


# ---- ✏️ the writer (2026-11-15) -----------------------------------------------------------------------
# He types into a paragraph on the page (viewer/web/writer.js); viewer/web/mdmap.js turns that into a change of
# the .md block. The words a block shows, as Python-Markdown renders it, are the referee: the viewer edits only
# blocks whose words it reads the same way, and a save is written only when the new block shows exactly the
# words he typed.
_BLOCK_TAGS = {"p", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "div", "br", "tr", "td",
               "th", "table", "pre", "hr", "dt", "dd", "dl", "figure", "figcaption"}


def vis_norm(t):
    import unicodedata
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", t)).strip()


def md_visible(text):
    """A Markdown block's words as they show once rendered: tags, pictures and markers gone, whitespace one space."""
    import markdown
    from html.parser import HTMLParser
    out = []

    class Text(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag in _BLOCK_TAGS:
                out.append(" ")

        def handle_endtag(self, tag):
            if tag in _BLOCK_TAGS:
                out.append(" ")

        def handle_data(self, data):
            out.append(data)

    p = Text(convert_charrefs=True)
    p.feed(markdown.markdown(text, extensions=["extra"]))
    p.close()
    return vis_norm("".join(out))


_vis_cache = {}  # md path -> (mtime_ns, [words of each block])
_vis_lock = threading.Lock()


def blocks_visible(md, text, blocks):
    st = md.stat().st_mtime_ns
    with _vis_lock:
        hit = _vis_cache.get(str(md))
        if hit and hit[0] == st and len(hit[1]) == len(blocks):
            return hit[1]
    vis = []
    for b in blocks:
        try:
            vis.append(md_visible(b))
        except Exception:  # a block Python-Markdown chokes on is simply not editable in place
            vis.append(None)
    with _vis_lock:
        _vis_cache[str(md)] = (st, vis)
    return vis


_fonts = None


def font_path(name):
    """The file of an installed font, by PostScript name (as a PDF names it: "DejaVuSerif-Bold")."""
    global _fonts
    if _fonts is None:
        import subprocess
        try:
            out = subprocess.run(["fc-list", "-f", "%{postscriptname}\t%{file}\n"], capture_output=True, text=True,
                                 timeout=20).stdout
        except (OSError, subprocess.TimeoutExpired):
            out = ""
        found = {}
        for line in out.splitlines():
            ps, _, f = line.partition("\t")
            if ps and f.lower().endswith((".ttf", ".otf")) and f.startswith(("/usr/share/fonts/", "/usr/local/share/fonts/")):
                found.setdefault(ps, f)
        _fonts = found
    return _fonts.get(name)


# The faces md2pdf's pages are printed in: kept on the phone with the viewer, so writing works offline too.
PRINT_FONTS = ["DejaVuSerif", "DejaVuSerif-Bold", "DejaVuSerif-Italic", "DejaVuSerif-BoldItalic", "LiberationMono"]


class Builder:
    """Rebuilds a PDF from its .md in the background (2026-11-15). Before, a paragraph save waited for the whole
    build (a cold Chromium, PyMuPDF, the marks carried: 5 to 8 s on the Pi) behind a frozen page, and the 2 s
    watcher could start a second build of the same file meanwhile. Now a save answers at once; the build runs
    QUIET seconds after the file's last edit (a run of edits is one build), one build at a time, never two of
    one file; an edit that lands during a build makes one more build after it."""
    QUIET = 0.6

    def __init__(self):
        self.cv = threading.Condition()
        self.dirty = {}  # real pdf path -> time of its last edit
        self.building = None
        try:
            self.built = json.loads(BUILT_FROM.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.built = {}

    def mark(self, pdf):
        with self.cv:
            self.dirty[str(pdf)] = time.time()
            self.cv.notify_all()

    def busy(self, pdf):
        with self.cv:
            return str(pdf) in self.dirty or self.building == str(pdf)

    def stamp(self, pdf):
        """(the .md mtime_ns the PDF on disk holds, or None when unknown; a build is due or running)."""
        k = str(pdf)
        with self.cv:
            rec, due = self.built.get(k), (k in self.dirty or self.building == k)
        try:
            md_ns, pdf_ns = Path(pdf).with_suffix(".md").stat().st_mtime_ns, Path(pdf).stat().st_mtime_ns
        except OSError:
            return None, due
        if rec and rec.get("pdf") == pdf_ns:
            return rec.get("md"), due
        # Built by someone else (an Apply round, a build script by hand): a PDF newer than its .md holds it.
        return (md_ns if pdf_ns > md_ns else None), due

    def run(self):
        while True:
            with self.cv:
                while True:
                    now = time.time()
                    due = [k for k, t in self.dirty.items() if now - t >= self.QUIET]
                    if due:
                        key = min(due, key=self.dirty.get)
                        del self.dirty[key]
                        self.building = key
                        break
                    self.cv.wait(timeout=min((self.QUIET - (now - t) for t in self.dirty.values()), default=None))
            try:
                self._build(Path(key))
            except Exception as err:  # never let the builder die
                print(f"[md2pdf] build error {key}: {err}", flush=True)
            finally:
                with self.cv:
                    self.building = None
                    self.cv.notify_all()

    def _build(self, pdf):
        import subprocess
        md = pdf.with_suffix(".md")
        if not md.is_file() or not rebuilds_here(pdf):
            return
        flag = APPLYING / (pdf.name + ".flag")
        if flag.is_file() and time.time() - flag.stat().st_mtime < APPLYING_TTL:
            return  # Apply comments is running: the agent rebuilds clean itself (the watcher marks it again after)
        md_ns = md.stat().st_mtime_ns
        if pdf.is_file():  # keep the current PDF (and any comment marks in it) before the rebuild replaces it
            pdf.with_name(pdf.stem + "-before-edit.pdf").write_bytes(pdf.read_bytes())
        t0 = time.time()
        r = subprocess.run(["python3", str(ROOT / "md2pdf.py"), str(md), str(pdf), "--keep-marks"],
                           capture_output=True, text=True, timeout=180)
        print(f"[md2pdf] {md.name} -> {pdf.name}: {'ok' if r.returncode == 0 else r.stderr[-300:]} "
              f"({time.time() - t0:.1f} s)", flush=True)
        if r.returncode != 0 or not pdf.is_file():
            return
        with self.cv:
            self.built[str(pdf)] = {"md": md_ns, "pdf": pdf.stat().st_mtime_ns}
            try:
                BUILT_FROM.parent.mkdir(parents=True, exist_ok=True)
                tmp = BUILT_FROM.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(self.built, indent=1), encoding="utf-8")
                os.replace(tmp, BUILT_FROM)
            except OSError as err:
                print(f"[md2pdf] recording the build failed: {err}", flush=True)


BUILDER = Builder()


# ---- ✓ Approve: a blue paragraph stays blue until he approves it (2026-11-15) ------------------------------------
# Rule (2026-11-15 14:38): a paragraph that goes blue never turns black again on its own. An approve button at the end
# of the paragraph does that, so no change goes unread.
# A paragraph prints blue (NEW_RGB, md2pdf.py's .nw rule) in one of two ways, and Approve undoes each:
#  - its build paints what is not in the .md's approved text, <folder>/.approved/<name>.md (the book chapters,
#    book1/bible/assemble.py). Approve adds the paragraph to that file; his own edits are added as he saves them.
#  - the .md marks it, <span class="nw"> or <div class="nw" markdown="1">. Approve takes the marker off that
#    paragraph alone (a wrapping div is closed before it and opened again after it).
# GET /api/approve finds the paragraphs that print blue: the PDF's span colours, each line's letters matched in order
# to the .md blocks, and where each blue block's last line ends; the viewer draws the button there (approve.js).
NEW_RGB = 0x1E90FF  # the .nw rule in md2pdf.py (pdf-colours.py NEW)
APPROVE_JOURNAL = TEXT_STATE / "approve-journal.jsonl"  # every approval: when, which PDF, which paragraph, how
MD_SPLIT = re.compile(r"(\n\n|\n(?=[-*] |\d+\. ))")  # the .md's units: paragraphs, and each list item on its own
_NW_TAG = re.compile(r"</?(span|div)\b[^>]*>", re.I)
_NW_OPEN = re.compile(r"""<(span|div)\b[^>]*\bclass\s*=\s*["']?[^"'>]*\bnw\b[^>]*>""", re.I)
_DIV_OPEN = re.compile(r"<div\b[^>]*>", re.I)
_DIV_CLOSE = re.compile(r"</div\s*>", re.I)
_LIST_MARK = re.compile(r"^\s*(\d{1,3}[.)]|[•◦▪‣·–-])\s+")  # a list item's printed marker, not in its .md words
_approve_lock = threading.Lock()
_approve_cache = {}  # real pdf path -> (pdf, .md and approved-text versions, items)
_approve_undo = {}  # real pdf path -> the last Approve all: its token, the texts before it, their versions after it


def approved_store(md):
    """The text he has approved for this .md: present only where the build paints by it (the book chapters)."""
    return Path(md).parent / ".approved" / Path(md).name


def store_add(md, units):
    """Add these units to the .md's approved text. False when it has none (its blue comes from markers)."""
    st = approved_store(md)
    with _approve_lock:
        if not st.is_file():
            return False
        cur = st.read_text(encoding="utf-8")
        have = {u.strip() for u in MD_SPLIT.split(cur)[0::2]}
        add = []
        for u in units:
            u = u.strip()
            if u and u not in have and u not in add:
                add.append(u)
        if add:
            tmp = st.with_name(st.name + ".tmp")
            tmp.write_text(cur.rstrip("\n") + "\n\n" + "\n\n".join(add) + "\n", encoding="utf-8")
            os.replace(tmp, st)
    return True


def nw_strip(unit):
    """The unit with its own nw tags taken off (each opening tag and the close that matches it), or None when it
    has none. A tag whose other half is another unit (a div wrapping several paragraphs) is nw_wrapper's."""
    stack, drop = [], []
    for m in _NW_TAG.finditer(unit):
        name = m.group(1).lower()
        if m.group(0).startswith("</"):
            for x in range(len(stack) - 1, -1, -1):
                if stack[x][0] == name:
                    _, is_nw, span = stack.pop(x)
                    if is_nw:
                        drop += [span, m.span()]
                    break
        else:
            stack.append((name, bool(_NW_OPEN.fullmatch(m.group(0))), m.span()))
    if not drop:
        return None
    out, last = [], 0
    for a, b in sorted(drop):
        out.append(unit[last:a])
        last = b
    return "".join(out) + unit[last:]


def nw_wrapper(blocks, i):
    """(j, k) when block i sits in an nw div whose tags are blocks of their own (<div class="nw" markdown="1">, a
    blank line, the paragraphs, a blank line, </div>); else None."""
    depth = 0
    for j in range(i - 1, -1, -1):
        b = blocks[j].strip()
        if _DIV_CLOSE.fullmatch(b):
            depth += 1
        elif _DIV_OPEN.fullmatch(b):
            if depth:
                depth -= 1
                continue
            if not _NW_OPEN.fullmatch(b):
                return None
            break
    else:
        return None
    depth = 0
    for k in range(i + 1, len(blocks)):
        b = blocks[k].strip()
        if _DIV_OPEN.fullmatch(b):
            depth += 1
        elif _DIV_CLOSE.fullmatch(b):
            if not depth:
                return j, k
            depth -= 1
    return None


def nw_approve(text, i):
    """(the .md text with block i out of every nw marker, block i as it then reads), or (None, block i) when no
    marker touches it. Only block i changes colour: a wrapping div is closed before it and opened again after it,
    and a wrapper left empty goes."""
    parts = MD_SPLIT.split(text)
    blocks = parts[0::2]
    unit = blocks[i]
    own = nw_strip(unit)
    if own is not None:
        unit = own
    w = nw_wrapper(blocks, i)
    if own is None and not w:
        return None, blocks[i]
    if w:
        # The opener is a block before it and the closer one after it, so both separators exist; a blank line on
        # each side, as a div tag needs.
        opener = blocks[w[0]].strip()
        parts[2 * i] = f"</div>\n\n{unit.strip()}\n\n{opener}"
        parts[2 * i - 1] = parts[2 * i + 1] = "\n\n"
    else:
        parts[2 * i] = unit
    out = "".join(parts)
    if w:
        o = re.escape(opener)
        out = re.sub(r"\n{2,}" + o + r"\n+</div>(?=\n|\Z)", "", out)
        out = re.sub(r"\A" + o + r"\n+</div>\n*", "", out)
    return out, unit.strip()


def print_letters(t):
    """Letters and digits only, lower case, accents and ligatures unfolded: how a line's words are compared."""
    import unicodedata
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", t).lower())


def first_line(pdf):
    """[x0, y0, page width, page height]: where page 1's first printed thing starts (a line or a picture), in PDF points
    from the top left, or None. ✓ Approve all goes in the margin above it (2026-11-17)."""
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    with fitz.open(str(pdf)) as doc:
        if not len(doc):
            return None
        p = doc[0]
        found = [b for b in p.get_text("blocks") if b[6] == 1 or b[4].strip()]
        if not found:
            return None
        text = [b for b in found if b[6] == 0] or found
        return [round(min(b[0] for b in text), 1), round(min(b[1] for b in found), 1), round(p.rect.width, 1), round(p.rect.height, 1)]


def blue_paragraphs(pdf, vis):
    """[{index, page, x, y0, y1, W, H, lines}] for each .md block that prints with blue text: page (from 1) and the end
    of its last printed line, in PDF points from the page's top left, and the box of each of its printed lines.
    vis: each block's words as they show (or None).
    The blocks are found in print order, each as a run of whole lines whose letters are exactly the block's; text the
    .md does not hold (a chapter's character cards, picture prompts) is passed over."""
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    lines = []  # (letters, letters without a list marker, prints blue, page, bbox, page width, page height)
    with fitz.open(str(pdf)) as doc:
        for pno, page in enumerate(doc, 1):
            W, H = page.rect.width, page.rect.height
            for b in page.get_text("dict", flags=0)["blocks"]:
                for ln in b.get("lines", []):
                    txt = "".join(s["text"] for s in ln["spans"])
                    lt = print_letters(txt)
                    if lt:
                        blue = any(s["color"] == NEW_RGB and print_letters(s["text"]) for s in ln["spans"])
                        lines.append((lt, print_letters(_LIST_MARK.sub("", txt, count=1)), blue, pno, ln["bbox"], W, H))
    out, pos = [], 0
    for i, v in enumerate(vis):
        ul = print_letters(v) if v else ""
        if not ul:
            continue
        for j in range(pos, len(lines)):
            end = None
            for first in (lines[j][0], lines[j][1]):
                if first and ul.startswith(first):
                    rest, k = ul[len(first):], j
                    while rest and k + 1 < len(lines) and rest.startswith(lines[k + 1][0]):
                        k += 1
                        rest = rest[len(lines[k][0]):]
                    if not rest:
                        end = k
                        break
            if end is None:
                continue
            if any(lines[x][2] for x in range(j, end + 1)):
                _, _, _, pno, bb, W, H = lines[end]
                # every printed line of the block, [page, x0, y0, x1, y1]: the viewer repaints their blue black the
                # moment he approves, before the rebuilt PDF comes in
                boxes = [[lines[x][3], *(round(c, 1) for c in lines[x][4])] for x in range(j, end + 1)]
                out.append({"index": i, "page": pno, "x": round(bb[2], 2), "y0": round(bb[1], 2), "y1": round(bb[3], 2),
                            "W": round(W, 2), "H": round(H, 2), "lines": boxes})
            pos = end + 1
            break
    return out


def source_of(pdf):
    """The .md a PDF (its real path) is built from and may be rebuilt from here, or None: what ✏️ and ✓ Approve need."""
    md = Path(pdf).with_suffix(".md")
    return md if md.is_file() and rebuilds_here(pdf) else None


def _approve_key(pdf, md):
    """A file's version for the ✓ Approve scan: the PDF, its .md, and the approved text it paints by. OSError if gone."""
    store = approved_store(md)
    ps = pdf.stat()
    return (ps.st_mtime_ns, ps.st_size, md.stat().st_mtime_ns, store.stat().st_mtime_ns if store.is_file() else 0)


def approve_scan(pdf, md, cached_only=False):
    """(items, head) for the ✓ Approve buttons of this PDF, built from that .md: one item per paragraph that prints blue
    and can be approved. Kept per file until the PDF, the .md or its approved text changes. The page's buttons and the
    file lists' blue names both read it here, so they never disagree (2026-11-18). None when cached_only and not known
    yet; raises when the PDF cannot be read (one being written as this reads it)."""
    try:
        key = _approve_key(pdf, md)
    except OSError:
        return [], None
    hit = _approve_cache.get(str(pdf))
    if hit and hit[0] == key:
        return hit[1], hit[2]
    if cached_only:
        return None
    text = md.read_text(encoding="utf-8")
    blocks = MD_SPLIT.split(text)[0::2]
    t0 = time.time()
    found = blue_paragraphs(pdf, blocks_visible(md, text, blocks))
    head = first_line(pdf) if found else None
    has_store = approved_store(md).is_file()
    items = []
    for it in found:
        i = it["index"]
        if has_store or nw_strip(blocks[i]) is not None or nw_wrapper(blocks, i):
            items.append({**it, "old": blocks[i]})
    _approve_cache[str(pdf)] = (key, items, head)
    print(f"[approve] {pdf.name}: {len(items)} blue paragraphs ({time.time() - t0:.2f} s)", flush=True)
    return items, head


def blue_count(where, cached_only=False):
    """How many paragraphs of the PDF behind a served path wait for ✓ Approve: 0 for a file with no .md to approve in,
    None when not known (cached_only and not scanned yet, or the PDF could not be read this time)."""
    pdf = (ROOT / where.lstrip("/")).resolve()
    md = source_of(pdf)
    if not md:
        return 0
    try:
        got = approve_scan(pdf, md, cached_only)
    except Exception as err:  # a PDF being written as this reads it: unknown this time, the next list asks again
        print(f"[approve] reading {pdf.name} failed: {err}", flush=True)
        return None
    return None if got is None else len(got[0])


def keep_refused(target, body, meta):
    """Keep a refused upload (or paragraph edit) under state/refused/: <file>.<UTC>.bin (or .paragraph.json) and
    <file>.<UTC>.json. Never raises: a failure here must not change the answer the device gets."""
    try:
        REFUSED.mkdir(parents=True, exist_ok=True)
        now = time.time()
        for old in REFUSED.iterdir():
            if now - old.stat().st_mtime > REFUSED_DAYS * 86400:
                old.unlink(missing_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        stem = REFUSED / f"{Path(target).name}.{stamp}"
        meta = {"file": str(target), "at": datetime.datetime.now().isoformat(timespec="seconds"), **meta}
        if body is not None:
            stem.with_name(stem.name + ".bin").write_bytes(body)
            meta["bin"] = stem.name + ".bin"
            meta["bytes"] = len(body)
        stem.with_name(stem.name + ".json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"[refused] kept {stem.name} ({meta.get('status')} {meta.get('why', '')[:80]})", flush=True)
    except OSError as err:
        print(f"[refused] keeping a refused upload failed: {err}", flush=True)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Without it Chrome reuses a cached viewer.html/autoreload.js without asking, so a viewer
        # change never reaches an open window. no-cache = keep the copy, but revalidate (a cheap 304).
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, obj, code=200):
        self._bytes(json.dumps(obj, ensure_ascii=False).encode(), "application/json", code=code)

    def _bytes(self, body, ctype, headers=None, code=200):
        # An answer over about one packet travels compressed when the caller can read that.
        packed = len(body) > 1400 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if packed:
            body = gzip.compress(body, 5)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if packed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static_gz(self):
        """A viewer file, compressed, when the caller accepts gzip. True when it was answered here."""
        route = urlparse(self.path).path
        if "gzip" not in (self.headers.get("Accept-Encoding") or ""):
            return False
        if not (route.startswith("/viewer/") or route == "/sw.js"):
            return False
        path = Path(self.translate_path(self.path))
        if path.suffix.lower() not in _GZ_TYPES or not path.is_file():
            return False
        st = path.stat()
        if "If-Modified-Since" in self.headers and "If-None-Match" not in self.headers:
            try:
                since = email.utils.parsedate_to_datetime(self.headers["If-Modified-Since"])
            except (TypeError, IndexError, OverflowError, ValueError):
                since = None
            if since is not None:
                if since.tzinfo is None:
                    since = since.replace(tzinfo=datetime.timezone.utc)
                last = datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc).replace(microsecond=0)
                if last <= since:
                    self.send_response(304)
                    self.end_headers()
                    return True
        body = gz_file(path, st)
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", self.date_time_string(st.st_mtime))
        self.end_headers()
        self.wfile.write(body)
        return True

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def _doc(self):
        return (parse_qs(urlparse(self.path).query).get("doc") or [""])[0]

    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/api/caps":
            # What this server's /api/save understands (2026-11-15). A viewer newer than the running server (the files
            # are served from disk, the server restarts later) sends X-Since-Length only to a server that names it.
            return self._json({"save": ["keep", "base-length", "made", "since", "refused-kept"]})
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
        if route == "/api/editdraft":
            return self._editdraft_get()
        if route == "/api/history":
            # The blue count rides along only where the scan already knows it, so the list never waits for one
            # (2026-11-18); the 🕘 Recent list asks /api/blue for the rest after it draws.
            files = history_list()
            for f in files:
                n = blue_count(f["path"], cached_only=True)
                if n is not None:
                    f["blue"] = n
            return self._json({"files": files})
        if route == "/api/books":
            # The book tabs (2026-11-19): every PDF of the books, opened or not. Blue counts as in /api/history, only
            # where the scan already knows them; a copy (marked, earlier, backup) has no .md to approve in.
            files = book_list()
            for f in files:
                if f["path"] and f["kind"] in ("chapters", "notes"):
                    n = blue_count(f["path"], cached_only=True)
                    if n is not None:
                        f["blue"] = n
            return self._json({"files": files})
        if route == "/api/blue":
            return self._blue()
        if route == "/api/folder":
            return self._folder()
        if route == "/api/offline-manifest":
            return self._json({"files": offline_manifest()})
        if route == "/api/watch":
            return self._watch()
        if route == "/api/built":
            return self._built()
        if route == "/api/approve":
            return self._approve_get()
        if route.startswith("/viewer/web/fonts/"):
            return self._font(route)
        if self._static_gz():
            return
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

    def _watch(self):
        # One waiting request instead of two polls every 2 s (2026-11-11): the open viewer asked "has
        # the file changed?" and "does someone want my marks?" 60 times a minute, which kept the phone's
        # radio awake while he only read. This answers at once when either is true, else after the wait.
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        q = parse_qs(urlparse(self.path).query)
        have = (q.get("sig") or [""])[0]
        try:
            wait = max(0.0, min(float((q.get("wait") or ["25"])[0]), WATCH_MAX))
        except ValueError:
            wait = 25.0
        link = ROOT / where.lstrip("/")
        deadline = time.time() + wait
        while True:
            try:
                sig = signature(link.resolve(), self.date_time_string)
            except OSError:
                sig = ""
            with _marks_lock:
                entry = _marks.get(where) or {}
                asked, got = entry.get("want", 0), entry.get("got")
                want = time.time() - asked < WANT_SECS and not (got and got["at"] >= asked)
            if sig != have or want or time.time() >= deadline:
                break
            time.sleep(0.5)
        try:
            self._json({"sig": sig, "changed": sig != have, "want": want})
        except OSError:
            pass  # the viewer left while this waited

    def _delta(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        target = (ROOT / where.lstrip("/")).resolve()
        n = int(self.headers.get("Content-Length") or 0)
        if n % 12 or n > 12 * 400_000:
            return self.send_error(400, "not a chunk table")
        table = struct.unpack(f"<{n // 4}I", self.rfile.read(n))
        try:
            st = target.stat()
            data = target.read_bytes()
            after = target.stat()
        except OSError as err:
            return self.send_error(404, str(err))
        if (st.st_mtime_ns, st.st_size) != (after.st_mtime_ns, after.st_size) or len(data) != st.st_size:
            return self._json({"error": "the file is being written"}, 503)
        body = build_delta(table, data)
        self.log_message("delta for %s: %d of %d bytes travel", target.name, len(body), len(data))
        self._bytes(body, "application/octet-stream", {"X-Sig": f"{self.date_time_string(st.st_mtime)}|{st.st_size}"})

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
        if route == "/api/delta":
            return self._delta()
        if route == "/api/reveal":
            return self._reveal()
        if route == "/api/edit":
            return self._edit()
        if route == "/api/paragraph":
            return self._paragraph_post()
        if route == "/api/approve":
            return self._approve_post()
        if route == "/api/editdraft":
            return self._editdraft_post()
        if route == "/api/open":
            return self._open()
        if route == "/api/opened":
            return self._opened()
        if route == "/api/hide":
            return self._hide()
        if route == "/api/trash":
            return self._trash()
        if route == "/api/clientlog":
            return self._clientlog()
        if urlparse(self.path).path != "/api/tts":
            return self.send_error(404)
        req = self._body()
        text = " ".join(str(req.get("text", "")).split())
        # Piper spells a word written in capitals letter by letter ("VERA" -> "V, E, R, A"). the architect,
        # 2026-11-13: say every all-caps word as a word, so lower it before synthesis.
        text = re.sub(r"\b[A-Z][A-Z'’]+\b", lambda m: m.group(0).lower(), text)
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
        # 2026-11-11: the viewer sends its events in batches (one request every few seconds, not one per
        # touch), as a JSON list; an older viewer still sends one object.
        try:
            n = min(int(self.headers.get("Content-Length") or 0), 200_000)
            raw = self.rfile.read(n).decode("utf-8", "replace")
            lines = [raw[:8000]]
            if raw.lstrip().startswith("["):
                try:
                    lines = [json.dumps(e, ensure_ascii=False)[:8000] for e in json.loads(raw)][:500]
                except ValueError:
                    pass
        except (ValueError, OSError) as e:
            lines = [f"unreadable: {e}"]
        stamp = time.strftime('%Y-%m-%d %H:%M:%S')
        for line in lines:
            line = line.replace("\n", " ")
            sys.stderr.write(f"CLIENT {stamp} {line}\n")
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

    # 2026-10-27: there was no way to remove a file. A long press on a 🕘 Recent row offers both. Hide only takes it off the list; Trash moves the real PDF
    # to the trash, where a file manager can restore it. Never a plain delete.
    def _hide(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        target = str((ROOT / where.lstrip("/")).resolve())
        with _history_lock:
            hidden = load_hidden()
            hidden[target] = int(time.time() * 1000)
            write_json(HIDDEN, hidden)
        self._json({"ok": True, "hidden": target})

    def _trash(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        link = ROOT / where.lstrip("/")
        if not link.is_symlink():  # a real file under papers/ is a test fixture, never his
            return self._json({"error": "not a file this viewer opened"}, 403)
        pdf = link.resolve()
        if pdf.suffix.lower() != ".pdf" or not pdf.is_file() or not any(pdf.is_relative_to(r) for r in OPEN_ROOTS):
            return self._json({"error": f"not a PDF the viewer may touch: {pdf}"}, 403)
        try:
            went = trash(pdf)
        except OSError as err:
            sys.stderr.write(f"trash failed for {pdf}: {err!r}\n")
            return self._json({"error": f"could not move it to the trash: {err}"}, 500)
        sys.stderr.write(f"TRASH {time.strftime('%Y-%m-%d %H:%M:%S')} {pdf} -> {went}\n")
        self._json({"ok": True, "file": str(pdf), "trash": str(went)})

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
        # /api/paragraph hands this .md to md2pdf.py, which runs the folder's own build*.sh: no Edit text outside.
        return source_of((ROOT / where.lstrip("/")).resolve())

    def _source_get(self):
        # The viewer shows ✏️ Edit text only when the PDF has a sibling .md it is built from.
        # With text=1 the source itself comes too: offline, the viewer finds and edits paragraphs in it.
        md = self._source_target()
        out = {"has": bool(md), "path": str(md) if md else None}
        if md and parse_qs(urlparse(self.path).query).get("text"):
            out["text"] = md.read_text(encoding="utf-8")
            out["sig"] = signature(md, self.date_time_string)
            out["saved"] = str(md.stat().st_mtime_ns)
            # The words of each block as Python-Markdown shows them: the writer checks its own reading against these.
            out["vis"] = blocks_visible(md, out["text"], self._md_blocks(out["text"]))
        self._json(out)

    def _folder(self):
        # Fetch ahead (2026-11-10): every PDF in the folder of this one, linked under papers/open/ like
        # /api/open does, so the phone can keep the whole book. Backups an edit or a review round left
        # beside them (-before-edit, -marques-oscar-N) are not part of it.
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        folder = (ROOT / where.lstrip("/")).resolve().parent
        if not any(folder.is_relative_to(r) for r in OPEN_ROOTS):
            return self._json({"error": f"outside the folders the viewer may open: {folder}"}, 403)
        files = []
        for pdf in sorted(folder.glob("*.pdf")):
            if pdf.stem.endswith("-before-edit") or "-marques-oscar" in pdf.stem or pdf.name.startswith("."):
                continue
            try:
                path = link_pdf(pdf)
            except RuntimeError:
                continue
            # sig: the version, as a HEAD would say it, so keeping a folder asks once instead of once per file.
            files.append({"path": path, "name": pdf.name, "source": pdf.with_suffix(".md").is_file(),
                          "sig": signature(pdf, self.date_time_string)})
        self._json({"dir": str(folder), "files": files})

    # ---- ✏️ Edit text: pick a paragraph in the viewer, edit it in a popup (2026-10-16) -----------------
    @staticmethod
    def _md_split(text):
        # Units are paragraphs, and each list item on its own. Separators are kept so a join restores
        # the file exactly: parts = [unit, sep, unit, sep, ...].
        return MD_SPLIT.split(text)

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
        if isinstance(i, int) and 0 <= i < len(blocks) and blocks[i] == req.get("old"):
            pass
        elif isinstance(req.get("old"), str) and blocks.count(req["old"]) == 1:
            i = blocks.index(req["old"])  # the same paragraph, moved (blocks added or removed above it): apply it there
        else:
            return self._paragraph_refused(md, req, blocks)
        new = str(req.get("new", "")).strip("\n")
        if req.get("writer"):
            # Typed on the page: the new block may be several (he pressed Enter) or none (he deleted all of it),
            # and it must show exactly the words he typed, by Python-Markdown's reading, or nothing is written.
            vis = req.get("vis")
            if not isinstance(vis, str):
                return self._json({"error": "the writer sent no text to check against"}, 400)
            shows = md_visible(new) if new.strip() else ""
            if shows != vis_norm(vis):
                return self._json({"error": "this change would not show the words typed", "shows": shows}, 422)
            tail = blocks[i][len(blocks[i].rstrip("\n")):]  # the file's final newline, on its last block
            if new.strip():
                parts[2 * i] = new + tail
            elif len(blocks) == 1:
                parts = [""]
            elif i < len(blocks) - 1:
                del parts[2 * i:2 * i + 2]  # the block and the separator after it
            else:
                del parts[2 * i - 1:2 * i + 1]  # the last block and the separator before it
                parts[-1] += tail
        else:
            if not new.strip():
                return self._json({"error": "empty paragraph; delete it in the source instead"}, 400)
            parts[2 * i] = new.replace("\n\n", "\n")  # one unit stays one unit
        tmp = md.with_suffix(".md.tmp")
        tmp.write_text("".join(parts), encoding="utf-8")
        os.replace(tmp, md)
        # His own words are read: where the build paints what he has not approved (the book chapters), they go
        # into the approved text, so his own edit never prints blue (✓ Approve, 2026-11-15).
        if new.strip():
            store_add(md, MD_SPLIT.split(new)[0::2])
        pdf = md.with_suffix(".pdf")
        try:
            EDIT_JOURNAL.parent.mkdir(parents=True, exist_ok=True)
            with EDIT_JOURNAL.open("a", encoding="utf-8") as j:
                j.write(json.dumps({"at": datetime.datetime.now().isoformat(timespec="seconds"), "pdf": str(pdf),
                                    "index": i, "old": blocks[i], "new": new,
                                    "via": "writer" if req.get("writer") else "box"}, ensure_ascii=False) + "\n")
        except OSError as err:
            print(f"[edit] journal: {err}", flush=True)
        # A refused edit of his kept for the next open (_paragraph_refused) is done once the same words are saved.
        with _state_lock:
            drafts = self._edit_drafts()
            d = drafts.get(str(pdf))
            if d and d.get("refused") and str(d.get("text", "")).strip("\n") == new:
                drafts.pop(str(pdf))
                try:
                    write_json(EDIT_DRAFTS, drafts)
                except OSError as err:
                    print(f"[edit] clearing a kept edit failed: {err}", flush=True)
        # His own edit: the PDF is rebuilt in the background, keeping his marks; the open viewer swaps it in.
        BUILDER.mark(pdf)
        # Versions are nanosecond times, sent as strings: a browser rounds a 19-digit JSON number.
        self._json({"ok": True, "saved": str(md.stat().st_mtime_ns)})

    def _paragraph_refused(self, md, req, blocks):
        """The paragraph he typed on changed meanwhile (an agent, another device). His words are never dropped: they
        are kept under state/refused/, offered back by the next open of the PDF (edit-drafts.json, unless a newer box
        is open there), and the answer names the paragraph that most likely took its place, so the viewer can put
        his words there with one tap."""
        import difflib
        pdf = md.with_suffix(".pdf")
        old, new = str(req.get("old") or ""), str(req.get("new") or "")
        # The paragraph that took its place: the most alike in letters, the one at the same place counting extra
        # (an agent's rewrite of it may share few letters with it).
        guess, best = None, 0.0
        lo = self._letters(old)
        for k, b in enumerate(blocks):
            r = difflib.SequenceMatcher(None, lo, self._letters(b), autojunk=False).ratio() if lo else 0
            r += 0.3 if k == req.get("index") and self._letters(b) else 0
            if r > best:
                guess, best = k, r
        if best < 0.45:
            guess = None
        keep_refused(pdf, None, {"status": 409, "why": "the paragraph changed meanwhile", "kind": "paragraph",
                                 "index": req.get("index"), "old": old, "new": new, "writer": bool(req.get("writer")),
                                 "vis": req.get("vis"), "guess": guess, "current": blocks[guess] if guess is not None else None})
        if new.strip():
            with _state_lock:
                drafts = self._edit_drafts()
                now = int(time.time() * 1000)
                mine = drafts.get(str(pdf))
                if not mine or (mine.get("at") or 0) < now - 1000:
                    drafts[str(pdf)] = {"index": guess if guess is not None else req.get("index"),
                                        "old": blocks[guess] if guess is not None else old, "text": new,
                                        "caret": len(new), "at": now, "refused": True}
                    try:
                        write_json(EDIT_DRAFTS, drafts)
                    except OSError as err:
                        print(f"[edit] keeping the refused edit failed: {err}", flush=True)
        return self._json({"error": "the paragraph changed meanwhile; pick it again", "kept": True,
                           "index": guess, "current": blocks[guess] if guess is not None else None}, 409)

    def _built(self):
        where = self._served_path()
        if not where:
            return self.send_error(404, "not a served paper")
        pdf = (ROOT / where.lstrip("/")).resolve()
        built, due = BUILDER.stamp(pdf)
        try:
            sig = signature(pdf, self.date_time_string)
        except OSError:
            sig = ""
        self._json({"built": str(built) if built else None, "pending": due, "sig": sig})

    def _approve_get(self):
        """The paragraphs that print blue and can be approved, with where each one's last line ends."""
        md = self._source_target()
        if not md:
            return self._json({"has": False, "items": []})
        pdf = (ROOT / self._served_path().lstrip("/")).resolve()
        try:
            items, head = approve_scan(pdf, md)
        except Exception as err:  # a PDF being written as this reads it: no buttons this time, the next load asks again
            print(f"[approve] reading {pdf.name} failed: {err}", flush=True)
            return self._json({"has": True, "items": [], "error": "the PDF could not be read"})
        self._json({"has": True, "items": items, "head": head})

    def _blue(self):
        """{blue: {path: n}} for each served path asked: n paragraphs wait for ✓ Approve in it (0: none, or no .md to
        approve in). A path that is not a served paper, or a PDF that could not be read this time, is left out."""
        out = {}
        papers = (ROOT / "papers").resolve()
        for where in parse_qs(urlparse(self.path).query).get("path", [])[:200]:
            rel = unquote(where).lstrip("/")
            link = ROOT / rel
            if not rel.startswith("papers/") or ".." in Path(rel).parts or not link.is_file() \
                    or not link.absolute().is_relative_to(papers):
                continue
            n = blue_count("/" + rel)
            if n is not None:
                out["/" + rel] = n
        self._json({"blue": out})

    def _approve_post(self):
        """✓ Approve: block {index, old} has been read. Into the approved text, or its nw marker off; then rebuilt."""
        md = self._source_target()
        if not md:
            return self._json({"error": "this PDF has no .md source next to it"}, 404)
        req = self._body()
        if isinstance(req.get("items"), list):
            return self._approve_many(md, req["items"])
        if isinstance(req.get("undo"), str):
            return self._approve_undo_post(md, req["undo"])
        text = md.read_text(encoding="utf-8")
        blocks = self._md_blocks(text)
        i, old = req.get("index"), req.get("old")
        if isinstance(i, int) and 0 <= i < len(blocks) and blocks[i] == old:
            pass
        elif isinstance(old, str) and blocks.count(old) == 1:
            i = blocks.index(old)  # the same paragraph, moved: approve it there
        else:
            return self._json({"error": "this paragraph changed meanwhile, so it stays blue"}, 409)
        new_text, clean = nw_approve(text, i)
        how = []
        if new_text is not None:
            tmp = md.with_suffix(".md.tmp")
            tmp.write_text(new_text, encoding="utf-8")
            os.replace(tmp, md)
            how.append("marker")
        if store_add(md, [clean]):
            how.append("store")
        if not how:
            return self._json({"error": "nothing in the text source marks this paragraph as new"}, 409)
        pdf = md.with_suffix(".pdf")
        try:
            APPROVE_JOURNAL.parent.mkdir(parents=True, exist_ok=True)
            with APPROVE_JOURNAL.open("a", encoding="utf-8") as j:
                j.write(json.dumps({"at": datetime.datetime.now().isoformat(timespec="seconds"), "pdf": str(pdf),
                                    "index": i, "text": clean, "how": "+".join(how)}, ensure_ascii=False) + "\n")
        except OSError as err:
            print(f"[approve] journal: {err}", flush=True)
        BUILDER.mark(pdf)  # the rebuilt PDF prints it black; the open viewer swaps it in
        self._json({"ok": True, "index": i, "how": "+".join(how), "saved": str(md.stat().st_mtime_ns)})

    def _approve_many(self, md, todo):
        """✓ Approve all (2026-11-17): every {index, old} listed, one write, one rebuild. The blocks are taken from the
        last to the first, so a marker taken off one leaves the earlier ones where they were; one that moved anyway is
        found by its words. One that changed meanwhile stays blue and is named in `missed`."""
        want, seen = [], set()
        for it in todo:
            if isinstance(it, dict) and isinstance(it.get("old"), str) and it["old"] not in seen:
                seen.add(it["old"])
                want.append(it)
        want.sort(key=lambda it: it["index"] if isinstance(it.get("index"), int) else -1, reverse=True)
        text = md.read_text(encoding="utf-8")
        md_before = text
        has_store = approved_store(md).is_file()
        store_before = approved_store(md).read_text(encoding="utf-8") if has_store else None
        done, missed, cleans, marker = [], [], [], False
        for it in want:
            blocks = self._md_blocks(text)
            i, old = it.get("index"), it["old"]
            if not (isinstance(i, int) and 0 <= i < len(blocks) and blocks[i] == old):
                if blocks.count(old) != 1:
                    missed.append(old)
                    continue
                i = blocks.index(old)
            new_text, clean = nw_approve(text, i)
            if new_text is None and not has_store:
                missed.append(old)
                continue
            how = "+".join((["marker"] if new_text is not None else []) + (["store"] if has_store else []))
            if new_text is not None:
                text, marker = new_text, True
            cleans.append(clean)
            done.append((i, old, clean, how))
        if not done:
            why = "every paragraph changed meanwhile, so they stay blue" if want else "no paragraph to approve"
            return self._json({"error": why, "missed": missed}, 409)
        if marker:
            tmp = md.with_suffix(".md.tmp")
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, md)
        if has_store:
            store_add(md, cleans)
        pdf = md.with_suffix(".pdf")
        try:
            APPROVE_JOURNAL.parent.mkdir(parents=True, exist_ok=True)
            at = datetime.datetime.now().isoformat(timespec="seconds")
            with APPROVE_JOURNAL.open("a", encoding="utf-8") as j:
                for i, _, clean, how in reversed(done):
                    j.write(json.dumps({"at": at, "pdf": str(pdf), "index": i, "text": clean, "how": how, "all": True},
                                       ensure_ascii=False) + "\n")
        except OSError as err:
            print(f"[approve] journal: {err}", flush=True)
        BUILDER.mark(pdf)  # one rebuild for all of them
        token = os.urandom(8).hex()
        _approve_undo[str(pdf)] = {"token": token, "n": len(done), "md": md_before if marker else None,
                                   "store": store_before, "after": self._approve_versions(md)}
        print(f"[approve] {pdf.name}: approve all, {len(done)} approved, {len(missed)} changed meanwhile", flush=True)
        self._json({"ok": True, "approved": [old for _, old, _, _ in done], "missed": missed, "undo": token,
                    "saved": str(md.stat().st_mtime_ns)})

    @staticmethod
    def _approve_versions(md):
        st = approved_store(md)
        return (md.stat().st_mtime_ns, st.stat().st_mtime_ns if st.is_file() else 0)

    def _approve_undo_post(self, md, token):
        """↶ Undo after Approve all (2026-11-17): the .md and the approved text go back to what they were before it, so
        the blue comes back with the rebuild. Only while nothing changed them since (a Write save, another approval):
        his later work is never thrown away."""
        pdf = md.with_suffix(".pdf")
        u = _approve_undo.get(str(pdf))
        if not u or u["token"] != token:
            return self._json({"error": "this Approve all can no longer be undone"}, 409)
        if self._approve_versions(md) != u["after"]:
            return self._json({"error": "the text changed since, so the approvals stay"}, 409)
        with _approve_lock:
            for path, body in ((md, u["md"]), (approved_store(md), u["store"])):
                if body is None:
                    continue
                tmp = path.with_name(path.name + ".undo.tmp")
                tmp.write_text(body, encoding="utf-8")
                os.replace(tmp, path)
        del _approve_undo[str(pdf)]
        try:
            with APPROVE_JOURNAL.open("a", encoding="utf-8") as j:
                j.write(json.dumps({"at": datetime.datetime.now().isoformat(timespec="seconds"), "pdf": str(pdf),
                                    "undo": True, "n": u["n"]}, ensure_ascii=False) + "\n")
        except OSError as err:
            print(f"[approve] journal: {err}", flush=True)
        BUILDER.mark(pdf)  # the rebuilt PDF prints them blue again
        print(f"[approve] {pdf.name}: approve all undone, {u['n']} blue again", flush=True)
        self._json({"ok": True, "undone": u["n"]})

    def _font(self, route):
        name = route.rsplit("/", 1)[-1]
        stem = name[:-4] if name.lower().endswith((".ttf", ".otf")) else ""
        f = font_path(stem) if re.fullmatch(r"[A-Za-z0-9._+-]{1,80}", stem or "-") else None
        if not f:
            return self.send_error(404, "no such font here")
        st = os.stat(f)
        since = self.headers.get("If-Modified-Since")
        if since:
            try:
                if email.utils.parsedate_to_datetime(since).timestamp() >= int(st.st_mtime):
                    self.send_response(304)
                    self.end_headers()
                    return
            except (TypeError, ValueError, IndexError, OverflowError):
                pass
        self._bytes(Path(f).read_bytes(), "font/otf" if f.lower().endswith(".otf") else "font/ttf",
                    {"Last-Modified": self.date_time_string(st.st_mtime)})

    # ---- An Edit paragraph box that was open when the page died (app restart, reload, lost network).
    # The viewer posts what is in the box as it is typed; on the next open it asks for it back and reopens
    # the box with that text and the cursor where it was. pdf-comments.py prints a waiting edit.
    @staticmethod
    def _edit_drafts():
        try:
            return json.loads(EDIT_DRAFTS.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _editdraft_get(self):
        md = self._source_target()
        self._json((self._edit_drafts().get(str(md.with_suffix(".pdf"))) if md else None) or {})

    def _editdraft_post(self):
        md = self._source_target()
        if not md:
            return self._json({"error": "this PDF has no .md source next to it"}, 404)
        req = self._body()
        drafts = self._edit_drafts()
        key = str(md.with_suffix(".pdf"))
        if req.get("clear"):
            drafts.pop(key, None)
        else:
            drafts[key] = {"index": req.get("index"), "old": str(req.get("old", "")), "text": str(req.get("text", "")),
                           "caret": req.get("caret"), "at": req.get("at") or int(time.time() * 1000)}
        EDIT_DRAFTS.parent.mkdir(parents=True, exist_ok=True)
        tmp = EDIT_DRAFTS.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(drafts, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, EDIT_DRAFTS)
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
            f"A highlight with no note is one he could not delete: ignore it, no edit and no question (the architect 2026-11-14; pdf-comments.py leaves it out). "
            f"An ink mark with NO text (a bare '?', a circle): do not guess an edit and do not rebuild; ask what it means "
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
        q = parse_qs(urlparse(self.path).query)
        with file_lock(target):
            return self._save_locked(target, data, q)

    def _refuse(self, target, data, q, code, why, extra=None):
        """Answer a refusal, after keeping what was sent (state/refused/): no upload is ever thrown away."""
        try:
            sig = signature(target, self.date_time_string)
        except OSError:
            sig = ""
        keep_refused(target, data, {"status": code, "why": why, "query": {k: v[0] for k, v in q.items() if k != "path"},
                                    "headers": {h: self.headers.get(h) for h in ("X-Base-Length", "X-Made-Length", "X-Since-Length")
                                                if self.headers.get(h)}, "server_sig": sig, **(extra or {})})
        return self._json({"error": why, "sig": sig, "kept": True, **(extra or {})}, code)

    def _save_locked(self, target, data, q):
        base = (q.get("base") or [""])[0]
        base_len = self.headers.get("X-Base-Length")
        # X-Made-Length (2026-11-15): the body is the marked file, whose first N bytes are the version the marks
        # were made on (pdf.js appends its marks to the file it loaded), optionally followed by X-Since-Length
        # bytes: the update the server last confirmed from that page. When the file here moved on, the marks are
        # carried onto it instead of refused: only those made since that confirmation, deletions and edits too.
        made = self.headers.get("X-Made-Length")
        moved = bool(base and target.is_file()
                     and signature(target, self.date_time_string).split("|")[0] != base.split("|")[0])
        if q.get("keep") and not base_len and not made:
            # Only what pdf.js appended travelled (2026-11-11: a comment is a few kB, the file 1 to 20 MB).
            # The first `keep` bytes are the file the viewer loaded, and they are still the start of the
            # file here. A rebuilt file is answered as before (409); a part that does not rebuild a file of
            # the stated length and crc32 is refused, and the viewer then sends the whole document.
            if moved:
                return self._refuse(target, data, q, 409, "changed")
            try:
                n, total, crc = int(q["keep"][0]), int(q["len"][0]), int(q["crc"][0], 16)
                head = target.read_bytes()[:n]
            except (KeyError, ValueError, OSError):
                return self._refuse(target, data, q, 422, "keep, len and crc are needed", {"need": "whole"})
            whole = head + data
            if len(head) != n or len(whole) != total or zlib.crc32(whole) != crc:
                return self._refuse(target, data, q, 422, "the part sent does not fit the file here", {"need": "whole"})
            self.log_message("save: %d bytes travelled for a %d byte file", len(data), total)
            data = whole
        since = None
        if made:
            try:
                n, k = int(made), int(self.headers.get("X-Since-Length") or 0)
            except ValueError:
                return self._refuse(target, data, q, 400, "X-Made-Length and X-Since-Length are numbers")
            if not (0 < n <= len(data) - k) or k < 0 or not data.startswith(b"%PDF-"):
                return self._refuse(target, data, q, 400, "the lengths do not fit the body")
            marked = data[:len(data) - k] if k else data
            since, data = data[:n] + (data[len(data) - k:] if k else b""), marked
        if base_len:  # base PDF + marked PDF: carry the new marks if the file moved on (offline sync)
            n = int(base_len)
            base_pdf, data = data[:n], data[n:]
            if base_pdf and not base_pdf.startswith(b"%PDF-"):  # empty: no base copy, carry every mark
                return self._refuse(target, base_pdf + data, q, 400, "base is not a PDF")
        if target.suffix.lower() != ".pdf" or not data.startswith(b"%PDF-"):
            return self._refuse(target, data, q, 400, "not a PDF")
        # Compared by date: the size half of a HEAD signature may not survive every proxy on the way.
        if moved:
            # The file changed since the device took its copy (a rebuild, an edit applied). Never write the
            # old document over it: with the base copy, carry the marks made since onto the new file.
            if since is not None:
                return self._carry(target, since, data, q)
            if not base_len:
                return self._refuse(target, data, q, 409, "changed")
            return self._carry(target, base_pdf, data, q)
        fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".saving", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.chmod(tmp, target.stat().st_mode & 0o777)
            os.replace(tmp, target)
        except OSError as err:
            Path(tmp).unlink(missing_ok=True)
            return self._refuse(target, data, q, 500, f"writing failed: {err}")
        self.log_message("saved %s (%d bytes)", target, len(data))
        self._json({"ok": True, "bytes": len(data), "file": str(target), "sig": signature(target, self.date_time_string)})

    def _carry(self, target, base_pdf, marked, q=None):
        import subprocess
        with tempfile.TemporaryDirectory(prefix="pdfreview-carry-") as d:
            old, since = Path(d) / "marked.pdf", Path(d) / "base.pdf"
            old.write_bytes(marked)
            since.write_bytes(base_pdf)
            only_new = ["--since", str(since)] if base_pdf else []
            fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".carrying", dir=target.parent)
            os.close(fd)
            try:
                Path(tmp).write_bytes(target.read_bytes())
                r = subprocess.run([str(ROOT / ".venv/bin/python"), str(ROOT / "pdf-carry-marks.py"), str(old), tmp,
                                    *only_new], capture_output=True, text=True, timeout=120)
                if r.returncode != 0:
                    raise RuntimeError(r.stderr[-300:] or "carry failed")
                os.chmod(tmp, target.stat().st_mode & 0o777)
                os.replace(tmp, target)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as err:
                Path(tmp).unlink(missing_ok=True)
                sys.stderr.write(f"carry failed for {target}: {err!r}\n")
                return self._refuse(target, base_pdf + marked, q or {}, 500, f"carrying the marks failed: {err}",
                                    {"base_length": len(base_pdf)})
        self.log_message("carried marks onto %s: %s", target, r.stdout.strip())
        self._json({"ok": True, "carried": True, "note": r.stdout.strip(), "file": str(target),
                    "sig": signature(target, self.date_time_string)})

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
    Skipped while an Apply-comments flag is up (state/applying/): then the agent rebuilds clean (2026-10-16).
    The build itself is the Builder's (2026-11-15), so a writer's save and this scan never build one file twice."""
    while True:
        try:
            for link in (ROOT / "papers").rglob("*.pdf"):
                try:
                    pdf = link.resolve()
                    if not rebuilds_here(pdf):
                        continue  # only opened, not his document folder: its .md and build*.sh are not ours to run
                    md = pdf.with_suffix(".md")
                    if md.is_file() and pdf.is_file() and md.stat().st_mtime > pdf.stat().st_mtime + 1:
                        flag = APPLYING / (pdf.name + ".flag")
                        if flag.is_file() and time.time() - flag.stat().st_mtime < APPLYING_TTL:
                            continue  # Apply comments is running: the agent rebuilds clean itself
                        if BUILDER.busy(pdf) or BUILDER.stamp(pdf)[0] == md.stat().st_mtime_ns:
                            continue  # already being built, or the PDF already holds this version of the .md
                        BUILDER.mark(pdf)  # the builder keeps the old PDF beside it and carries his marks
                except OSError:
                    continue
        except Exception as err:  # never let the watcher die
            print(f"[md2pdf] watcher error: {err}", flush=True)
        time.sleep(2)


if __name__ == "__main__":
    if HAS_KOKORO:
        threading.Thread(target=lambda: [kokoro(l) for l in "ab"], daemon=True).start()
    threading.Thread(target=BUILDER.run, daemon=True).start()
    threading.Thread(target=watch_sources, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(ROOT))).serve_forever()
