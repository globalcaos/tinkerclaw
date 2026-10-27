import datetime as dt
import json
import os
import subprocess
import sys
import time

import pytest

from conftest import (SCRIPTS, git, make_fake_claude, rec_assistant, rec_tool_result, rec_user,
                      stamp, write_session)

OLD = time.time() - 3 * 86400  # file mtime three days ago


def iso(days_ago=0, minutes_ago=0):
    t = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days_ago, minutes=minutes_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def catalog(env):
    return env.mod.main(["catalog", "--projects-dir", str(env.projects)])


def card(env, sid):
    con = env.mod.connect()
    return con.execute("SELECT * FROM cards WHERE id = ?", (sid,)).fetchone()


def main_session(env, sid="s-main", cwd=None, files=(), last_days_ago=3, mtime=OLD, prompt="build the gantt chart"):
    cwd = cwd or str(env.tmp)
    ts0, ts1 = iso(last_days_ago, 30), iso(last_days_ago)
    recs = [
        {"type": "queue-operation", "timestamp": ts0},
        rec_user("<turn_context>\nmeta\n</turn_context>\n\n" + stamp() + " " + prompt +
                 "\n\n<!-- TINKERCLAW chat-row contract -->\ninjected", ts0, cwd=cwd),
        rec_assistant(ts0, "working", tools=[("Edit", f) for f in files] + [("Edit", f) for f in files],
                      usage={"input_tokens": 1, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 5}, cwd=cwd),
        rec_tool_result(ts0, cwd=cwd),
        rec_user(stamp(hm="10:05") + " ⟦AGENT:⏳ Longjob · x⟧ finished, continue", ts0, cwd=cwd),
        rec_user(stamp(hm="10:06") + " second owner question", ts0, cwd=cwd),
        rec_assistant(ts1, "Final: we chose SQLite because it is in the stdlib.",
                      usage={"input_tokens": 100, "cache_read_input_tokens": 200_000,
                             "cache_creation_input_tokens": 4000}, cwd=cwd),
    ]
    return write_session(env.projects, sid, recs, mtime=mtime)


# ------------------------------------------------------------ classification and card fields

def test_classifies_the_kinds(env):
    ts = iso(3)
    write_session(env.projects, "k-main", [rec_user(stamp() + " fix the bug", ts)], mtime=OLD)
    write_session(env.projects, "k-fractal", [rec_user(stamp() + " ⟦AGENT:🌿 Fractal · prompt 3⟧ reflect", ts)], mtime=OLD)
    write_session(env.projects, "k-longjob", [rec_user(stamp() + " ⟦AGENT:⏳ Longjob · build⟧ done", ts)], mtime=OLD)
    write_session(env.projects, "k-sub", [rec_user("[Subagent Context] you are a helper\n" + stamp() + " do x", ts)], mtime=OLD)
    write_session(env.projects, "k-wake", [rec_user("⟦ASK-SESSION⟧ Another agent asks", ts)], mtime=OLD)
    write_session(env.projects, "k-other", [rec_user("You audit an AI safety checker", ts)], mtime=OLD)
    catalog(env)
    got = {sid: card(env, sid)["kind"] for sid in
           ("k-main", "k-fractal", "k-longjob", "k-sub", "k-wake", "k-other")}
    assert got == {"k-main": "main", "k-fractal": "fractal", "k-longjob": "longjob",
                   "k-sub": "subagent", "k-wake": "wake", "k-other": "other"}


def test_card_fields(env):
    f1 = str(env.tmp / "a.py")
    main_session(env, files=[f1, str(env.tmp / "b.md")])
    catalog(env)
    c = card(env, "s-main")
    assert c["kind"] == "main"
    assert c["title"] == "build the gantt chart"  # stamp and injected tail stripped
    assert "second owner question" in c["prompts"]
    assert "Longjob" not in c["prompts"]  # agent prompts are not owner prompts
    assert json.loads(c["files"]) == [f1, str(env.tmp / "b.md")]  # deduped, in order
    assert c["cwd"] == str(env.tmp)
    assert c["final"].startswith("Final: we chose SQLite")
    assert c["ctx_tokens"] == 100 + 200_000 + 4000
    assert c["privacy"] == "owner-private"
    assert c["first_ts"] < c["last_ts"]
    assert c["size"] == os.path.getsize(env.projects / "-tmp-proj" / "s-main.jsonl")
    assert c["repos"] is None  # computed lazily, not at catalog time


def test_caps(env):
    long = "x" * 5000
    ts = iso(3)
    recs = [rec_user(stamp() + " " + long, ts)] + [rec_user(stamp() + f" q{i} " + long, ts) for i in range(3)]
    recs.append(rec_assistant(ts, "y" * 5000))
    write_session(env.projects, "s-cap", recs, mtime=OLD)
    catalog(env)
    c = card(env, "s-cap")
    assert len(c["title"]) <= 200
    assert len(c["prompts"]) <= 4000
    assert len(c["final"]) <= 1500


def test_skips_subagent_and_workflow_folders(env):
    main_session(env)
    nested = env.projects / "-tmp-proj" / "s-main" / "subagents"
    nested.mkdir(parents=True)
    (nested / "agent-1.jsonl").write_text(json.dumps(rec_user(stamp() + " sub", iso(3))) + "\n")
    catalog(env)
    con = env.mod.connect()
    assert [r["id"] for r in con.execute("SELECT id FROM cards")] == ["s-main"]


