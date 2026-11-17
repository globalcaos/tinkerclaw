"""Command dispatch for token-burner.py."""
import argparse
import json
import time
from pathlib import Path

from . import config, engine as enginemod, jobs, meter, runner as runnermod, simulate as simmod, steer as steermod, \
    store as storemod

DORMANT = ("token-burner is dormant. Nothing runs live without both --live and TOKEN_BURNER_ALLOW_LIVE=1 "
           "in the environment. Try `plan` to see what it would do, or `simulate` for a week on a fake clock.")


def paths(home):
    h = Path(home)
    return {"db": h / "state.db", "queue": h / "queue.jsonl", "out": h / "out", "work": h / "work"}


def show_tick(res, log):
    for d in res.decisions.values():
        log(f"{d.seat}: width {d.width}{' (burner)' if d.burner else ''}, needs {d.needed:.2f} %/h, "
            f"rate {d.rate:.2f} %/agent-hour, {d.reason}")
    if res.note:
        log(res.note)


def load_steer(log):
    """The objective and strategy every planned job carries, from the Tinker tab's settings.json."""
    st, note = steermod.load()
    if note:
        log(f"objective not used: {note}")
    log(f"objective: {st['label']}" if st else "objective: none set; jobs run as written")
    return st


def need_seats(s, log):
    if not s.seats:
        log("no seats configured; run `init --seat NAME=CONFIG_DIR` first")
        return False
    return True


def main(argv, log=print, env=None):
    ap = argparse.ArgumentParser(prog="token-burner.py", description="Spend a Claude subscription's weekly quota on your own job queue.")
    ap.add_argument("--home", default=None, help="data folder (default TOKEN_BURNER_HOME or ~/.local/share/token-burner)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init", help="write config.json")
    i.add_argument("--seat", action="append", default=[], metavar="NAME=CONFIG_DIR",
                   help="a Claude login; repeat for each seat (the default login is ~/.claude)")
    i.add_argument("--target", type=float, default=None, help="weekly target %% (default 92)")
    i.add_argument("--max-width", type=int, default=None)
    i.add_argument("--force", action="store_true", help="overwrite an existing config.json")
    sub.add_parser("meter", help="read each seat's usage meter once (read-only)")
    p = sub.add_parser("plan", help="what the next tick would do; starts nothing")
    p.add_argument("--no-meter", action="store_true", help="use the last stored readings")
    p.add_argument("--queue", default=None)
    r = sub.add_parser("run", help="the live loop (needs --live and TOKEN_BURNER_ALLOW_LIVE=1)")
    r.add_argument("--live", action="store_true")
    r.add_argument("--once", action="store_true", help="one tick, wait for its jobs, then exit")
    r.add_argument("--queue", default=None)
    sm = sub.add_parser("simulate", help="a simulated week; needs no account")
    sm.add_argument("--days", type=float, default=7.0)
    sm.add_argument("--seats", type=int, default=2)
    sm.add_argument("--rate", type=float, default=0.75, help="true %% of a week per agent-hour in the simulation")
    sm.add_argument("--five-rate", type=float, default=3.0, help="true five-hour %% per agent-hour")
    sm.add_argument("--chat-rate", type=float, default=0.03, help="%% per hour your own chats use on a free seat")
    sm.add_argument("--target", type=float, default=None)
    sm.add_argument("--seed", type=int, default=0)
    sub.add_parser("status", help="queue counts and the last decision per seat")
    a = ap.parse_args(argv)
    home = Path(a.home or config.data_home()).expanduser()
    pp = paths(home)

    if a.cmd == "init":
        if (home / "config.json").exists() and not a.force:
            log(f"{home / 'config.json'} exists; pass --force to overwrite")
            return 1
        s = config.Settings()
        for spec in a.seat:
            name, sep, d = spec.partition("=")
            if not sep or not name or not d:
                log(f"bad --seat {spec!r}; use NAME=CONFIG_DIR")
                return 1
            s.seats.append(config.Seat(name, d))
        if a.target is not None:
            s.target_pct = a.target
        if a.max_width is not None:
            s.max_width = a.max_width
        log(f"wrote {config.save(s, home)}; put jobs in {pp['queue']}")
        return 0

    if a.cmd == "simulate":
        s = config.Settings()
        if a.target is not None:
            s.target_pct = a.target
        start = time.time()
        sims = simmod.default_sims(start, n=a.seats, true_rate=a.rate, five_rate=a.five_rate, chat_rate=a.chat_rate)
        st, sims = simmod.simulate(s, start, days=a.days, sims=sims, seed=a.seed)
        log(json.dumps(simmod.report(st, s, sims), indent=1))
        st.close()
        return 0

    s = config.load(home)
    st = storemod.Store(pp["db"])
    try:
        return with_store(a, s, st, pp, log, env)
    finally:
        st.close()


