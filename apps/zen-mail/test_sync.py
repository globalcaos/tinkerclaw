"""python3 test_sync.py — a mailbox the sync skips is reported, not silent (2026-10-21).

On the Pi the settings had no addresses: every hourly run skipped both mailboxes, wrote no log line and saved no
status, so the page showed no banner and the list sat nearly empty for days. A skip must reach the log and the page.
"""
import io, os, sys, tempfile, types
os.environ["ZEN_MAIL_DATA"] = tempfile.mkdtemp(prefix="zen-sync-test-")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# The streams and the butler call the gateway and a model; this test is about the mailbox loop only.
for name, attrs in (("dams", {"release": lambda c: None}), ("streams", {"collect": lambda c: None}),
                    ("butler", {"butler_pass": lambda c: None})):
    sys.modules[name] = types.SimpleNamespace(**attrs)
import common
assert str(sys.modules["common"].DATA).startswith(tempfile.gettempdir()), "refusing to run against " + str(sys.modules["common"].DATA)  # 2026-10-27: a test run on an already-loaded common rewrote 58 real cards
lines = []
common.log = lambda *a: lines.append(" ".join(str(x) for x in a))
import sync
sync.log = common.log

assert sync.main() == 0
status = common.meta_get(common.db(), "status", {})
for acct in common.settings()["accounts"]:  # default settings carry no addresses
    assert status.get(acct, {}).get("ok") is False, (acct, status)
    assert "No address" in status[acct]["error"], status[acct]
    assert any(acct in l and "no address" in l.lower() for l in lines), (acct, lines)
print("ok: a skipped mailbox is logged and saved for the page")