def test_incremental_skip(env, monkeypatch):
    p = main_session(env)
    calls = []
    real = env.mod.parse_session
    monkeypatch.setattr(env.mod, "parse_session", lambda path: calls.append(path) or real(path))
    catalog(env)
    catalog(env)
    assert len(calls) == 1  # second run: same size and mtime, skipped
    with open(p, "a") as fh:
        fh.write(json.dumps(rec_user(stamp() + " third", iso(1))) + "\n")
    os.utime(p, (OLD + 60, OLD + 60))
    catalog(env)
    assert len(calls) == 2
    assert "third" in card(env, "s-main")["prompts"]


# ------------------------------------------------------------ find

def test_find_ranking(env, capsys):
    ts = iso(3)
    write_session(env.projects, "f-title", [rec_user(stamp() + " design the gantt tab", ts),
                                            rec_assistant(ts, "done")], mtime=OLD)
    write_session(env.projects, "f-final", [rec_user(stamp() + " fix the router", ts),
                                            rec_assistant(ts, "we also touched the gantt file")], mtime=OLD)
    write_session(env.projects, "f-none", [rec_user(stamp() + " translate a letter", ts)], mtime=OLD)
    catalog(env)
    capsys.readouterr()
    rows = env.mod.find(env.mod.connect(), "gantt")
    assert [r["id"] for r in rows] == ["f-title", "f-final"]
    assert env.mod.main(["find", "gantt", "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out[0]["id"] == "f-title" and out[0]["kind"] == "main"
    assert "wake_cost_tokens" in out[0] and "days_dormant" in out[0]
    # several words: AND first, OR as fallback
    assert [r["id"] for r in env.mod.find(env.mod.connect(), "gantt letter")] != []
    assert env.mod.find(env.mod.connect(), "gantt", kind="fractal") == []


# ------------------------------------------------------------ wake-up preamble

def test_preamble_content(env):
    repo = env.tmp / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "a.py").write_text("1\n")
    git(repo, "add", "a.py")
    old_date = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=5)).isoformat()
    git(repo, "commit", "-q", "-m", "old change", env_extra={"GIT_COMMITTER_DATE": old_date, "GIT_AUTHOR_DATE": old_date})
    (repo / "a.py").write_text("2\n")
    git(repo, "commit", "-q", "-am", "new change after the session")

    mem = env.state / "agent-memory"
    mem.mkdir()
    today = dt.date.today()
    recent = today.strftime("%m-%d")
    (mem / "MEMORY.md").write_text(
        "# Memory Index\n"
        f"- ⭐⭐ [fresh lesson about gantt](feedback_x.md) — {recent}\n"
        "- ⭐ [ancient lesson](feedback_y.md) — 2025-01-02\n"
        f"- 🚨 [full date lesson](f.md) {today.isoformat()}\n"
    )
    main_session(env, cwd=str(repo), files=[str(repo / "a.py")], last_days_ago=3)
    catalog(env)
    con = env.mod.connect()
    row = con.execute("SELECT * FROM cards WHERE id='s-main'").fetchone()
    pre = env.mod.build_preamble(con, row)
    assert today.isoformat() in pre  # date generated, not hard-coded
    assert "slept 3 days" in pre
    assert "new change after the session" in pre
    assert "old change" not in pre
    assert "fresh lesson about gantt" in pre and "full date lesson" in pre
    assert "ancient lesson" not in pre
    assert "(feedback_x.md)" not in pre  # titles only
    assert "First check whether any of this changes your answer" in pre
    # repos were computed lazily and stored
    assert json.loads(con.execute("SELECT repos FROM cards WHERE id='s-main'").fetchone()["repos"]) == {
        str(repo): [str(repo / "a.py")]}


def test_preamble_size_cap(env):
    mem = env.state / "agent-memory"
    mem.mkdir()
    today = dt.date.today().isoformat()
    (mem / "MEMORY.md").write_text("".join(f"- [{'long title ' * 30} {i}](x.md) {today}\n" for i in range(50)))
    main_session(env)
    catalog(env)
    con = env.mod.connect()
    row = con.execute("SELECT * FROM cards WHERE id='s-main'").fetchone()
    pre = env.mod.build_preamble(con, row)
    assert len(pre) <= env.mod.PREAMBLE_CHAR_CAP
    assert pre.count("long title") <= 10 * 30  # at most 10 memory lines
    assert pre.rstrip().endswith("say plainly what changed.")
    # a git log is capped at 10 lines per repo
    assert env.mod.GIT_LINES_PER_REPO == 10


def test_memory_short_dates_roll_back_a_year(env):
    today = dt.date(2026, 1, 5)
    p = env.tmp / "M.md"
    p.write_text("- [december item](a.md) — 12-30\n- [january item](b.md) — 01-04\n")
    got = env.mod.memory_changes(dt.date(2026, 1, 1), path=str(p), today=today)
    assert got == ["january item (2026-01-04)"]


# ------------------------------------------------------------ refusals

def test_refuses_recent_file(env, capsys, tmp_path, monkeypatch):
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env, mtime=time.time() - 120)  # written two minutes ago
    catalog(env)
    assert env.mod.main(["ask", "s-main", "why?"]) == 2
    assert "may be live" in capsys.readouterr().err
    assert not log.exists()
    assert env.mod.main(["ask", "s-main", "why?", "--force"]) == 0
    assert log.exists()


