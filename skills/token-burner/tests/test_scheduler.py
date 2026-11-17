import random
import unittest

from token_burner import config, scheduler

S = config.Settings()


def reading(at, week, reset, five=10.0, five_reset=None):
    return {"at": at, "week_pct": week, "week_reset": reset, "five_pct": five, "five_reset": five_reset or at + 3600}


def est(rate=0.7, evidence=10.0, five_rate=None):
    return scheduler.RateEstimate(rate, evidence, 0.0, five_rate)


class AgentHours(unittest.TestCase):
    def test_sweep_matches_the_direct_sum(self):
        rng = random.Random(1)
        runs = []
        for _ in range(60):
            a = rng.uniform(0, 50_000)
            runs.append({"started": a, "finished": a + rng.uniform(60, 9000) if rng.random() < 0.9 else None,
                         "agents": rng.choice([1, 1, 2])})
        times = sorted(rng.uniform(0, 60_000) for _ in range(40))
        cum = scheduler.cumulative_agent_hours(runs, times)
        for n in range(len(times) - 1):
            self.assertAlmostEqual(cum[n + 1] - cum[n], scheduler.agent_hours(runs, times[n], times[n + 1]), places=6)

    def test_agents_weight_the_hours(self):
        self.assertAlmostEqual(scheduler.agent_hours([{"started": 0, "finished": 3600, "agents": 3}], 0, 3600), 3.0)


class Rate(unittest.TestCase):
    def test_learns_the_rate_from_the_meter(self):
        reset = 10 * 86400
        rd = [reading(0, 40, reset), reading(4 * 3600, 46, reset)]   # +6 % in 4 h at width 2
        e = scheduler.estimate_rate(rd, [{"started": 0, "finished": 4 * 3600, "agents": 2}], 0.7, 0)
        self.assertAlmostEqual(e.rate, 0.75)
        self.assertAlmostEqual(e.evidence_ah, 8.0)

    def test_prior_dominates_a_short_noisy_interval(self):
        reset = 10 * 86400
        rd = [reading(0, 10, reset), reading(900, 13, reset)]   # +3 % in 15 min at width 1: a chat burst
        e = scheduler.estimate_rate(rd, [{"started": 0, "finished": 900}], 0.7, 4.0)
        self.assertLess(e.rate, 1.4)
        self.assertGreater(e.rate, 0.7)

    def test_resets_at_jitter_is_the_same_week(self):
        """The real meter's resets_at moves by fractions of a second between reads."""
        rd = [reading(0, 40, 1_793_894_400.06), reading(3600, 41.4, 1_793_894_400.21), reading(7200, 42.8, 1_793_894_399.91)]
        e = scheduler.estimate_rate(rd, [{"started": 0, "finished": 7200}], 0.7, 0)
        self.assertAlmostEqual(e.evidence_ah, 2.0)
        self.assertAlmostEqual(e.rate, 1.4)

    def test_interval_across_a_reset_is_ignored(self):
        rd = [reading(0, 90, 1000), reading(2000, 2, 1000 + 7 * 86400)]
        e = scheduler.estimate_rate(rd, [{"started": 0, "finished": 2000}], 0.7, 4.0)
        self.assertEqual(e.rate, 0.7)
        self.assertEqual(e.evidence_ah, 0)

    def test_idle_intervals_measure_the_background_only(self):
        reset = 10 * 86400
        rd = [reading(0, 10, reset), reading(3600, 11, reset)]
        e = scheduler.estimate_rate(rd, [], 0.7, 4.0)
        self.assertEqual(e.rate, 0.7)
        self.assertAlmostEqual(e.background, 1.0)


