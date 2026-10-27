"""Test harness for ask-session.

Every test runs against a temporary HOME, a temporary OPENCLAW_STATE_DIR and a
temporary projects dir. An audit hook makes any attempt to touch the REAL
~/.openclaw or ~/.claude raise and fail the test, so a bug in the code under
test cannot read or write the owner's sessions or catalogue.
"""

import importlib.util
import json
import os
import subprocess
import sys
import textwrap

import pytest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(SKILL, "scripts")

_REAL_HOME = os.path.expanduser("~")
_FORBIDDEN = tuple(
    os.path.realpath(os.path.join(_REAL_HOME, d)) for d in (".openclaw", ".claude")
)
_guard = {"on": False, "hits": []}

_WATCHED = {
    "open", "os.listdir", "os.scandir", "glob.glob", "os.mkdir", "os.remove",
    "os.rename", "os.rmdir", "shutil.rmtree", "shutil.copyfile", "sqlite3.connect",
    "subprocess.Popen", "os.chdir", "os.truncate",
}


def _bad(value):
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not isinstance(value, str) or not value:
        return False
    full = os.path.realpath(os.path.abspath(os.path.expanduser(value)))
    return any(full == f or full.startswith(f + os.sep) for f in _FORBIDDEN)


def _audit(event, args):
    if not _guard["on"] or event not in _WATCHED:
        return
    flat = []
    for a in args:
        if isinstance(a, (list, tuple)):
            flat.extend(a)
        else:
            flat.append(a)
    for a in flat:
        if isinstance(a, (str, bytes, os.PathLike)) and _bad(os.fspath(a)):
            _guard["hits"].append((event, os.fspath(a)))
            raise PermissionError(f"test touched the real home: {event} {a}")


sys.addaudithook(_audit)


def load_module():
    spec = importlib.util.spec_from_file_location("sessions_under_test", os.path.join(SCRIPTS, "sessions.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    state = tmp_path / "state"
    projects = tmp_path / "projects"
    for d in (home, state, projects):
        d.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("OPENCLAW_STATE_DIR", str(state))
    for var in ("TC_SESSION_KEY", "OPENCLAW_SUBAGENT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID",
                "ASK_SESSION_CLAUDE", "ASK_SESSION_MEMORY_INDEX", "ASK_SESSION_WAKE", "XDG_CONFIG_HOME"):
        monkeypatch.delenv(var, raising=False)
    # A stub `claude` sits first on PATH, so a test that forgets to install its own fake
    # can never reach the real one. A test's fake goes in front of it and wins.
    stub_dir = tmp_path / "stub-bin"
    stub_dir.mkdir()
    stub_log = tmp_path / "real-claude-would-have-run.log"
    stub = stub_dir / "claude"
    stub.write_text(f"#!/bin/sh\necho \"$@\" >> {str(stub_log)!r}\nexit 99\n")
    stub.chmod(0o755)
    monkeypatch.setenv("PATH", f"{stub_dir}{os.pathsep}{os.environ['PATH']}")
    _guard["hits"].clear()
    _guard["on"] = True
    mod = load_module()
    ns = type("Env", (), {})()
    ns.home, ns.state, ns.projects, ns.tmp, ns.mod = home, state, projects, tmp_path, mod
    try:
        yield ns
    finally:
        _guard["on"] = False
    assert not _guard["hits"], f"touched the real ~/.openclaw or ~/.claude: {_guard['hits']}"
    assert not stub_log.exists(), f"a test reached for the real claude: {stub_log.read_text()}"


# ------------------------------------------------------------ fixture builders

def rec_user(text, ts, cwd="/tmp", **extra):
    r = {"type": "user", "timestamp": ts, "cwd": cwd, "message": {"role": "user", "content": text}}
    r.update(extra)
    return r


def rec_tool_result(ts, cwd="/tmp"):
    return {"type": "user", "timestamp": ts, "cwd": cwd,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": "ok"}]}}


def rec_assistant(ts, text=None, tools=(), usage=None, cwd="/tmp"):
    content = []
    if text:
        content.append({"type": "text", "text": text})
    for name, fp in tools:
        key = "notebook_path" if name == "NotebookEdit" else "file_path"
        content.append({"type": "tool_use", "id": "t", "name": name, "input": {key: fp}})
    r = {"type": "assistant", "timestamp": ts, "cwd": cwd,
         "message": {"role": "assistant", "content": content}}
    if usage:
        r["message"]["usage"] = usage
    return r


def write_session(projects, sid, records, project="-tmp-proj", mtime=None):
    d = projects / project
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{sid}.jsonl"
    with open(p, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


def stamp(day="2026-10-01", hm="10:00", dow="Thu"):
    return f"[{dow} {day} {hm} GMT+2]"


def make_fake_claude(tmp_path, answer="The answer is 42.", exit_code=0, sleep=0, ignore_term=False, append_to=None):
    """A fake `claude` that logs its argv, cwd and env, then prints a JSON result. With `append_to`
    it also appends two transcript lines to that file, as a real in-place wake does."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "claude-calls.jsonl"
    script = bindir / "claude"
    script.write_text(textwrap.dedent(f"""\
        #!{sys.executable} -I
        import json, os, signal, sys, time
        with open({str(log)!r}, "a") as fh:
            fh.write(json.dumps({{"argv": sys.argv[1:], "cwd": os.getcwd(), "env": dict(os.environ)}}) + "\\n")
        if {ignore_term}:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep({sleep})
        if {str(append_to) if append_to else ""!r}:
            with open({str(append_to) if append_to else ""!r}, "a") as fh:
                fh.write(json.dumps({{"type": "user", "message": {{"role": "user", "content": sys.argv[-1]}}}}) + "\\n")
                fh.write(json.dumps({{"type": "assistant", "message": {{"role": "assistant",
                                      "content": [{{"type": "text", "text": {answer!r}}}]}}}}) + "\\n")
        print(json.dumps({{"type": "result", "is_error": {exit_code != 0}, "result": {answer!r},
                          "usage": {{"input_tokens": 3, "cache_creation_input_tokens": 1000,
                                     "cache_read_input_tokens": 0, "output_tokens": 50}}}}))
        sys.exit({exit_code})
    """))
    script.chmod(0o755)
    return bindir, log


def git(repo, *args, env_extra=None):
    e = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@e", GIT_COMMITTER_NAME="t",
             GIT_COMMITTER_EMAIL="t@e", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    if env_extra:
        e.update(env_extra)
    return subprocess.run(["git", "-C", str(repo)] + list(args), check=True, capture_output=True, text=True, env=e)
