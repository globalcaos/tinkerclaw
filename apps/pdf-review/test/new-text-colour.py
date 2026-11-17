"""md2pdf must print a review round's new text (class nw) in pdf-colours.NEW, in a paragraph, bold words, a list
item and an inline span alike, and leave old text grey. 2026-11-14: md2pdf gave every <p> and <li> its own grey,
so the colour on a wrapping <div class="nw"> never reached the page, and the book chapter PDFs showed every
round's changes in grey. Usage: python3 test/new-text-colour.py [path/to/md2pdf.py]"""
import importlib.util, os, subprocess, sys, tempfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
_VENV_PY = APP / ".venv" / "bin" / "python"
try:  # PyMuPDF lives in the reader's .venv, not in the Pi's system Python
    import pymupdf  # noqa: F401
except ImportError:
    if _VENV_PY.is_file() and Path(sys.prefix).resolve() != _VENV_PY.parent.parent.resolve():
        os.execv(str(_VENV_PY), [str(_VENV_PY), __file__, *sys.argv[1:]])
    raise

MD2PDF = Path(sys.argv[1]) if len(sys.argv) > 1 else APP / "md2pdf.py"
SRC = """# Colour test

Old paragraph oldwordgrey stays grey.

<div class="nw" markdown="1">

New paragraph newwordpara with **newwordbold** inside.

- new list item newwordlist

</div>

Old paragraph with <span class="nw">newwordspan</span> inside.
"""
WANT = {"oldwordgrey": False, "newwordpara": True, "newwordbold": True, "newwordlist": True, "newwordspan": True}

spec = importlib.util.spec_from_file_location("pdf_colours", APP / "pdf-colours.py")
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)
env = {k: v for k, v in os.environ.items() if k != "TC_SESSION_KEY"}  # a test PDF is never linked to a chat
with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp)
    (d / "nw-colour-test.md").write_text(SRC, encoding="utf-8")
    out = d / "nw-colour-test.pdf"
    subprocess.run([sys.executable, str(MD2PDF), str(d / "nw-colour-test.md"), str(out)],
                   check=True, capture_output=True, env=env, timeout=180)
    seen = {w: colour for _, text, colour in pc.spans(out) for w in WANT if w in text}
fails = 0
for word, is_new in WANT.items():
    colour = seen.get(word)
    ok = colour is not None and (colour == pc.NEW) == is_new
    fails += not ok
    print(f"{'PASS' if ok else 'FAIL'} {word} printed {colour or 'nowhere'}, wanted {'new ' + pc.NEW if is_new else 'not ' + pc.NEW}")
sys.exit(1 if fails else 0)
