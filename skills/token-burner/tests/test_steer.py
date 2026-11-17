"""The objective and strategy from the Tinker tab's settings.json reach every planned job: prompt jobs in
their system prompt, command jobs in their environment. No file means jobs run exactly as written."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from token_burner import cli, config, jobs, runner, steer, store as storemod

SETTINGS = {"objective": "backlog", "customName": "", "strategy": "one parked project per job\nverify with its tests",
            "promptPath": "/state/token-burner/prompt.md", "dashboardUrl": "", "updatedAt": "2026-11-03T10:00:00Z"}


class Steer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.settings = self.dir / "settings.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, d):
        self.settings.write_text(json.dumps(d))

    def test_reads_label_strategy_and_prompt(self):
        self.write(SETTINGS)
        st, note = steer.load(self.settings)
        self.assertIsNone(note)
        self.assertEqual(st["label"], "Clear my project backlog")
        self.assertEqual(st["strategy"], SETTINGS["strategy"])
        self.assertEqual(st["prompt_path"], SETTINGS["promptPath"])

    def test_custom_objective_uses_its_name(self):
        self.write(dict(SETTINGS, objective="custom", customName="Ship the app"))
        self.assertEqual(steer.load(self.settings)[0]["label"], "Ship the app")
        self.write(dict(SETTINGS, objective="code", customName="stale"))
        self.assertEqual(steer.load(self.settings)[0]["label"], "Improve and harden my code")

    def test_missing_or_bad_file_steers_nothing(self):
        self.assertEqual(steer.load(self.settings), (None, None))
        self.write(dict(SETTINGS, objective="fame"))
        st, note = steer.load(self.settings)
        self.assertIsNone(st)
        self.assertIn("objective must be one of", note)
        self.settings.write_text("{nope")
        self.assertIsNone(steer.load(self.settings)[0])

    def test_path_follows_the_state_dir(self):
        self.assertEqual(steer.settings_path({"OPENCLAW_STATE_DIR": "/s"}), Path("/s/token-burner/settings.json"))
        self.assertEqual(steer.settings_path({"TOKEN_BURNER_SETTINGS": "/x.json", "OPENCLAW_STATE_DIR": "/s"}),
                         Path("/x.json"))

    def test_queue_jobs_carry_the_steering(self):
        self.write(SETTINGS)
        st, _ = steer.load(self.settings)
        q = self.dir / "queue.jsonl"
        q.write_text("\n".join(json.dumps(j) for j in [
            {"id": "p1", "prompt": "do it", "system": "Be brief."},
            {"id": "c1", "cmd": ["true"]}]) + "\n")
        p1, c1 = jobs.FileQueue(q, steer=st).pending({})
        self.assertTrue(p1["system"].startswith("Be brief.\n\nSpare tokens go to: Clear my project backlog."))
        self.assertIn("verify with its tests", p1["system"])
        argv = runner.prompt_argv(p1, config.Settings())
        self.assertEqual(argv[argv.index("--append-system-prompt") + 1], p1["system"])
        env = runner.cmd_env(config.Seat("main", str(self.dir / "seat")), c1, base={})
        self.assertEqual(env["TOKEN_BURNER_OBJECTIVE"], "Clear my project backlog")
        self.assertEqual(env["TOKEN_BURNER_STRATEGY"], SETTINGS["strategy"])
        self.assertEqual(env["TOKEN_BURNER_PROMPT_FILE"], SETTINGS["promptPath"])
        self.assertNotIn("system", c1)

    def test_no_settings_leaves_jobs_untouched(self):
        q = self.dir / "queue.jsonl"
        q.write_text(json.dumps({"id": "p1", "prompt": "do it"}) + "\n")
        (p1,) = jobs.FileQueue(q).pending({})
        self.assertNotIn("system", p1)
        self.assertNotIn("TOKEN_BURNER_OBJECTIVE", runner.cmd_env(config.Seat("m", "/x"), p1, base={}))

    def test_plan_names_the_objective_and_starts_nothing(self):
        self.write(SETTINGS)
        home = self.dir / "home"
        config.save(config.Settings(seats=[config.Seat("main", str(home / "seat"))]), home)
        (home / "queue.jsonl").write_text(json.dumps({"id": "p1", "prompt": "do it"}) + "\n")
        st = storemod.Store(home / "state.db")
        st.add_reading("main", time.time(), {"week_pct": 10.0, "week_reset": time.time() + 3 * 86400,
                                             "five_pct": 0.0, "five_reset": None}, "test")
        st.close()
        out = []
        with mock.patch.dict("os.environ", {"TOKEN_BURNER_SETTINGS": str(self.settings)}), \
                mock.patch.object(runner.subprocess, "run", side_effect=AssertionError("a process was started")):
            rc = cli.main(["--home", str(home), "plan", "--no-meter"], log=out.append)
        self.assertEqual(rc, 0)
        self.assertIn("objective: Clear my project backlog", out)
        self.assertIn("would start: p1", out)


if __name__ == "__main__":
    unittest.main()