class OneSeat(unittest.TestCase):
    now = 1_000_000.0

    def decide(self, r, e=None):
        return scheduler.decide({"a": r}, {"a": e or est()}, self.now, S)["a"]

    def test_width_is_needed_rate_over_learned_rate(self):
        # 30 % to go in 20 h before the deadline at 0.75 %/agent-hour: 1.5 %/h -> width 2
        r = reading(self.now, S.target_pct - 30, self.now + (20 + S.lead_hours) * 3600)
        d = self.decide(r, est(0.75))
        self.assertAlmostEqual(d.needed, 1.5)
        self.assertEqual(d.width, 2)
        self.assertTrue(d.burner)

    def test_caps_and_stops(self):
        far = self.now + 30 * 3600
        cases = [
            (reading(self.now, 50, far, five=S.five_hour_cap), "five-hour window"),
            (reading(self.now, S.target_pct, far), "target reached"),
            (reading(self.now, 50, self.now + 3600), "last 2 h"),
            (reading(self.now - 3600, 50, far), "no fresh"),
        ]
        for r, why in cases:
            d = self.decide(r)
            self.assertEqual(d.width, 0, why)
            self.assertFalse(d.burner, why)
            self.assertIn(why, d.reason)
        d = self.decide(reading(self.now, 1, far))
        self.assertEqual((d.width, d.reason), (S.max_width, "max width"))

    def test_warm_up_holds_width_one_until_measured(self):
        d = self.decide(reading(self.now, 1, self.now + 30 * 3600), est(evidence=0.0))
        self.assertEqual(d.width, 1)
        self.assertIn("warm-up", d.reason)

    def test_five_hour_headroom_once_measured(self):
        d = self.decide(reading(self.now, 1, self.now + 30 * 3600, five=86), est(five_rate=8.0))
        self.assertEqual(d.width, 3)   # (92 - 86) / (8 * 0.25) = 3
        d = self.decide(reading(self.now, 1, self.now + 30 * 3600, five=89), est(five_rate=8.0))
        self.assertEqual(d.width, 1)
        self.assertEqual(d.reason, "five-hour headroom")


class TwoSeats(unittest.TestCase):
    now = 1_000_000.0
    e = {"a": est(), "b": est()}

    def test_earliest_deadline_burns_the_other_stays_free(self):
        rd = {"a": reading(self.now, 30, self.now + 80 * 3600), "b": reading(self.now, 60, self.now + 40 * 3600)}
        ds = scheduler.decide(rd, self.e, self.now, S)
        self.assertEqual([d.seat for d in ds.values() if d.burner], ["b"])
        self.assertEqual(ds["a"].width, 0)
        self.assertIn("free for chats", ds["a"].reason)

    def test_width_covers_the_seat_that_waits(self):
        """b alone needs 32 % in 38 h (width 1.2); a must also fit its 62 % before its own deadline,
        after b: (32 + 62) / 0.7 agent-hours in 78 h -> width 1.72, so 2."""
        rd = {"a": reading(self.now, 30, self.now + 80 * 3600), "b": reading(self.now, 60, self.now + 40 * 3600)}
        ds = scheduler.decide(rd, self.e, self.now, S)
        self.assertAlmostEqual(ds["b"].raw, (32 + 62) / 0.7 / 78, places=3)
        self.assertEqual(ds["b"].width, 2)

    def test_a_full_five_hour_window_hands_over(self):
        rd = {"a": reading(self.now, 30, self.now + 80 * 3600),
              "b": reading(self.now, 60, self.now + 40 * 3600, five=S.five_hour_cap + 1)}
        ds = scheduler.decide(rd, self.e, self.now, S)
        self.assertTrue(ds["a"].burner)
        self.assertIn("five-hour", ds["b"].reason)

    def test_equal_deadlines_keep_the_current_burner(self):
        dl = self.now + 50 * 3600
        rd = {"a": reading(self.now, 50, dl), "b": reading(self.now, 50, dl)}
        for cur in ("a", "b"):
            ds = scheduler.decide(rd, self.e, self.now, S, current_burner=cur)
            self.assertTrue(ds[cur].burner)
            self.assertEqual(sum(d.burner for d in ds.values()), 1)


if __name__ == "__main__":
    unittest.main()
