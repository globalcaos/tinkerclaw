#!/usr/bin/env python3
"""Focused tests: the budget DB and the usage JSONs must be owner-only and must
never be written through a symlink. Everything runs in a temp dir — no real
database, no real usage file, no network."""

import importlib.util
import os
import stat
import sys
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL))
sys.path.insert(0, str(SKILL / "scripts"))

import db as dbmod
from _secure_write import write_private_json

PASS = FAIL = 0
def ok(m):
    global PASS; PASS += 1; print(f"  \033[32mPASS\033[0m {m}")
def no(m, d=""):
    global FAIL; FAIL += 1; print(f"  \033[31mFAIL\033[0m {m}\n       {d}")
def check(cond, m, d=""):
    ok(m) if cond else no(m, d)
def mode(p):
    return stat.S_IMODE(os.lstat(p).st_mode)

with tempfile.TemporaryDirectory() as td:
    T = Path(td)

    print("== write_private_json: usage JSON files ==")
    f = T / "sub" / "usage.json"
    write_private_json(f, {"a": 1})
    check(f.is_file(), "creates the file (and its parent)")
    check(mode(f) == 0o600, f"new file is 0600 (was umask-dependent)", f"got {oct(mode(f))}")

    os.chmod(f, 0o644)
    write_private_json(f, {"a": 2})
    check(mode(f) == 0o600, "an existing 0644 file is tightened to 0600", f"got {oct(mode(f))}")

    target = T / "victim.txt"
    target.write_text("do not overwrite me")
    link = T / "linked.json"
    link.symlink_to(target)
    try:
        write_private_json(link, {"evil": True})
        no("refuses a symlinked output path", "it wrote through the link")
    except RuntimeError:
        check(target.read_text() == "do not overwrite me",
              "refuses a symlinked output path, target untouched")

    dangling = T / "dangling.json"
    dangling.symlink_to(T / "nope" / "created-by-us.txt")
    try:
        write_private_json(dangling, {"evil": True})
        no("refuses a DANGLING symlink", "it followed the link and created the target")
    except (RuntimeError, OSError):
        ok("refuses a DANGLING symlink (exists() would have said 'missing')")

    linkdir = T / "linkdir"
    linkdir.symlink_to(T / "sub")
    try:
        write_private_json(linkdir / "x.json", {"a": 1})
        no("refuses a symlinked parent directory", "it wrote into the link")
    except RuntimeError:
        ok("refuses a symlinked parent directory")

    print("== db.secure_db_path / get_connection: the budget database ==")
    dbp = T / "data" / "budget.db"
    conn = dbmod.get_connection(dbp)
    conn.close()
    check(dbp.is_file(), "creates the database")
    check(mode(dbp) == 0o600, "database is 0600", f"got {oct(mode(dbp))}")
    check(mode(dbp.parent) == 0o700, "database directory is 0700", f"got {oct(mode(dbp.parent))}")

    victim = T / "db-victim.txt"
    victim.write_text("keep me")
    dblink = T / "linked.db"
    dblink.symlink_to(victim)
    try:
        dbmod.secure_db_path(dblink); no("refuses a symlinked database", "followed it")
    except RuntimeError:
        check(victim.read_text() == "keep me", "refuses a symlinked database, target untouched")

    # THE bug: exists() follows symlinks, so a dangling link read as "missing" and the
    # O_CREAT wrote straight through it to a path the attacker chose.
    ghost = T / "ghost.db"
    ghost_target = T / "would-be-created.db"
    ghost.symlink_to(ghost_target)
    try:
        dbmod.secure_db_path(ghost)
        no("refuses a DANGLING symlinked database", "it created " + str(ghost_target))
    except (RuntimeError, OSError):
        check(not ghost_target.exists(),
              "refuses a DANGLING symlinked database, nothing created through it")

    dbdirlink = T / "dblinkdir"
    dbdirlink.symlink_to(T / "data")
    try:
        dbmod.secure_db_path(dbdirlink / "b.db"); no("refuses a symlinked db directory", "followed it")
    except RuntimeError:
        ok("refuses a symlinked db directory")

print("== every fetcher is wired to the ONE writer ==")
for name in ["chatgpt-usage-fetch.py", "gemini-usage-fetch.py",
             "claude-usage-fetch.py", "manus-usage-fetch.py"]:
    src = (SKILL / "scripts" / name).read_text()
    check("from _secure_write import write_private_json" in src, f"{name} imports the shared writer")
    check("write_private_json(" in src, f"{name} calls it")
    check("open(USAGE_JSON_PATH, 'w')" not in src and "os.O_CREAT" not in src,
          f"{name} has no hand-rolled write left")

print(f"\ntoken-panel-ultimate: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
