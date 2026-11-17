#!/usr/bin/env python3
"""The server rebuilds a PDF from its .md (and so runs the folder's build*.sh, md2pdf.py own_build_script) only
inside his own document folders (BUILD_ROOTS, ~/Documents). A PDF opened from anywhere else (an archive unpacked
in ~/Downloads, a mail attachment, /tmp) gets nothing run: no watcher rebuild, no Edit text (burn review F1).
Usage: .venv/bin/python test/watcher-trust.py   (no server needed; everything happens in a temp folder)"""
import importlib.util, os, tempfile, time, types, unittest
from pathlib import Path
from unittest import mock

APP = Path(__file__).resolve().parent.parent
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


class _Stop(BaseException):
    pass


def _stop(_seconds):
    raise _Stop()


class WatcherTrust(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        t = Path(tmp.name).resolve()
        env = mock.patch.dict(os.environ, {"PDF_REVIEW_BUILD_ROOTS": str(t / "Documents"), "PDF_REVIEW_STATE": str(t / "state")})
        env.start()
        self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location("pdf_review_server", APP / "server.py")
        self.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.server)
        root = t / "app"  # a stand-in app folder: its own papers/ and state/, the real scripts
        root.mkdir()
        for name in ("md2pdf.py", "pdf-carry-marks.py", "pdf-comments.py"):
            (root / name).symlink_to(APP / name)
        self.server.ROOT = root
        self.server.APPLYING = root / "state" / "applying"
        self.outside = self.plant(t / "Downloads" / "paper", root, "0123456789")  # what an unpacked archive leaves
        self.inside = self.plant(t / "Documents" / "paper", root, "9876543210")   # his own document folder

    @staticmethod
    def plant(folder, root, key):
        """A PDF, a newer .md and a build.sh that names the PDF, linked under papers/open/ as open-pdf does."""
        folder.mkdir(parents=True)
        pdf = folder / "paper.pdf"
        pdf.write_bytes(PDF)
        before = time.time() - 60
        os.utime(pdf, (before, before))  # the .md is newer than the PDF
        (folder / "paper.md").write_text("# hi\n", encoding="utf-8")
        (folder / "build.sh").write_text("touch ran.txt  # builds paper.pdf\n", encoding="utf-8")
        link = root / "papers" / "open" / key / "paper.pdf"
        link.parent.mkdir(parents=True)
        link.symlink_to(pdf)
        return folder

    def one_pass(self):
        """The watcher's loop, once: the sleep that ends a pass stops it (server.py's own `time` only). Since
        2026-11-15 the watcher hands a stale PDF to the Builder; its thread is not running here, so the files it
        was handed are built in this thread, as the Builder would."""
        shim = types.SimpleNamespace(time=time.time, strftime=time.strftime, sleep=_stop)
        with mock.patch.object(self.server, "time", shim):
            try:
                self.server.watch_sources()
            except _Stop:
                pass
        b = self.server.BUILDER
        for key in list(b.dirty):
            b.dirty.pop(key)
            b._build(Path(key))

    def source_for(self, key):
        h = self.server.Handler.__new__(self.server.Handler)
        h.path = f"/api/source?path=/papers/open/{key}/paper.pdf"
        return h._source_target()

    def test_a_pdf_opened_outside_his_documents_gets_nothing_run(self):
        self.one_pass()
        self.assertFalse((self.outside / "ran.txt").exists(), "the build.sh beside a PDF in Downloads was run")

    def test_a_pdf_in_his_documents_is_still_rebuilt(self):
        self.one_pass()
        self.assertTrue((self.inside / "ran.txt").exists(), "a PDF under Documents was not rebuilt by its folder's script")

    def test_edit_text_only_inside_his_documents(self):
        self.assertIsNone(self.source_for("0123456789"), "Edit text offered for a PDF outside his documents")
        self.assertEqual(self.source_for("9876543210"), self.inside / "paper.md")


if __name__ == "__main__":
    unittest.main()
