#!/usr/bin/env python3
"""Turn a Markdown source into a PDF in the Tinker style (brown headings, peach boxes, centered figures).

    md2pdf.py SOURCE.md OUT.pdf [--keep-marks]

Default: rebuild clean, no review marks (the architect 2026-10-16: a processed comment must not linger).
Clean removes only the marks this Apply round took: those in its marked copy <name>-marques-oscar-N.pdf (2026-11-15).
A mark made after that copy (he kept reading while the agent worked) is carried onto the rebuild; with no copy of
this round, the marked file is kept under state/refused/ before it is replaced, so nothing he wrote is lost.
--keep-marks: carry his marks onto the rebuild. Used ONLY when the rebuild is for a text edit the architect
made himself (the viewer's paragraph popup, or his editor saving the .md), never after Apply comments.
The last read of the marks and the write hold the PDF's lock (pdflock.py): a save cannot land in between.
A clean rebuild also clears the server's Apply-comments flag for OUT (state/applying/), so the
watcher starts rebuilding his own edits again.

The pdf-review server calls this when a PDF has a sibling SOURCE.md (same name) that is newer than the
PDF, so the architect can edit the text himself and the open viewer reloads the rebuilt PDF (2026-10-16:
small edits are cheaper done by hand than by the model). Images use file:// paths.
"""
import importlib.util, os, re, subprocess, sys, tempfile
from pathlib import Path
_VENV_PY = Path(__file__).resolve().parent / ".venv/bin/python"
if importlib.util.find_spec("markdown") is None and _VENV_PY.exists() and Path(sys.prefix).resolve() != _VENV_PY.parent.parent.resolve():
    import os; os.execv(str(_VENV_PY), [str(_VENV_PY), __file__, *sys.argv[1:]])  # Pi: system python has no markdown (2026-10-23)
import markdown
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdflock import file_lock  # noqa: E402

BROWN, PEACH, LINE = "#7A3921", "#FDE5D0", "#B97040"
import shutil
CHROME = next((c for c in ("/opt/google/chrome/google-chrome", shutil.which("chromium"), shutil.which("chromium-browser")) if c and Path(c).exists()), "/opt/google/chrome/google-chrome")


