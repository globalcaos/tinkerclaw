"""md2pdf must hand a PDF to its folder's own build*.sh when that script names the PDF (2026-10-16:
the generic render dropped 4 of 7 images on the architect's edit of a document with its own build script).
Usage: python3 test/build-script.py [path/to/md2pdf.py]"""
import subprocess, sys, tempfile
from pathlib import Path

MD2PDF = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "md2pdf.py"
with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp)
    (d / "doc.md").write_text("# hi\n", encoding="utf-8")
    (d / "build-doc.sh").write_text("echo built > ran.txt\ncp /dev/null doc.pdf  # doc.pdf\n", encoding="utf-8")
    subprocess.run(["python3", str(MD2PDF), str(d / "doc.md"), str(d / "doc.pdf")], capture_output=True)
    ok = (d / "ran.txt").is_file()
    print(("PASS" if ok else "FAIL") + " folder build script used")
    sys.exit(0 if ok else 1)
