"""md2pdf prints a page that runs no script and reads no file, whatever the Markdown holds (burn review 2026-11-13
F2: a .md can come from an unpacked archive, from /api/paragraph, or from text an agent pasted in, and Chrome ran
its <script> with --allow-file-access-from-files). One real build: the text and the picture must still print.
Usage: python3 test/md2pdf-inert.py [path/to/md2pdf.py]"""
import os, subprocess, sys, tempfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
_VENV_PY = APP / ".venv" / "bin" / "python"
try:  # PyMuPDF lives in the reader's .venv, not in the Pi's system Python
    import pymupdf
except ImportError:
    if _VENV_PY.is_file() and Path(sys.prefix).resolve() != _VENV_PY.parent.parent.resolve():
        os.execv(str(_VENV_PY), [str(_VENV_PY), __file__, *sys.argv[1:]])
    raise

MD2PDF = Path(sys.argv[1]) if len(sys.argv) > 1 else APP / "md2pdf.py"
env = {k: v for k, v in os.environ.items() if k != "TC_SESSION_KEY"}  # a test PDF is never linked to a chat
with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp)
    secret = d / "secret.txt"
    secret.write_text("CANARYSECRET42", encoding="utf-8")
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 40), False)
    pix.clear_with(120)
    pix.save(str(d / "pic.png"))
    pix.clear_with(30)
    pix.save(str(d / "abs.png"))
    write = "document.body.insertAdjacentText('beforeend'"
    (d / "inert-test.md").write_text(
        f"# Inert test\n\nplainwordvisible stays on the page.\n\n![a picture](pic.png)\n\n![by file url]({(d / 'abs.png').as_uri()})\n\n"
        f"<script>{write}, ' SCRIPTRAN ');\n"
        f"var x = new XMLHttpRequest(); x.open('GET', '{secret.as_uri()}', false); x.send(); {write}, x.responseText);</script>\n\n"
        f"<img src=\"missing.png\" onerror=\"{write}, ' HANDLERRAN ')\">\n", encoding="utf-8")
    out = d / "inert-test.pdf"
    subprocess.run([sys.executable, str(MD2PDF), str(d / "inert-test.md"), str(out)],
                   check=True, capture_output=True, env=env, timeout=180)
    doc = pymupdf.open(out)
    text = "".join(p.get_text() for p in doc)
    # Ours are 60x40; a picture that did not load prints as Chrome's broken-picture icon, which is another size.
    images = sum(1 for p in doc for im in p.get_images() if (im[2], im[3]) == (60, 40))
checks = [
    ("the text prints", "plainwordvisible" in text),
    ("both pictures print (relative and file://)", images == 2),
    ("no script ran", "SCRIPTRAN" not in text),
    ("no inline handler ran", "HANDLERRAN" not in text),
    ("no local file was read into the page", "CANARYSECRET42" not in text),
]
for what, ok in checks:
    print(f"{'PASS' if ok else 'FAIL'} {what}")
sys.exit(0 if all(ok for _, ok in checks) else 1)
