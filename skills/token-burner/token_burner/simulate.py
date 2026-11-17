"""A simulated week on a fake clock: simulated seat meters, the real scheduler and engine, simulated
jobs. No account, no model, no network."""
from . import config, engine as enginemod, jobs, meter, runner as runnermod, scheduler, store as storemod

SUBSTEPS = 5


def default_sims(start, n=2, start_pcts=(60.0, 20.0), reset_days=(2.0, 4.5), true_rate=0.75, five_rate=3.0,
                 chat_rate=0.03):
    sims = {}
    for i in range(n):
        sims[f"seat{i + 1}"] = meter.SimSeat(start_pcts[i % len(start_pcts)], start + reset_days[i % len(reset_days)] * 86400,
                                             true_rate=true_rate, five_rate=five_rate, chat_rate=chat_rate)
    return sims


def simulate(settings, start, days=7.0, sims=None, store=None, seed=0, log=None):
    """Run `days` of ticks. Returns (store, {seat: SimSeat}). settings.seats is filled from sims."""
    sims = sims or default_sims(start)
    store = store or storemod.Store(":memory:")
    settings.seats = [config.Seat(sid, f"/nonexistent/sim/{sid}") for sid in sims]
    eng = enginemod.Engine(store, settings, jobs.SimQueue(seed), runnermod.SimRunner())
    tick = settings.tick_minutes * 60
    step = tick / SUBSTEPS   # the live loop refills freed slots every 30 s; the simulation every `step`
    t, end = start, start + days * 86400
    while t <= end:
        eng.collect(t)
        burner = store.get("burner")
        for sid, ss in sims.items():
            ah = scheduler.agent_hours(store.runs(sid, t - tick), t - tick, t)
            ss.advance(t, tick / 3600, ah, chatting=sid != burner)
            store.add_reading(sid, t, ss.reading(), "sim")
        res = eng.tick(t)
        if log:
            log(t, res)
        for k in range(1, SUBSTEPS):
            eng.fill(t + k * step)
        t += tick
    eng.collect(end + 86400)
    return store, sims


def report(store, settings, sims):
    """Per seat: week % at the deadline before each reset, peak five-hour %, learned rate."""
    out = {}
    for sid, ss in sims.items():
        rs = store.readings(sid)
        resets = sorted({round(r["week_reset"]) for r in rs})
        at_deadline = []
        for rst in resets:
            before = [r for r in rs if abs(r["week_reset"] - rst) < 3600 and r["at"] <= scheduler.deadline(rst, settings.lead_hours)]
            if before and rst <= rs[-1]["at"]:
                at_deadline.append(round(before[-1]["week_pct"], 1))
        last = store.one("SELECT rate FROM ticks WHERE seat=? ORDER BY id DESC LIMIT 1", (sid,))
        out[sid] = {"week_pct_at_deadline": at_deadline, "peak_five_hour_pct": round(max(r["five_pct"] for r in rs), 1),
                    "learned_rate": round(last["rate"], 3) if last else None, "true_rate": ss.true_rate}
    out["ticks_with_two_burners"] = len(store.q("SELECT at FROM ticks WHERE burner=1 GROUP BY at HAVING count(*)>1"))
    out["jobs_run"] = store.one("SELECT count(*) n FROM runs")["n"]
    return out
