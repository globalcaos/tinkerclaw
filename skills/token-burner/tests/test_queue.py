import datetime
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path

from token_burner import config, jobs, meter, runner, store as storemod


class QueueFile(unittest.TestCase):
    def load(self, text):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "q.jsonl"
            p.write_text(text)
            return jobs.load(p)

    def test_reads_jobs_in_order_and_skips_comments(self):
        q = self.load('# my jobs\n\n{"id": "a", "prompt": "do a"}\n{"id": "b", "cmd": "make test", "agents": 2, "verify": "test -s out"}\n')
        self.assertEqual([j["id"] for j in q], ["a", "b"])
        self.assertEqual(q[1]["cmd"], ["make", "test"])
        self.assertEqual(q[1]["verify"], ["test", "-s", "out"])
        self.assertEqual((q[0]["agents"], q[0]["timeout"]), (1, 3600))

    def test_bad_lines_say_where(self):
        bad = ['{"id": "a"}', '{"id": "a", "prompt": "x", "cmd": "y"}', '{"id": "a b", "prompt": "x"}',
               '{"id": "a", "cmd": "y", "model": "m"}', '{"id": "a", "prompt": "x", "agents": 0}',
               '{"id": "a", "prompt": "x", "colour": "red"}', 'not json',
               '{"id": "a", "prompt": "x"}\n{"id": "a", "prompt": "y"}']
        for text in bad:
            with self.assertRaises(jobs.QueueError, msg=text) as cm:
                self.load(text)
            self.assertIn("line", str(cm.exception))

    def test_missing_file_is_an_empty_queue(self):
        self.assertEqual(jobs.load("/nonexistent/queue.jsonl"), [])

    def test_pending_skips_started_and_finished_jobs(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "q.jsonl"
            p.write_text("\n".join(json.dumps({"id": i, "prompt": "x"}) for i in "abcd"))
            status = {"a": {"status": "done"}, "b": {"status": "running"}, "c": {"status": "queued"}}
            self.assertEqual([j["id"] for j in jobs.FileQueue(p).pending(status)], ["c", "d"])


class PromptCommand(unittest.TestCase):
    def test_flags_follow_the_job(self):
        job = jobs.parse_job({"id": "a", "prompt": "x", "model": "claude-sonnet-5-5", "tools": ["Read", "Edit"],
                              "permission_mode": "acceptEdits", "system": "Be brief."})
        argv = runner.prompt_argv(job, config.Settings(claude_bin="/opt/claude"))
        self.assertEqual(argv[:5], ["/opt/claude", "-p", "--output-format", "json", "--no-session-persistence"])
        self.assertIn("--tools=Read,Edit", argv)
        for flag, val in (("--model", "claude-sonnet-5-5"), ("--permission-mode", "acceptEdits"),
                          ("--append-system-prompt", "Be brief.")):
            self.assertEqual(argv[argv.index(flag) + 1], val)
        self.assertNotIn("x", argv)   # the prompt goes on stdin


class Meter(unittest.TestCase):
    # Shape of the usage endpoint's reply; the values are invented.
    REPLY = {"five_hour": {"utilization": 12.0, "resets_at": "2026-01-08T14:00:00.512+00:00"},
             "seven_day": {"utilization": 41.0, "resets_at": "2026-01-10T09:00:00.104+00:00"}}

    def test_parse(self):
        r = meter.parse_usage(self.REPLY)
        self.assertEqual((r["week_pct"], r["five_pct"]), (41.0, 12.0))
        self.assertAlmostEqual(r["week_reset"] - r["five_reset"], 43 * 3600, delta=1)
        with self.assertRaises(meter.MeterError):
            meter.parse_usage({"five_hour": {}})

    def test_token_goes_only_to_the_usage_endpoint(self):
        with tempfile.TemporaryDirectory() as d:
            seat = config.Seat("s", d)
            (Path(d) / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {"accessToken": "tok-test"}}))
            seen = []

            def opener(req, timeout):
                seen.append((req.full_url, req.get_header("Authorization")))
                return io.BytesIO(json.dumps(self.REPLY).encode())
            r = meter.read_seat(seat, opener=opener)
            self.assertEqual(seen, [(config.USAGE_URL, "Bearer tok-test")])
            self.assertEqual(r["week_pct"], 41.0)
            st = storemod.Store(":memory:")
            self.addCleanup(st.close)
            out = meter.read_all(st, config.Settings(seats=[seat]), 100.0, read=lambda s: meter.read_seat(s, opener=opener))
            self.assertEqual(out["s"]["week_pct"], 41.0)
            self.assertEqual(st.last_reading("s")["week_pct"], 41.0)
            self.assertNotIn("tok-test", json.dumps(st.q("SELECT * FROM readings")))

    def test_errors_are_messages_not_crashes(self):
        with tempfile.TemporaryDirectory() as d:
            st = storemod.Store(":memory:")
            self.addCleanup(st.close)
            out = meter.read_all(st, config.Settings(seats=[config.Seat("s", d)]), 0.0)
            self.assertIn("not logged in", out["s"])
            (Path(d) / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {"accessToken": "t"}}))

            def refuse(req, timeout):
                raise urllib.error.HTTPError(req.full_url, 401, "no", {}, None)
            with self.assertRaises(meter.MeterError):
                meter.read_seat(config.Seat("s", d), opener=refuse)

    def test_next_reset(self):
        thu = datetime.datetime(2026, 1, 8, 16, tzinfo=datetime.timezone.utc).timestamp()   # a Thursday
        self.assertEqual(meter.next_reset(thu - 3600, 3, 16), thu)
        self.assertEqual(meter.next_reset(thu, 3, 16), thu + 7 * 86400)


class Settings(unittest.TestCase):
    def test_round_trip_and_unknown_keys(self):
        with tempfile.TemporaryDirectory() as d:
            s = config.Settings(seats=[config.Seat("a", "~/.claude"), config.Seat("b", "~/.claude-b")], target_pct=90)
            config.save(s, d)
            t = config.load(d)
            self.assertEqual((t.target_pct, [x.id for x in t.seats]), (90, ["a", "b"]))
            self.assertTrue(t.seats[0].is_default)
        with self.assertRaises(ValueError):
            config.Settings.from_dict({"targett_pct": 90})


if __name__ == "__main__":
    unittest.main()