def test_refuses_subagent_env(env, capsys, monkeypatch, tmp_path):
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    for var, val in (("TC_SESSION_KEY", "agent:main:subagent:abc"), ("TC_SESSION_KEY", "agent:main:tinker-sp-9"),
                     ("OPENCLAW_SUBAGENT", "1")):
        monkeypatch.setenv(var, val)
        assert env.mod.main(["ask", "s-main", "why?", "--force"]) == 2
        assert "narrower reader" in capsys.readouterr().err
        assert env.mod.main(["show", "s-main"]) == 2
        capsys.readouterr()
        monkeypatch.delenv(var)
    assert not log.exists()


def test_refuses_own_session(env, capsys, monkeypatch, tmp_path):
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "s-main")
    assert env.mod.main(["ask", "s-main", "why?", "--force"]) == 2
    assert "own session" in capsys.readouterr().err
    assert not log.exists()


# ------------------------------------------------------------ the wake itself

def test_ask_runs_claude_in_place(env, capsys, monkeypatch, tmp_path):
    bindir, log = make_fake_claude(tmp_path, answer="We chose SQLite for FTS5.")
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    workdir = env.tmp / "work"
    workdir.mkdir()
    main_session(env, cwd=str(workdir))
    catalog(env)
    capsys.readouterr()
    assert env.mod.main(["ask", "s-main", "why SQLite?"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("Session s-main (")
    assert "says:" in out and "We chose SQLite for FTS5." in out
    assert "cache write 1000" in out

    call = json.loads(log.read_text().splitlines()[0])
    argv = call["argv"]
    assert argv[:2] == ["-p", "--resume"] and argv[2] == "s-main"
    assert "--fork-session" not in argv
    assert argv[argv.index("--output-format") + 1] == "json"
    assert call["cwd"] == str(workdir)
    prompt = argv[-1]
    assert prompt.startswith("⟦ASK-SESSION⟧")
    assert "Wake-up note" in prompt  # dormant three days, so the preamble is on
    assert prompt.rstrip().endswith("Question: why SQLite?")

    rec = json.loads((env.state / "ask-session" / "asks.jsonl").read_text().splitlines()[-1])
    assert rec["id"] == "s-main" and rec["preamble"] is True and rec["exit"] == 0
    assert rec["dormant_min"] > 60 * 24 * 2
    assert rec["answer_len"] == len("We chose SQLite for FTS5.")
    assert rec["usage"]["cache_creation_input_tokens"] == 1000
    assert "duration_s" in rec and "why SQLite" not in json.dumps(rec)  # no question text logged


def ask_record_of(out):
    lines = [x for x in out.splitlines() if x.startswith("[ask-session] ")]
    assert len(lines) == 1, out
    return json.loads(lines[0][len("[ask-session] "):])


def test_ask_prints_a_record_with_the_transcript_range_the_wake_added(env, capsys, monkeypatch, tmp_path):
    """The Tinker UI draws the ask from the record line and loads exactly the bytes the wake appended."""
    p = main_session(env)
    before = p.stat().st_size
    bindir, _ = make_fake_claude(tmp_path, answer="Because FTS5.", append_to=p)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    catalog(env)
    capsys.readouterr()
    assert env.mod.main(["ask", "s-main", "why SQLite?"]) == 0
    out = capsys.readouterr().out
    assert out.rstrip().splitlines()[-1].startswith("[ask-session] ")
    rec = ask_record_of(out)
    assert rec["v"] == 1 and rec["id"] == "s-main" and rec["question"] == "why SQLite?"
    assert rec["title"] == card(env, "s-main")["title"]
    assert "answer" not in rec  # printed once, above the record
    t = rec["transcript"]
    assert t["path"] == str(p) and t["fromByte"] == before and t["toByte"] == p.stat().st_size
    with open(p, "rb") as fh:
        fh.seek(t["fromByte"])
        added = [json.loads(x) for x in fh.read(t["toByte"] - t["fromByte"]).decode().splitlines()]
    assert [r["type"] for r in added] == ["user", "assistant"]
    assert added[1]["message"]["content"][0]["text"] == "Because FTS5."


def test_ask_json_carries_the_same_record_fields(env, capsys, monkeypatch, tmp_path):
    p = main_session(env)
    bindir, _ = make_fake_claude(tmp_path, append_to=p)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    catalog(env)
    capsys.readouterr()
    before = p.stat().st_size
    assert env.mod.main(["ask", "s-main", "q?", "--json"]) == 0
    res = json.loads(capsys.readouterr().out)
    assert res["question"] == "q?" and res["title"]
    assert res["transcript"]["fromByte"] == before and res["transcript"]["toByte"] > before


def test_a_failed_wake_still_prints_its_record(env, capsys, monkeypatch, tmp_path):
    bindir, _ = make_fake_claude(tmp_path, exit_code=1, answer="")
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    capsys.readouterr()
    assert env.mod.main(["ask", "s-main", "q?"]) == 1
    rec = ask_record_of(capsys.readouterr().out)
    assert rec["error"] is True and rec["question"] == "q?"


def test_ask_no_preamble_and_recent_session(env, monkeypatch, tmp_path, capsys):
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    assert env.mod.main(["ask", "s-main", "q1", "--no-preamble"]) == 0
    assert "Wake-up note" not in json.loads(log.read_text().splitlines()[-1])["argv"][-1]
    # session active 20 min ago (file older than 10 min): no preamble needed
    main_session(env, sid="s-fresh", last_days_ago=0, mtime=time.time() - 1200)
    p = env.projects / "-tmp-proj" / "s-fresh.jsonl"
    recs = [json.loads(x) for x in p.read_text().splitlines()]
    for r in recs:
        if "timestamp" in r:
            r["timestamp"] = iso(0, 20)
    write_session(env.projects, "s-fresh", recs, mtime=time.time() - 1200)
    catalog(env)
    assert env.mod.main(["ask", "s-fresh", "q2"]) == 0
    assert "Wake-up note" not in json.loads(log.read_text().splitlines()[-1])["argv"][-1]
    capsys.readouterr()


def test_follow_up_after_own_wake_is_allowed(env, monkeypatch, tmp_path, capsys):
    """Our own wake writes the file; a follow-up right after must not be taken for a live session."""
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    p = main_session(env)
    catalog(env)
    assert env.mod.main(["ask", "s-main", "q1"]) == 0
    # simulate claude appending the exchange; record the post-ask mtime as the tool does
    now = time.time()
    os.utime(p, (now, now))
    con = env.mod.connect()
    row = env.mod.resolve(con, "s-main")
    assert "may be live" in (env.mod.refusal(row, force=False) or "")
    env.mod.append_ask_log({"id": "s-main", "mtime_after_ns": os.stat(p).st_mtime_ns})
    assert env.mod.refusal(row, force=False) is None
    capsys.readouterr()


def test_ask_timeout(env, monkeypatch, tmp_path, capsys):
    bindir, log = make_fake_claude(tmp_path, sleep=5)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    t0 = time.monotonic()
    assert env.mod.main(["ask", "s-main", "q", "--timeout", "0.5"]) == 1
    assert time.monotonic() - t0 < 4
    rec = json.loads((env.state / "ask-session" / "asks.jsonl").read_text().splitlines()[-1])
    assert rec["exit"] == "timeout"
    capsys.readouterr()


# ------------------------------------------------------------ cost rule and summaries

def test_cost_rule(env, capsys):
    main_session(env)
    catalog(env)
    assert env.mod.break_even(200_000, 100_000) == pytest.approx(50.0)  # 0.05x read (5.5 models)
    assert env.mod.break_even(200_000, 100_000, read_mult=0.1) == pytest.approx(25.0)
    assert env.mod.main(["cost", "s-main", "--asker-context", "204100"]) == 0
    out = capsys.readouterr().out
    assert "k* = 25 x C_session / C_asker = 25.0 tool calls" in out  # C_session = 204,100 tokens
    assert env.mod.main(["cost", "s-main", "--asker-context", "204100", "--read-mult", "0.1"]) == 0
    assert "= 12.5 x C_session / C_asker = 12.5 tool calls" in capsys.readouterr().out


def test_summarize_records_success_and_failure(env, monkeypatch, tmp_path, capsys):
    bindir, log = make_fake_claude(tmp_path, answer="1\n2\n3\n4\n5")
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    assert env.mod.main(["catalog", "--projects-dir", str(env.projects), "--summarize", "3"]) == 0
    assert card(env, "s-main")["summary"] == "1\n2\n3\n4\n5"
    argv = json.loads(log.read_text().splitlines()[0])["argv"]
    assert argv[argv.index("--model") + 1] == "haiku" and "--resume" not in argv

    failing = tmp_path / "failing"
    failing.mkdir()
    bindir2, _ = make_fake_claude(failing, exit_code=1)
    monkeypatch.setenv("PATH", f"{bindir2}{os.pathsep}{os.environ['PATH']}")
    main_session(env, sid="s-two")
    assert env.mod.main(["catalog", "--projects-dir", str(env.projects), "--summarize", "3"]) == 0  # never fatal
    assert card(env, "s-two")["summary_error"]
    assert card(env, "s-main")["summary"] == "1\n2\n3\n4\n5"
    capsys.readouterr()


def test_cli_runs_isolated(env):
    """The script works as `python3 -I sessions.py` with only the env pointing at tmp."""
    main_session(env)
    script = os.path.join(SCRIPTS, "sessions.py")
    res = subprocess.run([sys.executable, "-I", script, "catalog", "--projects-dir", str(env.projects)],
                         capture_output=True, text=True, env=dict(os.environ))
    assert res.returncode == 0, res.stderr
    res = subprocess.run([sys.executable, "-I", script, "find", "gantt"], capture_output=True, text=True,
                         env=dict(os.environ))
    assert res.returncode == 0 and "s-main" in res.stdout


# ------------------------------------------------------------ timer installer

def test_install_timer(env, tmp_path):
    bindir = tmp_path / "sysbin"
    bindir.mkdir()
    calls = tmp_path / "systemctl.log"
    (bindir / "systemctl").write_text(f"#!/bin/sh\necho \"$@\" >> {calls}\n")
    (bindir / "systemctl").chmod(0o755)
    e = dict(os.environ, PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}")
    script = os.path.join(SCRIPTS, "install-timer.sh")
    r1 = subprocess.run(["bash", script], capture_output=True, text=True, env=e)
    assert r1.returncode == 0, r1.stderr
    unit_dir = env.home / ".config" / "systemd" / "user"
    timer = (unit_dir / "ask-session-catalog.timer").read_text()
    service = (unit_dir / "ask-session-catalog.service").read_text()
    assert "OnCalendar=*-*-* 03:40:00" in timer and "Persistent=true" in timer
    real_script = os.path.realpath(os.path.join(SCRIPTS, "sessions.py"))
    assert f'-I "{real_script}" catalog' in service
    assert f'Environment="OPENCLAW_STATE_DIR={env.state}"' in service
    r2 = subprocess.run(["bash", script], capture_output=True, text=True, env=e)
    assert "unchanged" in r2.stdout and "wrote" not in r2.stdout
    r3 = subprocess.run(["bash", script, "--uninstall"], capture_output=True, text=True, env=e)
    assert r3.returncode == 0 and not (unit_dir / "ask-session-catalog.timer").exists()
    assert "enable --now ask-session-catalog.timer" in calls.read_text()


def test_install_timer_quotes_paths_with_spaces(env, tmp_path):
    import shutil as _sh
    spaced = tmp_path / "dir with space"
    spaced.mkdir()
    for name in ("install-timer.sh", "sessions.py"):
        _sh.copy(os.path.join(SCRIPTS, name), spaced / name)
    bindir = tmp_path / "sysbin"
    bindir.mkdir()
    (bindir / "systemctl").write_text("#!/bin/sh\nexit 0\n")
    (bindir / "systemctl").chmod(0o755)
    e = dict(os.environ, PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}")
    e.pop("OPENCLAW_STATE_DIR")
    r = subprocess.run(["bash", str(spaced / "install-timer.sh")], capture_output=True, text=True, env=e)
    assert r.returncode == 0, r.stderr
    service = (env.home / ".config" / "systemd" / "user" / "ask-session-catalog.service").read_text()
    assert f'-I "{spaced / "sessions.py"}" catalog' in service
    assert "Environment=" not in service  # no state dir set, none carried


# ------------------------------------------------------------ review fixes: live holders and locks

def test_refuses_session_held_by_a_live_process_even_with_force(env, capsys, monkeypatch, tmp_path):
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    holder = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "--resume", "s-main"])
    try:
        time.sleep(0.2)
        assert holder.pid in env.mod.live_holders("s-main")
        assert env.mod.main(["ask", "s-main", "why?", "--force"]) == 2
        err = capsys.readouterr().err
        assert "running process holds this session" in err and str(holder.pid) in err
    finally:
        holder.kill()
        holder.wait()
    assert not log.exists()
    assert env.mod.live_holders("s-main") == []
    assert env.mod.main(["ask", "s-main", "why?"]) == 0
    capsys.readouterr()


