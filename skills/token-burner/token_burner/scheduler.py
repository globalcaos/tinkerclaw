"""When to burn, and how wide. Every tick:
  per seat, agent-hours needed = (target - used) / measured % per agent-hour
  deadline                     = weekly reset - lead hours
  width = the steady number of agents that meets every seat's deadline when the seats burn one at a
          time, earliest deadline first; rounded, capped by max_width, the warm-up and the five-hour window.
Only one seat burns at a time; the others stay free for your own chats."""
import math
from dataclasses import dataclass, field

STALE_SECS = 45 * 60   # a reading older than this is no basis for burning
SAME_RESET = 3600      # the meter's resets_at jitters by fractions of a second between reads


def same_window(r1, r2):
    """Both resets known and within an hour of each other: the same window."""
    return r1 is not None and r2 is not None and abs(r1 - r2) < SAME_RESET


def agent_hours(runs, t0, t1):
    """Agent-hours of runs overlapping [t0, t1). A run without a finish counts up to t1."""
    total = 0.0
    for r in runs:
        a, b = r["started"], r.get("finished") or t1
        total += max(0.0, min(b, t1) - max(a, t0)) * (r.get("agents") or 1)
    return total / 3600.0


def cumulative_agent_hours(runs, times):
    """Agent-hours burned from the first event up to each of the sorted `times`, in one sweep; the
    difference of two entries is agent_hours() of that interval. Open runs count up to each time."""
    events = sorted(e for r in runs for e in ((r["started"], r.get("agents") or 1),
                                              (r.get("finished") or float("inf"), -(r.get("agents") or 1))))
    out, total, active, last, i = [], 0.0, 0, None, 0
    for t in times:
        while i < len(events) and events[i][0] <= t:
            et, k = events[i]
            total += active * (et - last) if last is not None else 0.0
            last, active, i = et, active + k, i + 1
        total += active * (t - last) if last is not None else 0.0
        last = t
        out.append(total / 3600.0)
    return out


@dataclass
class RateEstimate:
    rate: float                 # % of a week per agent-hour
    evidence_ah: float          # agent-hours of measured burning behind it
    background: float           # % per hour while nothing of ours ran (your own chats)
    five_rate: float = None     # five-hour % per agent-hour; None until measured
    intervals: list = field(default_factory=list)


def estimate_rate(readings, runs, prior, prior_weight):
    """Learn the rate from the meter. Consecutive readings of one seat inside the same week give an
    interval (delta %, agent-hours). Burning intervals measure our rate; idle ones measure the
    background. The prior counts as prior_weight agent-hours, so one noisy interval cannot swing the
    width, and a long burn overrides it."""
    idle_d = idle_h = 0.0
    busy, five = [], []
    cum = cumulative_agent_hours(runs, [r["at"] for r in readings])
    for n, (a, b) in enumerate(zip(readings, readings[1:])):
        if not same_window(a["week_reset"], b["week_reset"]) or b["week_pct"] < a["week_pct"]:
            continue   # the week reset inside the interval
        hours = (b["at"] - a["at"]) / 3600.0
        if hours <= 0:
            continue
        ah = cum[n + 1] - cum[n]
        d = b["week_pct"] - a["week_pct"]
        if ah < 1e-6:
            idle_d, idle_h = idle_d + d, idle_h + hours
        else:
            busy.append((d, hours, ah))
            if same_window(a.get("five_reset"), b.get("five_reset")) and b["five_pct"] >= a["five_pct"]:
                five.append((b["five_pct"] - a["five_pct"], ah))
    background = idle_d / idle_h if idle_h else 0.0
    burn_d = sum(d for d, _, _ in busy)
    burn_ah = sum(ah for _, _, ah in busy)
    rate = (prior * prior_weight + burn_d) / (prior_weight + burn_ah)
    five_ah = sum(ah for _, ah in five)
    five_rate = sum(d for d, _ in five) / five_ah if five_ah >= 0.5 else None
    return RateEstimate(rate, burn_ah, background, five_rate, busy)


