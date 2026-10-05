#!/usr/bin/env python3
"""Focused tests for credential handling. Everything runs in a temp dir with a fake
$HOME and a fake $PATH — no real keychain, no real credential, no network."""

import importlib.util
import os
import stat
import sys
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL))

PASS = FAIL = 0
def ok(m):
    global PASS; PASS += 1; print(f"  \033[32mPASS\033[0m {m}")
def no(m, d=""):
    global FAIL; FAIL += 1; print(f"  \033[31mFAIL\033[0m {m}\n       {d}")
def check(cond, m, d=""):
    ok(m) if cond else no(m, d)

import secretstore as ss

with tempfile.TemporaryDirectory() as td:
    T = Path(td)

    print("== keychain helpers are never taken from $PATH ==")
    fakebin = T / "bin"
    fakebin.mkdir()
    for name in ("secret-tool", "security"):
        f = fakebin / name
        f.write_text("#!/bin/sh\ncat > /dev/null\n")
        f.chmod(0o755)
    old_path = os.environ.get("PATH", "")
    os.environ["PATH"] = f"{fakebin}:{old_path}"
    for name in ("secret-tool", "security"):
        resolved = ss._tool(name)
        check(resolved is None or not resolved.startswith(str(fakebin)),
              f"{name} resolves from a trusted system dir, not the planted PATH entry",
              f"got {resolved}")
    os.environ["PATH"] = old_path

    print("== fallback store: owner-only, atomic, never through a symlink ==")
    ss.FALLBACK_DIR = T / "store"
    ss.FALLBACK_FILE = ss.FALLBACK_DIR / "credentials"
    ss._write_fallback({"openai": "sk-one"})
    mode = stat.S_IMODE(os.lstat(ss.FALLBACK_FILE).st_mode)
    check(mode == 0o600, "fallback file is 0600", oct(mode))
    check(stat.S_IMODE(os.lstat(ss.FALLBACK_DIR).st_mode) == 0o700, "fallback dir is 0700")
    check(ss._read_fallback() == {"openai": "sk-one"}, "round-trips a credential")
    check(not list(ss.FALLBACK_DIR.glob(".credentials.*.tmp")), "no temp file left behind")

    try:
        ss._write_fallback({"openai": "sk\nINJECTED=1"})
        no("refuses a credential containing a newline", "it wrote it")
    except ValueError:
        check(ss._read_fallback() == {"openai": "sk-one"},
              "refuses a credential containing a newline, store untouched")

    victim = T / "victim.txt"
    victim.write_text("keep me")
    ss.FALLBACK_FILE.unlink()
    ss.FALLBACK_FILE.symlink_to(victim)
    try:
        ss._write_fallback({"openai": "sk-two"})
        no("refuses a symlinked credential file", "it wrote through the link")
    except PermissionError:
        check(victim.read_text() == "keep me", "refuses a symlinked credential file, target untouched")
    try:
        ss._read_fallback()
        no("refuses to READ a symlinked credential file", "it followed the link")
    except PermissionError:
        ok("refuses to READ a symlinked credential file")
    ss.FALLBACK_FILE.unlink()

    realdir = T / "elsewhere"
    realdir.mkdir()
    ss.FALLBACK_DIR = T / "linkedstore"
    ss.FALLBACK_DIR.symlink_to(realdir)
    ss.FALLBACK_FILE = ss.FALLBACK_DIR / "credentials"
    try:
        ss._write_fallback({"openai": "sk-three"})
        no("refuses a symlinked store directory", "it wrote into the link")
    except PermissionError:
        check(not (realdir / "credentials").exists(), "refuses a symlinked store directory")

    print("== the two Anthropic credential kinds never share a slot ==")
    check("anthropic-admin" in ss.PROVIDERS, "a separate anthropic-admin slot exists")
    check(ss.PROVIDERS["anthropic"]["also_env"] is None,
          "the subscription-token slot cannot be filled from ANTHROPIC_ADMIN_API_KEY")
    ss.backend = lambda: "file"
    ss.FALLBACK_DIR = T / "empty"
    ss.FALLBACK_FILE = ss.FALLBACK_DIR / "credentials"
    for k in ("TOKEN_PANEL_ANTHROPIC_TOKEN", "TOKEN_PANEL_ANTHROPIC_ADMIN_KEY"):
        os.environ.pop(k, None)
    os.environ["ANTHROPIC_ADMIN_API_KEY"] = "sk-ant-admin-test"
    os.environ["TOKEN_PANEL_ALLOW_PROVIDER_ENV"] = "1"
    check(ss.get_secret("anthropic") == (None, None),
          "an Admin key in the env is NOT handed to the OAuth usage fetcher")
    check(ss.get_secret("anthropic-admin")[0] == "sk-ant-admin-test",
          "the Admin slot honours ANTHROPIC_ADMIN_API_KEY with the opt-in")
    del os.environ["TOKEN_PANEL_ALLOW_PROVIDER_ENV"]
    check(ss.get_secret("anthropic-admin") == (None, None),
          "…and ignores it without the opt-in")
    del os.environ["ANTHROPIC_ADMIN_API_KEY"]
    src = (SKILL / "parsers" / "anthropic.py").read_text()
    check('get_secret("anthropic-admin")' in src and 'get_secret("anthropic")' not in src,
          "the Admin API parser reads only the anthropic-admin slot")

print("== Gemini key is sent in a header, never in a URL ==")
spec = importlib.util.spec_from_file_location("gfetch", SKILL / "scripts" / "gemini-usage-fetch.py")
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
seen = []
class _Stop(Exception):
    pass
def fake_urlopen(req, timeout=None):
    seen.append(req)
    raise _Stop("boom AIzaSECRETKEY boom")
g.urllib.request.urlopen = fake_urlopen
r1 = g.list_models("AIzaSECRETKEY")
r2 = g.probe_model("AIzaSECRETKEY", "gemini-2.5-flash")
check(all("AIzaSECRETKEY" not in req.full_url for req in seen), "no request URL contains the key")
check(all(req.get_header("X-goog-api-key") == "AIzaSECRETKEY" for req in seen),
      "every request carries the key in x-goog-api-key")
check("AIzaSECRETKEY" not in str(r1) and "AIzaSECRETKEY" not in str(r2),
      "error strings are redacted before they are returned")

print("== Claude fetcher identifies itself honestly ==")
csrc = (SKILL / "scripts" / "claude-usage-fetch.py").read_text()
check("'User-Agent': 'claude-code/" not in csrc, "no Claude Code User-Agent impersonation")

print("== REST API: constant-time token check, identifier-only inputs ==")
try:
    import api
    from pydantic import ValidationError
except ImportError as e:
    print(f"  SKIP api checks ({e})")
else:
    asrc = (SKILL / "api.py").read_text()
    check("hmac.compare_digest" in asrc, "mutate token compared in constant time")
    try:
        api.UsageRecord(provider="<img src=x onerror=alert(1)>", model="m",
                        input_tokens=1, output_tokens=1)
        no("rejects markup in provider", "accepted")
    except ValidationError:
        ok("rejects markup in provider")
    try:
        api.UsageRecord(provider="anthropic", model="claude-opus-4-5",
                        input_tokens=-5, output_tokens=1)
        no("rejects negative token counts", "accepted")
    except ValidationError:
        ok("rejects negative token counts")
    rec = api.UsageRecord(provider="anthropic", model="claude-opus-4-5",
                          input_tokens=10, output_tokens=2)
    check(rec.provider == "anthropic", "accepts a normal usage record")

print(f"\ntoken-panel-ultimate credentials: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
