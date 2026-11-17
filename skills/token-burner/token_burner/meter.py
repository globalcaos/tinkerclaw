"""Seat meters. The real one asks the subscription usage endpoint about one login, using that login's
own token from its config folder. Read-only: the token is sent only to the usage endpoint and is never
printed, logged or stored. SimSeat stands in for a seat in the simulation."""
import datetime
import json
import urllib.error
import urllib.request

from . import config


class MeterError(Exception):
    pass


def _epoch(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() if iso else None


def parse_usage(d):
    """Usage endpoint JSON -> reading dict (percentages; reset times in epoch seconds)."""
    five, week = d.get("five_hour") or {}, d.get("seven_day") or {}
    if week.get("utilization") is None:
        raise MeterError("no seven_day utilization in the reply")
    return {"week_pct": float(week["utilization"]), "week_reset": _epoch(week.get("resets_at")),
            "five_pct": float(five.get("utilization") or 0.0), "five_reset": _epoch(five.get("resets_at"))}


def read_seat(seat, timeout=20, opener=urllib.request.urlopen):
    creds = seat.path / ".credentials.json"
    if not creds.exists():
        raise MeterError(f"seat {seat.id} is not logged in here ({creds.name} missing; on macOS the login "
                         "sits in the Keychain, which this meter does not read)")
    tok = (json.loads(creds.read_text()).get("claudeAiOauth") or {}).get("accessToken")
    if not tok:
        raise MeterError(f"seat {seat.id}: no access token in its credentials")
    req = urllib.request.Request(config.USAGE_URL, headers={"Authorization": "Bearer " + tok,
                                                            "anthropic-beta": "oauth-2025-04-20"})
    try:
        d = json.load(opener(req, timeout=timeout))
    except urllib.error.HTTPError as e:
        raise MeterError(f"seat {seat.id}: usage endpoint HTTP {e.code} (an expired token refreshes on the "
                         "seat's next Claude Code call)")
    except (urllib.error.URLError, TimeoutError) as e:
        raise MeterError(f"seat {seat.id}: usage endpoint unreachable: {e}")
    return parse_usage(d)


def read_all(store, settings, now, read=read_seat):
    """One reading per seat into the store. Returns {seat id: reading dict or error string}."""
    out = {}
    for s in settings.seats:
        try:
            r = read(s)
        except MeterError as e:
            out[s.id] = str(e)
            continue
        store.add_reading(s.id, now, r, "meter")
        out[s.id] = r
    return out


class SimSeat:
    """A seat for the simulation. week % grows by true_rate per agent-hour, plus your own chats while
    the seat is not burning; the five-hour window opens at the first use after it expires, like the
    real one. The rates are simulation inputs, not measurements."""

    def __init__(self, week_pct, week_reset, true_rate=0.75, five_rate=3.0, chat_rate=0.0):
        self.week_pct, self.week_reset = week_pct, week_reset
        self.true_rate, self.five_rate, self.chat_rate = true_rate, five_rate, chat_rate
        self.five_pct, self.five_reset = 0.0, None
        self.week_end_pct = []   # (reset time, week % just before it)

    def advance(self, now, hours, agent_hours, chatting):
        if now >= self.week_reset:
            self.week_end_pct.append((self.week_reset, self.week_pct))
            self.week_pct, self.week_reset = 0.0, self.week_reset + 7 * 86400
        if self.five_reset is not None and now >= self.five_reset:
            self.five_pct, self.five_reset = 0.0, None
        burn = agent_hours * self.true_rate
        chat = self.chat_rate * hours if chatting else 0.0
        if burn + chat > 0 and self.five_reset is None:
            self.five_reset = now + 5 * 3600
        self.week_pct = min(100.0, self.week_pct + burn + chat)
        self.five_pct = min(100.0, self.five_pct + agent_hours * self.five_rate + chat * self.five_rate / self.true_rate)

    def reading(self):
        return {"week_pct": self.week_pct, "week_reset": self.week_reset, "five_pct": self.five_pct,
                "five_reset": self.five_reset}


def next_reset(now, weekday, hour_utc):
    """Next weekly reset strictly after now (weekday 0 = Monday), UTC."""
    t = datetime.datetime.fromtimestamp(now, datetime.timezone.utc)
    cand = t.replace(hour=hour_utc, minute=0, second=0, microsecond=0) + datetime.timedelta(days=(weekday - t.weekday()) % 7)
    if cand.timestamp() <= now:
        cand += datetime.timedelta(days=7)
    return cand.timestamp()
