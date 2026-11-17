"""One scheduler tick, shared by the simulation, `plan` and the live loop: collect finished jobs,
learn each seat's rate, decide the width, start jobs on the burning seat."""
from dataclasses import dataclass, field

from . import jobs as jobsmod, scheduler

WINDOW = 8 * 86400   # readings and runs older than this no longer teach the rate
MAX_ATTEMPTS = 3     # a job stopped by a usage limit goes back in the queue this many times at most


@dataclass
class TickResult:
    decisions: dict
    launched: list = field(default_factory=list)   # job ids started (or, in a plan, that would start)
    note: str = None


class Engine:
    def __init__(self, store, settings, queue, runner=None, admit=None):
        self.store, self.s, self.queue, self.runner, self.admit = store, settings, queue, runner, admit
        self.last = None   # (burner seat, width) of the last tick

    def estimates(self, now):
        return {seat.id: scheduler.estimate_rate(self.store.readings(seat.id, now - WINDOW),
                                                 self.store.runs(seat.id, now - WINDOW),
                                                 self.s.prior_rate, self.s.prior_weight_ah)
                for seat in self.s.seats}

    def collect(self, now):
        """Settle jobs whose run has ended."""
        if self.runner is None:
            return []
        done = self.runner.poll(now)
        status = self.store.job_status()
        for run_id, job, res, at in done:
            if res["ok"] and res["verified"] is not False:
                st = "done"
            elif res.get("limit") and status.get(job["id"], {}).get("attempts", 0) < MAX_ATTEMPTS:
                st = "queued"
            else:
                st = "failed"
            self.store.finish_run(run_id, at, res["ok"], res["verified"], res["error"], res["output"], st)
        return done

    def recover(self, now):
        """Runs left open by a stopped process go back in the queue."""
        for r in self.store.running():
            self.store.finish_run(r["id"], now, False, None, "interrupted (the burner stopped)", None, "queued")

    def tick(self, now, launch=True):
        self.collect(now)
        readings = {seat.id: self.store.last_reading(seat.id) for seat in self.s.seats}
        ds = scheduler.decide(readings, self.estimates(now), now, self.s, self.store.get("burner"))
        live = int(launch and self.runner is not None and not self.runner.sim)
        for d in ds.values():
            r = readings.get(d.seat) or {}
            self.store.x("""INSERT INTO ticks(at, seat, week_pct, target_pct, needed, rate, width, burner, reason, live)
                            VALUES (?,?,?,?,?,?,?,?,?,?)""",
                         (now, d.seat, r.get("week_pct"), self.s.target_pct, d.needed, d.rate, d.width,
                          int(d.burner), d.reason, live))
        burner = next((d for d in ds.values() if d.burner), None)
        self.store.put("burner", burner.seat if burner else None)
        self.last = (burner.seat, burner.width) if burner else None
        out = TickResult(ds)
        if burner is not None:
            self._launch(burner.seat, burner.width, now, launch, out)
        return out

    def fill(self, now):
        """Between ticks: settle finished jobs and refill their slots at the last tick's width."""
        done = self.collect(now)
        out = TickResult({})
        if done and self.last:
            self._launch(*self.last, now, True, out)
        return done, out

    def _launch(self, burner, width, now, launch, out):
        running = self.store.running()
        elsewhere = sorted({r["seat"] for r in running if r["seat"] != burner})
        if elsewhere:   # never two seats burning at once: the switch waits for the old seat's jobs
            out.note = f"waiting for {', '.join(elsewhere)} to finish before {burner} starts"
            return
        free = width - sum(r["agents"] for r in running)
        if free <= 0:
            return
        try:
            pending = self.queue.pending(self.store.job_status())
        except jobsmod.QueueError as e:
            out.note = f"queue not read: {e}"
            return
        if not pending:
            out.note = "queue is empty"
        seat = next(x for x in self.s.seats if x.id == burner)
        for job in pending:
            if free <= 0:
                break
            if job["agents"] > self.s.max_width:
                out.note = f"{job['id']} wants {job['agents']} agents, more than max_width {self.s.max_width}"
                continue
            if job["agents"] > free:
                continue
            if launch:
                ok, why = self.admit(job, seat, width) if self.admit else (True, None)
                if not ok:
                    out.note = why
                    break
                run_id = self.store.start_run(job, seat.id, now, self.runner.sim)
                self.runner.start(job, seat, now, run_id)
            out.launched.append(job["id"])
            free -= job["agents"]