def deadline(week_reset, lead_hours):
    return week_reset - lead_hours * 3600


def needed_rate(week_pct, week_reset, now, target, lead_hours):
    """% per hour still needed to reach the target at the deadline; None once the deadline has passed."""
    hours = (deadline(week_reset, lead_hours) - now) / 3600.0
    if hours <= 0:
        return None
    return max(0.0, target - week_pct) / hours


@dataclass
class Decision:
    seat: str
    width: int
    raw: float          # unrounded, uncapped width: for the burner, what every seat's demand asks of it
    needed: float       # % per hour this seat still needs to reach the target at its deadline
    rate: float
    reason: str
    burner: bool = False


def _state(reading, est, now, s):
    """(status, needed %/h, reason). status: 'idle' (nothing to burn or no basis), 'blocked' (needs
    burning but its five-hour window is full), 'ready'."""
    if not reading or now - reading["at"] > STALE_SECS:
        return "idle", 0.0, "no fresh meter reading"
    if reading.get("week_reset") is None:
        return "idle", 0.0, "meter gave no weekly reset time"
    if reading["week_pct"] >= s.target_pct:
        return "idle", 0.0, "weekly target reached"
    need = needed_rate(reading["week_pct"], reading["week_reset"], now, s.target_pct, s.lead_hours)
    if need is None:
        return "idle", 0.0, f"inside the last {s.lead_hours:g} h before reset"
    if reading["five_pct"] >= s.five_hour_cap:
        return "blocked", need, f"five-hour window at {reading['five_pct']:.0f} %"
    return "ready", need, "ready"


def demand_width(seats, now, s):
    """Seats burn one at a time, earliest deadline first. To meet every deadline at one steady width w,
    the agent-hours of the first k seats must fit before the k-th deadline: w >= sum(A_1..A_k) / H_k.
    seats: [(deadline, agent-hours still needed)]. Returns the largest such ratio."""
    width, total = 0.0, 0.0
    for dl, ah in sorted(seats):
        total += ah
        width = max(width, total / max((dl - now) / 3600.0, 1e-9))
    return width


def decide(readings, estimates, now, s, current_burner=None):
    """readings / estimates: {seat: last reading / RateEstimate}; s: config.Settings. One Decision per
    seat; only the burner has a width above zero. The burner is the ready seat with the earliest
    deadline (ties keep the current burner); its width covers what all seats still need, capped by
    max_width, the warm-up and its own five-hour headroom."""
    ds, open_ = {}, []
    for seat, est in estimates.items():
        r = readings.get(seat)
        st, need, why = _state(r, est, now, s)
        ds[seat] = Decision(seat, 0, need / est.rate if need else 0.0, need, est.rate, why)
        if st != "idle":
            dl = deadline(r["week_reset"], s.lead_hours)
            open_.append((dl, seat, st, need * (dl - now) / 3600.0 / est.rate))
    ready = sorted((dl, seat != current_burner, seat) for dl, seat, st, _ in open_ if st == "ready")
    if not ready:
        return ds
    b = ds[ready[0][2]]
    est, r = estimates[b.seat], readings[b.seat]
    raw = demand_width([(dl, ah) for dl, _, _, ah in open_], now, s)
    width, why = int(math.floor(raw + 0.5)), "on pace"
    if width > s.max_width:
        width, why = s.max_width, "max width"
    if est.evidence_ah < s.warmup_ah and width > 1:
        width, why = 1, "warm-up: measuring the rate at width 1"
    if est.five_rate:   # keep the five-hour window under its cap until the next tick
        room = int((s.five_hour_cap - r["five_pct"]) / (est.five_rate * s.tick_minutes / 60))
        if room < width:
            width, why = max(0, room), "five-hour headroom"
    if width == 0 and why == "on pace":
        why = "ahead of pace"
    b.width, b.raw, b.reason, b.burner = width, raw, why, width > 0
    for d in ds.values():
        if d is not b and d.reason == "ready":
            d.reason = f"free for chats while {b.seat} burns" if b.burner else "ahead of pace"
    return ds