def test_live_holders_reads_every_flag_form(env, tmp_path):
    proc = tmp_path / "proc"
    for pid, argv in (("101", ["claude", "-p", "--resume", "abc"]), ("102", ["claude", "--session-id=abc"]),
                      ("103", ["claude", "-r", "abc"]), ("104", ["claude", "--resume", "abcd"]),
                      ("105", ["grep", "abc"])):
        (proc / pid).mkdir(parents=True)
        (proc / pid / "cmdline").write_bytes(("\0".join(argv) + "\0").encode())
    assert sorted(env.mod.live_holders("abc", proc_dir=str(proc))) == [101, 102, 103]


def test_second_ask_on_the_same_session_is_refused_while_one_runs(env, capsys, monkeypatch, tmp_path):
    import fcntl
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    path = env.mod.lock_path("s-main")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a+") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert env.mod.main(["ask", "s-main", "why?"]) == 2
        assert "another ask is running" in capsys.readouterr().err
    assert not log.exists()
    assert env.mod.main(["ask", "s-main", "why?"]) == 0  # lock released
    assert path.startswith(str(env.state / "ask-session" / "locks"))
    capsys.readouterr()


# ------------------------------------------------------------ review fixes: read-only wake, clean env

def test_wake_is_read_only_and_runs_with_a_clean_env(env, capsys, monkeypatch, tmp_path):
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    asker = {"TC_SESSION_KEY": "agent:main:tinker:abc", "TC_WORKER_DIR": "/run/x", "CLAUDE_CODE_SESSION_ID": "asker-id",
             "CLAUDE_CODE_MESSAGING_SOCKET": "/run/s.sock", "CLAUDE_CODE_MESSAGING_TOKEN": "t", "CLAUDE_PID": "1",
             "CLAUDECODE": "1", "CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_ENTRYPOINT": "cli"}
    for k, v in asker.items():
        monkeypatch.setenv(k, v)
    assert env.mod.main(["ask", "s-main", "why?"]) == 0
    call = json.loads(log.read_text().splitlines()[0])
    argv, child = call["argv"], call["env"]
    assert "--tools=Read,Grep,Glob" in argv
    dis = next(a for a in argv if a.startswith("--disallowedTools="))
    for tool in ("Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Agent"):
        assert tool in dis.split("=", 1)[1].split(",")
    assert "--strict-mcp-config" in argv
    assert argv[-1].startswith("⟦ASK-SESSION⟧")  # the variadic flags did not swallow the prompt
    for k in asker:
        assert k not in child, k
    assert child["ASK_SESSION_WAKE"] == "1"
    assert child["OPENCLAW_STATE_DIR"] == str(env.state)  # the rest of the env is kept
    capsys.readouterr()


