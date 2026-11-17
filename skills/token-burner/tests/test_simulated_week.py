"""End to end on a fake clock: simulated meters, the real scheduler and engine, simulated jobs."""
import unittest

from token_burner import config, meter, scheduler, simulate

START = 1_800_000_000.0


def at_deadline(store, seat, s):
    """Week % at the last reading before the first deadline."""
    rs = store.readings(seat)
    dl = scheduler.deadline(rs[0]["week_reset"], s.lead_hours)
    return [r for r in rs if r["at"] <= dl][-1]["week_pct"]


class TwoSeatsOneWeek(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = config.Settings()
        cls.store, cls.sims = simulate.simulate(cls.s, START, days=7)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()

    def test_each_seat_ends_near_the_target_before_its_reset(self):
        for seat in self.sims:
            self.assertAlmostEqual(at_deadline(self.store, seat, self.s), self.s.target_pct, delta=2.5, msg=seat)
            self.assertTrue(self.sims[seat].week_end_pct, seat)   # the reset happened inside the week

    def test_two_seats_never_burn_at_once(self):
        self.assertEqual(self.store.q("SELECT at FROM ticks WHERE burner=1 GROUP BY at HAVING count(*)>1"), [])
        runs = self.store.q("SELECT seat, started, finished FROM runs ORDER BY started")
        self.assertGreater(len(runs), 100)
        for i, a in enumerate(runs):
            for b in runs[i + 1:]:
                if b["started"] >= a["finished"]:
                    break
                self.assertEqual(a["seat"], b["seat"], "runs on two seats overlap")

    def test_rate_is_learned_and_caps_hold(self):
        for seat, ss in self.sims.items():
            last = self.store.one("SELECT rate FROM ticks WHERE seat=? ORDER BY id DESC LIMIT 1", (seat,))
            self.assertAlmostEqual(last["rate"], ss.true_rate, delta=0.03)
        self.assertLessEqual(max(r["width"] for r in self.store.q("SELECT width FROM ticks")), self.s.max_width)


class OneSeatWrongPrior(unittest.TestCase):
    def test_reaches_the_target_when_the_prior_is_twice_too_high(self):
        """A plan where an agent-hour costs 0.3 %, not the prior's 0.7 %: the meter teaches the rate."""
        s = config.Settings()
        sims = {"solo": meter.SimSeat(60.0, START + 2 * 86400, true_rate=0.3, five_rate=1.2)}
        store, sims = simulate.simulate(s, START, days=2.5, sims=sims)
        self.addCleanup(store.close)
        self.assertAlmostEqual(at_deadline(store, "solo", s), s.target_pct, delta=2.5)


class FiveHourWindow(unittest.TestCase):
    def test_a_costly_window_is_never_pushed_far_past_its_cap(self):
        """Each agent-hour fills 25 % of the five-hour window: the cap, not the week, limits the width."""
        s = config.Settings()
        sims = {"solo": meter.SimSeat(10.0, START + 3 * 86400, true_rate=0.75, five_rate=25.0)}
        store, _ = simulate.simulate(s, START, days=3, sims=sims)
        self.addCleanup(store.close)
        peak = max(r["five_pct"] for r in store.readings("solo"))
        # one tick at full width can still land past the cap before the rate is measured
        self.assertLessEqual(peak, s.five_hour_cap + s.max_width * 25.0 * s.tick_minutes / 60)
        held = store.q("SELECT count(*) n FROM ticks WHERE reason LIKE 'five-hour%'")[0]["n"]
        self.assertGreater(held, 0)


if __name__ == "__main__":
    unittest.main()