def render(md_text: str) -> str:
    lines = md_text.splitlines()
    title = lines[0].lstrip("# ").strip() if lines and lines[0].startswith("# ") else ""
    body_md = "\n".join(lines[1:]) if title else md_text
    html = markdown.markdown(body_md, extensions=["extra"])
    html = re.sub(r'<a href="(https?://[^"]+)">', rf'<a href="\1" style="color:{BROWN};font-weight:600;">', html)
    # Side figures (<img class="side" ...> in the source): small, on the left, text wraps around them.
    html = re.sub(r'<p>(<img [^>]*class="side"[^>]*>)', r'<p>\1', html)
    html = re.sub(r"<p>(<img (?![^>]*class=\"side\")[^>]+>)</p>", r'<figure style="margin:14px auto 18px;text-align:center">\1</figure>', html)
    html = re.sub(r'<img (?![^>]*class="side")', '<img style="display:block;width:100%;max-width:760px;margin:0 auto" ', html)
    html = html.replace("<h2>", f'<h2 style="color:{BROWN};border-bottom:2px solid {LINE};padding-bottom:4px;margin-top:30px;">')
    html = html.replace("<h3>", f'<h3 style="color:{BROWN};margin-top:22px;">')
    html = html.replace("<blockquote>", f'<blockquote style="background:{PEACH};border:1px solid {LINE};border-left:5px solid {BROWN};border-radius:6px;padding:12px 18px;margin:0 0 20px;">')
    # The source may hold raw HTML from anywhere (an unpacked archive, /api/paragraph, text an agent pasted in).
    # This policy stands before the first byte of it: no script, frame, object or outside stylesheet. Pictures
    # (file:, data:, web) and inline <style> stay, which is all 352 built sources under ~/Documents use (2026-11-14).
    csp = "default-src 'none'; img-src file: data: http: https:; style-src 'unsafe-inline'; font-src file: data:"
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{csp}"><title>{title}</title>
<style>@page{{size:A4;margin:18mm 16mm}} body{{font-family:Georgia,'DejaVu Serif',serif;color:#404040;max-width:760px;margin:0 auto;font-size:13.5px;line-height:1.65}}
h1{{color:{BROWN};font-size:26px;line-height:1.25;text-align:center;margin:14px 0 4px}} h2,h3{{page-break-after:avoid}} figure{{page-break-inside:avoid}} figure img{{max-height:150mm;width:auto!important;max-width:100%}}
p,li{{color:#404040}} li{{margin:0 0 .8em}} img.side{{float:left;width:36%;margin:4px 18px 8px 0;border-radius:6px}} h2,h3{{clear:both}} strong{{color:#3B2A14}}
.nw,.nw p,.nw li,.nw td,.nw strong,.nw em{{color:#1e90ff}}</style></head><body>
{f'<h1>{title}</h1>' if title else ''}{html}</body></html>"""


# Annotation kinds pdf-carry-marks.py carries (all but Link, Popup, Widget): his highlights, notes and ink.
_MARK = re.compile(rb"/Subtype\s*/(Text|FreeText|Line|Square|Circle|Polygon|PolyLine|Highlight|Underline|Squiggly|"
                   rb"StrikeOut|Stamp|Caret|Ink|FileAttachment|Sound|Redact)\b")


def has_marks(pdf) -> bool:
    """True when the PDF may hold review marks to carry. A byte scan, so the common case (no marks) skips loading
    PyMuPDF, 1.4 s on the Pi (2026-11-15). Objects packed in compressed object streams cannot be scanned: such a
    file counts as marked, and the carry itself decides."""
    try:
        data = Path(pdf).read_bytes()
    except OSError:
        return False
    return bool(_MARK.search(data)) or b"/ObjStm" in data


def applying_flag(out) -> Path:
    return Path(__file__).resolve().parent / "state" / "applying" / (Path(out).resolve().name + ".flag")


def _carry_module():
    spec = importlib.util.spec_from_file_location("carry", Path(__file__).with_name("pdf-carry-marks.py"))
    carry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(carry)
    return carry


def keep_dropped(marked: Path, out) -> None:
    """A clean rebuild with no marked copy of this round: the marked file goes to state/refused/ before it is
    replaced (pdf-refused.py lists it), so a mark nobody applied is never simply gone."""
    import datetime, json
    state = Path(os.environ.get("PDF_REVIEW_STATE") or Path(__file__).resolve().parent / "state") / "refused"
    try:
        state.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        stem = f"{Path(out).resolve().name}.{stamp}"
        (state / f"{stem}.bin").write_bytes(marked.read_bytes())
        (state / f"{stem}.json").write_text(json.dumps({
            "file": str(Path(out).resolve()), "at": datetime.datetime.now().isoformat(timespec="seconds"), "status": "replaced",
            "why": "clean rebuild with no marked copy of this round", "bin": f"{stem}.bin"}, indent=1), encoding="utf-8")
        print(f"[md2pdf] no marked copy of this round: the marked file is kept as state/refused/{stem}.bin", file=sys.stderr)
    except OSError as err:
        print(f"[md2pdf] keeping the marked file failed: {err}", file=sys.stderr)


def carry_marks(marked: Path, built: Path, out, keep_marks: bool) -> None:
    """Marks of `marked` (the file as it was right before the write) onto `built`: all of them for --keep-marks,
    else only those made after this Apply round's marked copy."""
    if not marked.exists() or not has_marks(marked):
        return
    carry = _carry_module()
    if keep_marks:
        n, moved, stayed = carry.carry_file(str(marked), str(built))
        if n:
            print(f"[md2pdf] carried {n} marks ({moved} re-anchored, {stayed} in place)", file=sys.stderr)
        return
    copy = carry.round_copy(out)
    if copy is None:
        if not Path(out).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()):  # a test's fixture: nothing to keep
            keep_dropped(marked, out)
        return
    n, moved, stayed = carry.carry_file(str(marked), str(built), str(copy))
    print(f"[md2pdf] {n} marks made after {copy.name} carried onto the clean rebuild", file=sys.stderr)


def own_build_script(out) -> Path | None:
    """A folder with its own build-*.sh that names this PDF builds it that way (house style, images, DOCX).
    2026-10-16: the generic render dropped 4 of 7 images from a document with its own build script."""
    o = Path(out).resolve()
    for sh in sorted(o.parent.glob("build*.sh")):
        try:
            if o.name in sh.read_text(encoding="utf-8", errors="ignore"):
                return sh
        except OSError:
            continue
    return None


def build_with_script(sh: Path, out: str, keep_marks: bool) -> int:
    # The folder's script writes the PDF itself, so the lock is held over the whole build: a save that arrives
    # meanwhile waits, and then lands on the rebuilt file (or is carried onto it), never under it.
    with tempfile.TemporaryDirectory() as tmp, file_lock(out):
        marked = Path(tmp) / "marked.pdf"
        if Path(out).exists() and has_marks(out):
            marked.write_bytes(Path(out).read_bytes())
        # The script learns which PDF was asked for: one that rebuilds only what changed must still rebuild
        # this one when the source did not change (an Apply whose comments changed no text left the PDF as it was).
        subprocess.run(["bash", str(sh)], cwd=sh.parent, check=True, capture_output=True, timeout=300,
                       env={**os.environ, "MD2PDF_OUT": str(Path(out).resolve())})
        if marked.exists():
            built = Path(tmp) / "built.pdf"
            built.write_bytes(Path(out).read_bytes())
            n0 = built.stat().st_size
            carry_marks(marked, built, out, keep_marks)
            if built.stat().st_size != n0:
                Path(out).write_bytes(built.read_bytes())
    print(f"[md2pdf] built with {sh.name}", file=sys.stderr)
    if not keep_marks:
        applying_flag(out).unlink(missing_ok=True)
    return 0


def main(src: str, out: str, keep_marks: bool = False) -> int:
    sh = own_build_script(out)
    if sh:
        return build_with_script(sh, out, keep_marks)
    html = render(Path(src).read_text(encoding="utf-8"))
    # The page is written to a temp dir: relative image paths must resolve against the .md's folder.
    html = html.replace("<head>", f'<head><base href="{Path(src).resolve().parent.as_uri()}/">', 1)
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "page.html"
        page.write_text(html, encoding="utf-8")
        built = Path(tmp) / "out.pdf"
        # No --allow-file-access-from-files: with it a script in the source read any file of this user into the
        # PDF or sent it out (burn review F2). Without it a file:// page cannot read another file, also when the
        # policy above is bypassed; a picture still loads (test/md2pdf-inert.py). Not --blink-settings=
        # scriptEnabled=false: with it this Chromium's headless print writes no PDF at all (tried 2026-11-14).
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                        f"--print-to-pdf={built}", page.as_uri()],
                       check=True, capture_output=True, timeout=120)
        with file_lock(out):  # the marks are read and the file written with no save in between
            # his own text edit (--keep-marks): every mark; an Apply: those made after the round's marked copy
            carry_marks(Path(out), built, out, keep_marks)
            Path(out).write_bytes(built.read_bytes())  # one write over the open file, so the viewer reloads once
    if not keep_marks:
        applying_flag(out).unlink(missing_ok=True)
    return 0


def register_for_chat(out: str) -> None:
    """A chat that builds a review PDF is its maker: register it, or the viewer hides Apply/Redo.
    2026-10-27: the Apply-comments button was missing on a PDF built with md2pdf alone.
    Runs `open-pdf --link`, which links the PDF into papers/open, records TC_SESSION_KEY and prints
    the viewer URL without opening a window. The server's own rebuilds have no session: no-op."""
    import os
    if not os.environ.get("TC_SESSION_KEY"):
        return
    r = subprocess.run([sys.executable, str(Path(__file__).with_name("open-pdf")), "--link", str(Path(out).resolve())],
                       capture_output=True, text=True, timeout=30)
    if r.stdout.strip():
        print(f"[md2pdf] review link: {r.stdout.strip()}", file=sys.stderr)
    elif r.returncode:
        print(f"[md2pdf] maker not registered: {r.stderr.strip()[:200]}", file=sys.stderr)


if __name__ == "__main__":
    rc = main(sys.argv[1], sys.argv[2], "--keep-marks" in sys.argv[3:])
    if rc == 0:
        register_for_chat(sys.argv[2])
    sys.exit(rc)
