#!/usr/bin/env python3
"""Tinkerclaw local helper: the Chrome native-messaging host behind the Browser Relay plugin.

FORK 2026-10-15 (the architect: when the agent runs on another machine, a file link should open "the
right local app" and Jarvis's voice should come out of this machine's speaker, both through the
browser plugin). The Tinker page asks the plugin, the plugin asks this helper. Chrome starts it
per message and talks over stdin/stdout: a 4-byte little-endian length, then UTF-8 JSON.

Actions:
  ping                         -> {"ok": true, "host": <hostname>}
  open {path}                  -> opens a file that exists HERE with its default app
  open {path, name, base64}    -> writes the bytes to ~/.cache/tinkerclaw-local/ and opens that
                                  (missing here: {"ok": false, "missing": true}, page sends bytes)
  play {base64}                -> plays a WAV on this machine's speaker, unless Jarvis is muted

Never opens an executable, a script or a desktop launcher: xdg-open on those would run code.
"""
import json
import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
from base64 import b64decode

HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "tinkerclaw-local")
REFUSED_EXT = {
    ".desktop", ".sh", ".bash", ".zsh", ".py", ".pl", ".rb", ".js", ".mjs", ".jar", ".run",
    ".bin", ".appimage", ".exe", ".bat", ".cmd", ".deb", ".rpm", ".so",
}


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def refuse_reason(path):
    if os.path.splitext(path)[1].lower() in REFUSED_EXT:
        return "refused: launchers and scripts are never opened"
    if os.access(path, os.X_OK):
        return "refused: executable file"
    return None


def xdg_open(path):
    subprocess.Popen(
        ["xdg-open", path],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def do_open(msg):
    path = os.path.expanduser(str(msg.get("path") or ""))
    if msg.get("base64"):
        name = re.sub(r"[^\w.\- ]", "_", os.path.basename(str(msg.get("name") or path or "file")))
        name = name.lstrip(".") or "file"
        os.makedirs(CACHE, mode=0o700, exist_ok=True)
        target = os.path.join(CACHE, name)
        reason = refuse_reason(target)
        if reason:
            return {"ok": False, "error": reason}
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(b64decode(msg["base64"]))
        os.chmod(target, 0o600)
        xdg_open(target)
        return {"ok": True, "opened": target, "copied": True}
    if not path or not os.path.isabs(path) or ".." in path.split(os.sep):
        return {"ok": False, "error": "absolute path required"}
    if not os.path.isfile(path):
        return {"ok": False, "missing": True}
    reason = refuse_reason(path)
    if reason:
        return {"ok": False, "error": reason}
    xdg_open(path)
    return {"ok": True, "opened": path}


def muted():
    if os.environ.get("JARVIS_MUTE") == "1":
        return True
    if os.path.exists(os.path.join(HOME, ".openclaw", "jarvis-voice.mute")):
        return True
    try:
        with open(os.path.join(HOME, ".openclaw", "data", "jarvis-muted.json")) as f:
            return bool(json.load(f).get("muted"))
    except (OSError, ValueError):
        return False


def do_play(msg):
    if muted():
        return {"ok": True, "muted": True}
    fd, wav = tempfile.mkstemp(prefix="jarvis-", suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        f.write(b64decode(msg.get("base64") or ""))
    # Detached so Chrome is not held for the length of the sentence; the player removes the file.
    subprocess.Popen(
        ["sh", "-c", 'paplay "$1" 2>/dev/null || aplay -q "$1"; rm -f "$1"', "play", wav],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"ok": True, "playing": True}


def main():
    msg = read_message()
    if not isinstance(msg, dict):
        return
    action = msg.get("action")
    try:
        if action == "ping":
            send({"ok": True, "host": socket.gethostname()})
        elif action == "open":
            send(do_open(msg))
        elif action == "play":
            send(do_play(msg))
        else:
            send({"ok": False, "error": f"unknown action {action!r}"})
    except Exception as err:  # the plugin shows the text; the helper must always answer
        send({"ok": False, "error": f"{type(err).__name__}: {err}"})


if __name__ == "__main__":
    main()
