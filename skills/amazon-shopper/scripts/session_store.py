"""session_store.py — keychain-first storage for the amazon.es session cookies.

Python mirror of scripts/session-store.mjs: same service/account, same file
fallback, so the Node capture and this fetcher read and write one secret.

  1. Linux  - libsecret via `secret-tool` (value on STDIN, never in argv).
  2. macOS  - Keychain via `security` (value on STDIN, never in argv).
  3. Fallback - a 0600 JSON file, WITH A WARNING printed every run.

Off switch: `node scripts/session-capture.mjs --logout` clears both stores.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys

SERVICE = "amazon-shopper"
ACCOUNT = "amazon-session"
LABEL = "amazon-shopper amazon.es session cookies"
FILE_PATH = pathlib.Path(os.environ.get("HOME", "")) / ".openclaw" / "credentials" / "amazon-session.json"

# Amazon's own server-side revoke: change the password / sign out of all devices.
REVOKE_URL = "https://www.amazon.es/gp/css/account/info/view.html"

_warned = False


def _warn_file():
    global _warned
    if _warned:
        return
    _warned = True
    sys.stderr.write(
        "WARNING: no OS keychain found (neither `secret-tool` nor macOS `security`), so your "
        "amazon.es session cookies are stored in a plain file at %s with mode 0600. "
        "Any process running as this user can read them. Install libsecret-tools "
        "(Debian/Ubuntu: `apt install libsecret-tools`) to use the keychain instead. "
        "Remove them at any time with `node scripts/session-capture.mjs --logout`.\n" % FILE_PATH
    )


def backend() -> str:
    if os.environ.get("AMAZON_SHOPPER_SESSION_FILE_ONLY") == "1":
        return "file"
    if sys.platform == "darwin" and shutil.which("security"):
        return "macos"
    if shutil.which("secret-tool"):
        return "libsecret"
    return "file"


def load():
    """Return (data, source) or (None, None) when nothing is stored."""
    b = backend()
    if b == "libsecret":
        r = subprocess.run(
            ["secret-tool", "lookup", "service", SERVICE, "account", ACCOUNT],
            capture_output=True, text=True,
        )
        if r.returncode == 0 and r.stdout.strip():
            return json.loads(r.stdout), "keychain:libsecret"
    elif b == "macos":
        r = subprocess.run(
            ["security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
            capture_output=True, text=True,
        )
        if r.returncode == 0 and r.stdout.strip():
            return json.loads(r.stdout), "keychain:macos"
    if FILE_PATH.exists():
        _warn_file()
        return json.loads(FILE_PATH.read_text()), "file"
    return None, None


def save(data) -> str:
    """Persist the session. Returns the backend actually used."""
    payload = json.dumps(data, indent=1)
    b = backend()
    if b == "libsecret":
        r = subprocess.run(
            ["secret-tool", "store", "--label=" + LABEL, "service", SERVICE, "account", ACCOUNT],
            input=payload, text=True,
        )
        if r.returncode == 0:
            return "keychain:libsecret"
    elif b == "macos":
        # `-w` with NO value makes `security` read the secret from stdin instead
        # of taking it from argv. argv is world-readable via `ps` for the life of
        # the call, so passing the cookie payload there briefly published a
        # credential to every local process. Fixed 1.2.0.
        r = subprocess.run(
            ["security", "add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w"],
            input=payload + "\n", text=True, capture_output=True,
        )
        if r.returncode == 0:
            return "keychain:macos"
    _warn_file()
    FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE_PATH.with_suffix(".tmp")
    tmp.write_text(payload)
    os.chmod(tmp, 0o600)
    os.replace(tmp, FILE_PATH)
    os.chmod(FILE_PATH, 0o600)
    return "file"