def with_store(a, s, st, pp, log, env):
    if a.cmd == "status":
        counts = {r["status"]: r["n"] for r in st.q("SELECT status, count(*) n FROM jobs GROUP BY status")}
        try:
            counts["not started"] = len([j for j in jobs.load(pp["queue"]) if j["id"] not in st.job_status()])
        except jobs.QueueError as e:
            counts["queue error"] = str(e)
        steer, _ = steermod.load()
        log(json.dumps({"jobs": counts, "burner": st.get("burner"), "objective": steer["label"] if steer else None,
                        "last": st.q("SELECT seat, at, week_pct, width, burner, reason, live FROM ticks "
                                     "WHERE id IN (SELECT max(id) FROM ticks GROUP BY seat)")}, indent=1))
        return 0
    if not need_seats(s, log):
        return 1
    if a.cmd == "meter":
        for seat, rd in meter.read_all(st, s, time.time()).items():
            log(f"{seat}: {rd}" if isinstance(rd, str) else
                f"{seat}: week {rd['week_pct']:.0f} %, five-hour {rd['five_pct']:.0f} %, week resets "
                f"{time.strftime('%a %d %b %H:%M', time.localtime(rd['week_reset'] or 0))}")
        return 0
    q = jobs.FileQueue(a.queue or pp["queue"], steer=load_steer(log))
    if a.cmd == "plan":
        now = time.time()
        if not a.no_meter:
            for seat, rd in meter.read_all(st, s, now).items():
                if isinstance(rd, str):
                    log(rd)
        res = enginemod.Engine(st, s, q).tick(now, launch=False)
        show_tick(res, log)
        log(f"would start: {', '.join(res.launched) or 'nothing'}")
        return 0
    if a.cmd == "run":
        if not runnermod.live_allowed(a.live, env):
            log(DORMANT)
            return 2
        rn = runnermod.LiveRunner(s, pp["out"], pp["work"], allow_live=True)
        eng = enginemod.Engine(st, s, q, rn, admit=lambda job, seat, w: runnermod.admission(s.admission_cmd, job, seat, w))
        eng.recover(time.time())
        return loop(st, s, eng, a.once, log)
    return 1


def loop(st, s, eng, once, log, sleep=time.sleep, clock=time.time):
    period = s.tick_minutes * 60
    while True:
        t = clock()
        try:
            for seat, rd in meter.read_all(st, s, t).items():
                if isinstance(rd, str):
                    log(rd)
            res = eng.tick(t)
            show_tick(res, log)
            if res.launched:
                log(f"started: {', '.join(res.launched)}")
        except Exception as e:  # noqa: BLE001 - one bad tick never stops the loop
            log(f"tick failed: {type(e).__name__}: {e}")
        while clock() - t < period or (once and st.running()):
            sleep(30)
            if once:   # one tick only: settle its jobs, start no more
                done, refill = eng.collect(clock()), enginemod.TickResult({})
            else:
                done, refill = eng.fill(clock())
            for run_id, job, rr, _ in done:
                log(f"{job['id']}: {'done' if rr['ok'] and rr['verified'] is not False else 'failed: ' + str(rr['error'])}")
            if refill.launched:
                log(f"started: {', '.join(refill.launched)}")
            if once and not st.running():
                break
        if once:
            return 0
