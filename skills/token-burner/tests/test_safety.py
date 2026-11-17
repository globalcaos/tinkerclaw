"""Dormant by default: nothing runs without --live plus TOKEN_BURNER_ALLOW_LIVE=1, a plan starts
nothing, and live jobs never see a variable that would bill a metered account."""
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from token_burner import cli, config, engine, jobs, meter, runner, store as storemod

PY = sys.executable


def home_with(tmp, queue_lines, seat_dir=None):
    h = Path(tmp)
    s = config.Settings(seats=[config.Seat("main", str(seat_dir or h / "seat-main"))])
    config.save(s, h)
    (h / "queue.jsonl").write_text("\n".join(json.dumps(q) for q in queue_lines) + "\n")
    st = storemod.Store(h / "state.db")
    st.add_reading("main", time.time(), {"week_pct": 10.0, "week_reset": time.time() + 3 * 86400,
                                         "five_pct": 0.0, "five_reset": None}, "test")
    return h, s, st


def touch_job(jid, target, verify_ok=True):
    return {"id": jid, "cmd": [PY, "-I", "-c", f"open({str(target)!r}, 'w').write('x')"],
            "verify": [PY, "-I", "-c", f"raise SystemExit({0 if verify_ok else 1})"]}


class Dormant(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.marker = Path(self.tmp.name) / "ran"
        self.h, self.s, self.st = home_with(self.tmp.name, [touch_job("j1", self.marker)])

    def tearDown(self):
        self.st.close()
        self.tmp.cleanup()

    def run_cli(self, argv, env):
        out = []
        with mock.patch.object(runner.subprocess, "run", side_effect=AssertionError("a process was started")):
            rc = cli.main(["--home", str(self.h)] + argv, log=out.append, env=env)
        return rc, "\n".join(out)

    def test_run_without_live_is_refused(self):
        rc, out = self.run_cli(["run"], {"TOKEN_BURNER_ALLOW_LIVE": "1"})
        self.assertEqual(rc, 2)
        self.assertIn("dormant", out)

    def test_live_flag_without_the_env_var_is_refused(self):
        for env in ({}, {"TOKEN_BURNER_ALLOW_LIVE": "yes"}, {"TOKEN_BURNER_ALLOW_LIVE": "0"}):
            rc, out = self.run_cli(["run", "--live"], env)
            self.assertEqual(rc, 2, env)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.st.q("SELECT * FROM runs"), [])

    def test_live_runner_cannot_be_built_without_permission(self):
        with self.assertRaises(runner.LiveRefused):
            runner.LiveRunner(self.s, self.h / "out", self.h / "work")

    def test_plan_names_the_job_and_starts_nothing(self):
        rc, out = self.run_cli(["plan", "--no-meter"], {})
        self.assertEqual(rc, 0)
        self.assertIn("would start: j1", out)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.st.q("SELECT * FROM runs"), [])

    def test_simulate_needs_no_account(self):
        with mock.patch.object(meter, "read_seat", side_effect=AssertionError("meter read")):
            rc, out = self.run_cli(["simulate", "--days", "1"], {})
        self.assertEqual(rc, 0)
        self.assertIn("seat1", out)


class CleanEnvironment(unittest.TestCase):
    base = {"PATH": "/usr/bin", "ANTHROPIC_API_KEY": "sk-test-not-real", "ANTHROPIC_BASE_URL": "http://x",
            "CLAUDE_CONFIG_DIR": "/elsewhere", "KEEP_ME": "1"}

    def test_prompt_jobs_get_only_home_path_lang_and_the_seat(self):
        seat = config.Seat("work", "/tmp/a-seat")
        with mock.patch.dict(os.environ, self.base):
            env = runner.prompt_env(seat, config.Settings(claude_bin="/opt/bin/claude"))
        self.assertEqual(set(env), {"HOME", "PATH", "LANG", "CLAUDE_CONFIG_DIR"})
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], "/tmp/a-seat")
        self.assertTrue(env["PATH"].startswith("/opt/bin:"))

    def test_cmd_jobs_lose_billing_variables_and_get_the_seat(self):
        job = {"id": "j"}
        env = runner.cmd_env(config.Seat("work", "/tmp/a-seat"), job, base=self.base)
        for k in runner.BILLING_VARS:
            self.assertNotIn(k, env)
        self.assertEqual((env["CLAUDE_CONFIG_DIR"], env["TOKEN_BURNER_SEAT"], env["KEEP_ME"]), ("/tmp/a-seat", "work", "1"))
        default = runner.cmd_env(config.Seat("main", str(config.DEFAULT_SEAT_DIR)), job, base=self.base)
        self.assertNotIn("CLAUDE_CONFIG_DIR", default)   # the default login works only with it unset


class LiveCommandJobs(unittest.TestCase):
    """The live loop on command jobs (no model): verifier decides, admission hook can hold."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.ok_file, self.bad_file = t / "ok", t / "bad"
        self.h, self.s, self.st = home_with(self.tmp.name, [touch_job("good", self.ok_file),
                                                            touch_job("unverified", self.bad_file, verify_ok=False)])

    def tearDown(self):
        self.st.close()
        self.tmp.cleanup()

    def engine(self, admit=None):
        rn = runner.LiveRunner(self.s, self.h / "out", self.h / "work", allow_live=True)
        return engine.Engine(self.st, self.s, jobs.FileQueue(self.h / "queue.jsonl"), rn, admit=admit)

    def test_once_runs_the_queue_and_the_verifier_decides(self):
        self.s.warmup_ah = 0.0   # let the first tick start both jobs
        log = []
        cli.loop(self.st, self.s, self.engine(), True, log.append, sleep=lambda _: time.sleep(0.05))
        status = {k: v["status"] for k, v in self.st.job_status().items()}
        self.assertEqual(status, {"good": "done", "unverified": "failed"})
        self.assertTrue(self.ok_file.exists() and self.bad_file.exists())
        self.assertIn("verifier exit 1", self.st.job_status()["unverified"]["error"])

    def test_a_usage_limit_puts_the_job_back(self):
        self.s.seats[0] = config.Seat("main", str(self.h / "seat-main"))
        limited = {"id": "limited", "cmd": [PY, "-I", "-c", "print('You have hit your usage limit'); raise SystemExit(1)"]}
        res = runner.execute(jobs.parse_job(limited), self.s.seats[0], self.s, self.h / "out", self.h / "work")
        self.assertTrue(res["limit"])
        self.assertFalse(res["ok"])

    def test_admission_hook_can_hold_a_job(self):
        hold = [PY, "-I", "-c", "raise SystemExit(3)"]
        eng = self.engine(admit=lambda job, seat, w: runner.admission(hold, job, seat, w))
        res = eng.tick(time.time())
        self.assertEqual(res.launched, [])
        self.assertIn("admission hook held good", res.note)
        self.assertFalse(self.ok_file.exists())

    def test_interrupted_runs_go_back_in_the_queue(self):
        self.st.start_run({"id": "good", "agents": 1}, "main", time.time(), sim=False)
        self.engine().recover(time.time())
        self.assertEqual(self.st.job_status()["good"]["status"], "queued")
        self.assertEqual(self.st.running(), [])


if __name__ == "__main__":
    unittest.main()
