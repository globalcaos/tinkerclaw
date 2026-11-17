"""One lock per PDF, shared by server.py (a save, a carry) and md2pdf.py (a rebuild's last read and write).

A rebuild reads the file's marks, builds for a few seconds, then writes. A save that lands between that read and
that write was answered 200 and then overwritten: the device dropped its copy because the Pi said it had it
(2026-11-15). Holding this lock over "read the marks, write the file" on both sides closes that window.
"""
import contextlib
import fcntl
import hashlib
import tempfile
from pathlib import Path

LOCKS = Path(tempfile.gettempdir()) / "pdf-review-locks"


@contextlib.contextmanager
def file_lock(pdf):
    LOCKS.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha1(str(Path(pdf).resolve()).encode()).hexdigest()[:16] + ".lock"
    with open(LOCKS / name, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