def test_summarize_runs_without_tools(env, monkeypatch, tmp_path, capsys):
    bindir, log = make_fake_claude(tmp_path, answer="1\n2\n3\n4\n5")
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("TC_SESSION_KEY", "agent:main:tinker:abc")
    main_session(env)
    assert env.mod.main(["catalog", "--projects-dir", str(env.projects), "--summarize", "1"]) == 0
    call = json.loads(log.read_text().splitlines()[0])
    assert "--tools=" in call["argv"] and "--strict-mcp-config" in call["argv"]
    assert "TC_SESSION_KEY" not in call["env"] and call["env"]["ASK_SESSION_WAKE"] == "1"
    capsys.readouterr()


def test_a_woken_session_cannot_wake_another(env, capsys, monkeypatch, tmp_path):
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    monkeypatch.setenv("ASK_SESSION_WAKE", "1")
    assert env.mod.main(["ask", "s-main", "why?", "--force"]) == 2
    assert "wakes do not chain" in capsys.readouterr().err
    con = env.mod.connect()
    assert "wakes do not chain" in env.mod.refusal(env.mod.resolve(con, "s-main"), force=True)
    assert not log.exists()


def test_refuses_non_owner_kinds_without_force(env, capsys, monkeypatch, tmp_path):
    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    mem = env.state / "agent-memory"
    mem.mkdir()
    (mem / "MEMORY.md").write_text(f"- [secret owner lesson](x.md) {dt.date.today().isoformat()}\n")
    write_session(env.projects, "k-other", [rec_user("You audit an AI safety checker", iso(3), cwd=str(env.tmp))],
                  mtime=OLD)
    catalog(env)
    assert env.mod.main(["ask", "k-other", "q"]) == 2
    assert "kind 'other'" in capsys.readouterr().err
    assert env.mod.main(["ask", "k-other", "q", "--force"]) == 0
    prompt = json.loads(log.read_text().splitlines()[-1])["argv"][-1]
    assert "Wake-up note" in prompt
    assert "secret owner lesson" not in prompt  # owner-private titles stay out of non-owner sessions
    capsys.readouterr()


