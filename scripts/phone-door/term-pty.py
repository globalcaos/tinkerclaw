#!/usr/bin/env python3
"""term-pty.py: one login shell in a real pseudo-terminal, for the phone door's terminal page.

Why (the architect, 2026-10-20): a terminal on the Pi he can open from the Jarvis app to run `claude` and
repair JarvisPi when the gateway hangs. The door (door.mjs) owns auth and the WebSocket; this helper
only owns the pty, so a hung gateway or Tinker page server cannot take the terminal down with it.

Protocol (door <-> helper):
  stdin : one JSON object per line: {"t":"i","d":"<text typed>"} or {"t":"r","c":<cols>,"r":<rows>}
  stdout: the raw bytes the shell writes to its terminal
The helper exits when the shell exits or stdin closes; the shell gets SIGHUP when the helper ends.
Since 2026-10-22 the "shell" is a tmux client of pi-term.service's session: SIGHUP only detaches it.
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
    except (OSError, ValueError, TypeError):
        pass


def main():
    shell = os.environ.get("SHELL") or "/bin/bash"
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(os.path.expanduser("~"))
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        # Attach to the persistent session (pi-term.service) so a door or app restart only detaches
        # the phone; Claude keeps running. A plain login shell if that session is not up.
        os.execvp("sh", ["sh", "-c", 'tmux -L jarvis attach -t jarvis 2>/dev/null || exec "$0" -l', shell])
    set_size(fd, 80, 24)
    stdin = sys.stdin.buffer
    out = sys.stdout.buffer
    pending = b""
    try:
        while True:
            r, _, _ = select.select([fd, stdin], [], [])
            if fd in r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                out.write(data)
                out.flush()
            if stdin in r:
                chunk = os.read(stdin.fileno(), 65536)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    if msg.get("t") == "i" and isinstance(msg.get("d"), str):
                        os.write(fd, msg["d"].encode("utf-8", "replace"))
                    elif msg.get("t") == "r":
                        set_size(fd, msg.get("c", 80), msg.get("r", 24))
    finally:
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass


if __name__ == "__main__":
    main()
