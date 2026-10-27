"""Feeds the helper Chrome's wire format: python3 -I test_tinkerclaw_local.py"""
import base64, json, os, struct, subprocess, sys, tempfile

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tinkerclaw_local.py")


def ask(msg, home):
    data = json.dumps(msg).encode()
    env = dict(os.environ, HOME=home, PATH=f"{home}/bin:" + os.environ["PATH"])
    out = subprocess.run([sys.executable, "-I", HOST], input=struct.pack("<I", len(data)) + data,
                         capture_output=True, env=env, timeout=10).stdout
    (n,) = struct.unpack("<I", out[:4])
    return json.loads(out[4:4 + n])


with tempfile.TemporaryDirectory() as home:
    os.makedirs(f"{home}/bin")
    log = f"{home}/opened.log"
    for tool in ("xdg-open", "paplay"):  # record instead of opening or playing
        with open(f"{home}/bin/{tool}", "w") as f:
            f.write(f'#!/bin/sh\necho "{tool} $1" >> {log}\n')
        os.chmod(f"{home}/bin/{tool}", 0o755)
    doc = f"{home}/doc.pdf"
    open(doc, "wb").write(b"%PDF")
    script = f"{home}/evil.sh"
    open(script, "w").write("echo hi")
    assert ask({"action": "ping"}, home)["ok"]
    assert ask({"action": "open", "path": doc}, home) == {"ok": True, "opened": doc}
    assert ask({"action": "open", "path": f"{home}/nope.md"}, home) == {"ok": False, "missing": True}
    assert "refused" in ask({"action": "open", "path": script}, home)["error"]
    assert "refused" in ask({"action": "open", "name": "x.desktop", "base64": "eA=="}, home)["error"]
    r = ask({"action": "open", "path": "/pi/n.md", "name": "../n.md", "base64": base64.b64encode(b"# hi").decode()}, home)
    assert r["ok"] and r["opened"] == f"{home}/.cache/tinkerclaw-local/n.md", r
    assert oct(os.stat(r["opened"]).st_mode & 0o777) == "0o600"
    assert ask({"action": "play", "base64": "UklGRg=="}, home) == {"ok": True, "playing": True}
    os.makedirs(f"{home}/.openclaw")
    open(f"{home}/.openclaw/jarvis-voice.mute", "w").close()
    assert ask({"action": "play", "base64": "UklGRg=="}, home) == {"ok": True, "muted": True}
    assert ask({"action": "rm"}, home)["ok"] is False
    import time; time.sleep(0.5)
    print(open(log).read().strip().replace(home, "~"))
print("helper tests ok")