# ------------------------------------------------------------ review fixes: timeouts

def test_timeout_escalates_to_sigkill_and_still_logs(env, monkeypatch, tmp_path, capsys):
    bindir, log = make_fake_claude(tmp_path, sleep=20, ignore_term=True)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setattr(env.mod, "TERM_GRACE_S", 0.3)
    main_session(env)
    catalog(env)
    t0 = time.monotonic()
    assert env.mod.main(["ask", "s-main", "q", "--timeout", "0.5"]) == 1
    assert time.monotonic() - t0 < 6
    rec = json.loads((env.state / "ask-session" / "asks.jsonl").read_text().splitlines()[-1])
    assert rec["exit"] == "timeout" and rec["answer_len"] == 0
    capsys.readouterr()


def test_default_timeout_fits_inside_a_default_bash_call(env):
    assert env.mod.build_parser().parse_args(["ask", "x", "q"]).timeout < 120


def test_ask_log_is_written_when_the_wake_crashes(env, monkeypatch, tmp_path, capsys):
    main_session(env)
    catalog(env)

    def boom(*a, **k):
        raise RuntimeError("cut short")
    monkeypatch.setattr(env.mod, "run_with_timeout", boom)
    con = env.mod.connect()
    with pytest.raises(RuntimeError):
        env.mod.do_ask(con, env.mod.resolve(con, "s-main"), "q")
    rec = json.loads((env.state / "ask-session" / "asks.jsonl").read_text().splitlines()[-1])
    assert rec["id"] == "s-main" and rec["exit"] == "not started"


# ------------------------------------------------------------ review fixes: wake exchanges and dates

def test_wake_exchange_does_not_move_the_work_date(env, capsys, monkeypatch, tmp_path):
    p = main_session(env, last_days_ago=3)
    with open(p, "a") as fh:
        fh.write(json.dumps(rec_user("⟦ASK-SESSION⟧ Another agent asks. the architect wrote " + stamp() +
                                     " keep the SQLite\n\nQuestion: why?", iso(0, 90))) + "\n")
        fh.write(json.dumps(rec_assistant(iso(0, 89), "Because FTS5.")) + "\n")
    os.utime(p, (OLD, OLD))
    catalog(env)
    c = card(env, "s-main")
    assert c["last_ts"] > c["last_work_ts"]
    assert c["last_work_ts"][:10] == iso(3)[:10]
    assert "keep the SQLite" not in c["prompts"]  # a quoted stamp inside a wake is not an owner prompt
    assert c["final"].startswith("Final: we chose SQLite")
    con = env.mod.connect()
    pre = env.mod.build_preamble(con, card(env, "s-main"))
    assert f"Your knowledge is from {iso(3)[:10]}" in pre and "slept 3 days" in pre
    assert "only woken to answer questions" in pre
    capsys.readouterr()
    env.mod.main(["find", "gantt", "--json"])
    assert json.loads(capsys.readouterr().out)[0]["days_dormant"] >= 2.9

    bindir, log = make_fake_claude(tmp_path)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    assert env.mod.main(["ask", "s-main", "q", "--json"]) == 0
    res = json.loads(capsys.readouterr().out)
    assert res["label"] == f"Session s-main ({iso(3)[:10]}) says:" and res["testimony"] is True
    assert res["date"] == iso(3)[:10]


def test_classify_markers_must_open_the_message(env):
    cl = env.mod.classify
    quoted = 'You explain flags.\nTHE FLAG:\n{"ownerAsked": "[Subagent Context] You are run"}'
    assert cl(quoted, False) == "other"
    assert cl(stamp() + " please look at this: [Subagent Context] was quoted", True) == "main"
    assert cl(stamp() + " [Subagent Context] You are running as a subagent", True) == "subagent"
    bank = "## From the Shared Memory Bank\n\n## Retrieved Context\n[2026-10-10T05:39:33] x\n\n\n"
    assert cl(bank + stamp() + " [Subagent Context] You are running", True) == "subagent"
    assert cl("<turn_context>\nx\n</turn_context>\n⟦AGENT:🌿 Fractal · 1⟧", False) == "fractal"
    assert cl(stamp() + " see ⟦AGENT:⏳ Longjob⟧ output", True) == "main"


def test_find_leaves_out_other_by_default(env, capsys):
    ts = iso(3)
    write_session(env.projects, "o-main", [rec_user(stamp() + " gantt work", ts)], mtime=OLD)
    write_session(env.projects, "o-other", [rec_user("You review flags about gantt", ts)], mtime=OLD)
    catalog(env)
    con = env.mod.connect()
    assert [r["id"] for r in env.mod.find(con, "gantt")] == ["o-main"]
    assert sorted(r["id"] for r in env.mod.find(con, "gantt", kind="any")) == ["o-main", "o-other"]
    assert [r["id"] for r in env.mod.find(con, "gantt", kind="other")] == ["o-other"]
    capsys.readouterr()
    assert env.mod.main(["find", "gantt", "--kind", "any", "--json"]) == 0
    assert len(json.loads(capsys.readouterr().out)) == 2


# ------------------------------------------------------------ review fixes: preamble budgets

def test_preamble_budgets_keep_memory_when_git_is_long(env):
    mem = env.state / "agent-memory"
    mem.mkdir()
    today = dt.date.today()
    (mem / "MEMORY.md").write_text(f"- 🚨⭐⭐ [kept memory lesson](x.md) {today.isoformat()}\n"
                                   f"- 🚨⭐⭐ plain line no link {today.isoformat()}\n")
    files = []
    old_date = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=5)).isoformat()
    for r in range(8):
        repo = env.tmp / f"repo{r}"
        repo.mkdir()
        git(repo, "init", "-q")
        n_files = 1 if r else 3  # repo0 holds the most edited files
        for i in range(n_files):
            (repo / f"f{i}.py").write_text("0\n")
            files.append(str(repo / f"f{i}.py"))
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "seed", env_extra={"GIT_COMMITTER_DATE": old_date, "GIT_AUTHOR_DATE": old_date})
        for c in range(10):
            (repo / "f0.py").write_text(f"{c + 1}\n")
            git(repo, "commit", "-q", "-am", f"repo{r} commit {c} " + "word " * 60)
    main_session(env, files=files, last_days_ago=3)
    catalog(env)
    con = env.mod.connect()
    pre = env.mod.build_preamble(con, card(env, "s-main"))
    assert len(pre) <= env.mod.PREAMBLE_CHAR_CAP
    assert "kept memory lesson" in pre and "plain line no link" in pre
    assert "🚨" not in pre and "⭐" not in pre
    git_lines = [ln for ln in pre.splitlines() if " commit " in ln]
    assert git_lines and all(len(ln.strip()) <= env.mod.GIT_LINE_CAP for ln in git_lines)
    first_repo = next(ln for ln in pre.splitlines() if ln.startswith("Git commits since then"))
    assert first_repo.endswith(f"{env.tmp / 'repo0'}:")  # most edited files first
    assert "(list cut to stay short)" in pre


# ------------------------------------------------------------ review fixes: summary refresh

def test_summary_refreshes_after_growth_and_retries_errors(env, monkeypatch, tmp_path, capsys):
    failing = tmp_path / "failing"
    failing.mkdir()
    badbin, _ = make_fake_claude(failing, exit_code=1)
    monkeypatch.setenv("PATH", f"{badbin}{os.pathsep}{os.environ['PATH']}")
    p = main_session(env)
    catalog_args = ["catalog", "--projects-dir", str(env.projects), "--summarize", "3"]
    env.mod.main(catalog_args)
    assert card(env, "s-main")["summary_error"]

    bindir, log = make_fake_claude(tmp_path, answer="first summary")
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    env.mod.main(catalog_args)
    assert not log.exists()  # a fresh error is not retried on an unchanged file
    con = env.mod.connect()
    con.execute("UPDATE cards SET summary_at = '2000-01-01T00:00:00+00:00' WHERE id = 's-main'")
    con.commit()
    env.mod.main(catalog_args)
    assert card(env, "s-main")["summary"] == "first summary"  # retried after a few days
    calls = len(log.read_text().splitlines())
    env.mod.main(catalog_args)
    assert len(log.read_text().splitlines()) == calls  # unchanged: not redone

    with open(p, "a") as fh:
        for i in range(20):
            fh.write(json.dumps(rec_user(stamp() + f" more work {i} " + "z" * 200, iso(2))) + "\n")
    os.utime(p, (OLD + 99, OLD + 99))
    env.mod.main(catalog_args)
    assert len(log.read_text().splitlines()) == calls + 1  # grew by more than half: redone
    assert card(env, "s-main")["summary_size"] == card(env, "s-main")["size"]
    capsys.readouterr()


def test_old_catalogue_gets_new_columns(env):
    import sqlite3
    os.makedirs(env.state / "ask-session")
    con = sqlite3.connect(env.state / "ask-session" / "catalog.sqlite")
    con.execute("CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT, project TEXT, cwd TEXT, first_ts TEXT, "
                "last_ts TEXT, kind TEXT, title TEXT, prompts TEXT, files TEXT, repos TEXT, final TEXT, "
                "ctx_tokens INTEGER, size INTEGER, privacy TEXT, summary TEXT, summary_error TEXT, "
                "summary_at TEXT, indexed_at TEXT)")
    con.commit()
    con.close()
    main_session(env)
    catalog(env)
    assert card(env, "s-main")["last_work_ts"]


def test_the_real_claude_is_out_of_reach(env):
    import shutil as _sh
    assert _sh.which("claude").startswith(str(env.tmp))  # the conftest stub, not ~/.nvm


# ------------------------------------------------------------ the disk check, --wake-id and `answer` (2026-10-25)


def test_the_answer_is_checked_against_the_disk_before_it_is_handed_over(env, capsys, monkeypatch, tmp_path):
    """Each file the testimony names is stat-ed now: changed after the session's last work, unchanged, or gone."""
    work = tmp_path / "work"
    (work / "src").mkdir(parents=True)
    old = work / "src" / "old.py"
    new = work / "src" / "new.py"
    old.write_text("x")
    new.write_text("y")
    os.utime(old, (OLD - 86400, OLD - 86400))  # before the session's last work (three days ago)
    answer = ("The limit is in src/old.py:12, the retry in src/new.py, the doc was docs/gone.md; "
              "see https://example.com/a/b.html too.")
    bindir, _ = make_fake_claude(tmp_path, answer=answer)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env, cwd=str(work))
    catalog(env)
    capsys.readouterr()
    assert env.mod.main(["ask", "s-main", "where is the limit?", "--json"]) == 0
    res = json.loads(capsys.readouterr().out)
    assert [(c["path"], c["state"]) for c in res["checks"]] == [
        ("src/old.py", "unchanged"), ("src/new.py", "changed"), ("docs/gone.md", "missing")]
    assert env.mod.main(["ask", "s-main", "again?", "--force"]) == 0
    out = capsys.readouterr().out
    assert "[checked against the disk now, before anyone acts on it:" in out
    assert "src/new.py: changed" in out and "re-read it" in out
    assert "src/old.py: unchanged since" in out and "docs/gone.md: not found on disk]" in out
    assert out.rstrip().splitlines()[-1].startswith("[ask-session] ")  # the record stays last


def test_an_answer_that_names_no_file_gets_no_check_block(env, capsys, monkeypatch, tmp_path):
    bindir, _ = make_fake_claude(tmp_path, answer="We picked SQLite for its full-text search.")
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    capsys.readouterr()
    assert env.mod.main(["ask", "s-main", "why?"]) == 0
    assert "checked against the disk" not in capsys.readouterr().out


def test_a_wake_id_writes_the_result_file_and_answer_reads_it_once(env, capsys, monkeypatch, tmp_path):
    """The gateway starts the wake with --wake-id; the agent reads it with `answer`, which marks it read."""
    bindir, _ = make_fake_claude(tmp_path, answer="The link is https://sede.example/form-123.")
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    main_session(env)
    catalog(env)
    capsys.readouterr()
    assert env.mod.main(["ask", "s-main", "the link we used last time?", "--json", "--wake-id", "w1"]) == 0
    capsys.readouterr()
    data = json.loads((env.state / "ask-session" / "wakes" / "w1.json").read_text())
    assert data["state"] == "done" and data["id"] == "s-main" and "read_at" not in data
    assert data["text"].startswith("Session s-main (") and "form-123" in data["text"]
    assert env.mod.main(["answer", "w1"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("Session s-main (") and "[testimony, not verified;" in out
    assert "[ask-session]" not in out  # the UI record belongs to the ask call
    assert "read_at" in json.loads((env.state / "ask-session" / "wakes" / "w1.json").read_text())


def test_answer_reports_a_refused_or_missing_wake(env, capsys, monkeypatch, tmp_path):
    main_session(env)
    catalog(env)
    capsys.readouterr()
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "s-main")  # its own session: refused before any wake
    assert env.mod.main(["ask", "s-main", "q?", "--wake-id", "w2"]) == 2
    capsys.readouterr()
    assert env.mod.main(["answer", "w2"]) == 2
    assert "caller's own session" in capsys.readouterr().err
    assert env.mod.main(["answer", "nope"]) == 2
    assert "no wake 'nope'" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        env.mod.main(["answer", "../etc/passwd"])


def test_answer_waits_for_a_running_wake_and_notices_a_dead_one(env, capsys):
    mod = env.mod
    mod.write_wake("w3", {"v": 1, "state": "running", "pid": os.getpid(), "started": "now"})
    assert mod.main(["answer", "w3", "--wait", "0"]) == 3
    assert "still waking" in capsys.readouterr().err
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    mod.write_wake("w4", {"v": 1, "state": "running", "pid": dead.pid, "started": "now"})
    assert mod.main(["answer", "w4", "--wait", "5"]) == 1
    assert "cut short" in capsys.readouterr().err


def test_old_wake_files_are_pruned(env):
    mod = env.mod
    mod.write_wake("old", {"state": "done"})
    mod.write_wake("new", {"state": "done"})
    p = env.state / "ask-session" / "wakes" / "old.json"
    os.utime(p, (OLD - 8 * 86400, OLD - 8 * 86400))
    mod.prune_wakes()
    assert sorted(os.listdir(env.state / "ask-session" / "wakes")) == ["new.json"]


def test_catalog_writes_the_stamp_the_gateway_reads(env, capsys):
    main_session(env)
    catalog(env)
    stamp_file = env.state / "ask-session" / "catalog.stamp"
    rec = json.loads(stamp_file.read_text())
    assert rec["seen"] == 1 and rec["changed"] == 1 and rec["ts"]
