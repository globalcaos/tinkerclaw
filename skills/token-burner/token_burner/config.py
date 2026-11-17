"""Settings. Defaults live here; a config.json in the data folder overrides them. Every number can be
changed there; the defaults say where they come from."""
import json
import os
from dataclasses import dataclass, field, fields
from pathlib import Path

HOME = Path.home()
DEFAULT_SEAT_DIR = HOME / ".claude"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"


def data_home():
    return Path(os.environ.get("TOKEN_BURNER_HOME") or HOME / ".local/share/token-burner")


@dataclass
class Seat:
    id: str
    config_dir: str          # the folder Claude Code keeps this login in (CLAUDE_CONFIG_DIR)

    @property
    def path(self):
        return Path(self.config_dir).expanduser()

    @property
    def is_default(self):
        return self.path == DEFAULT_SEAT_DIR


@dataclass
class Settings:
    seats: list = field(default_factory=list)
    target_pct: float = 92.0        # end each week here; the rest stays for your own chats
    lead_hours: float = 2.0         # ... this long before the reset, so a late job cannot overshoot
    five_hour_cap: float = 92.0     # never push the five-hour window past this
    max_width: int = 3              # most agents in parallel, whatever the meter says
    tick_minutes: int = 15
    prior_rate: float = 0.7         # % of a week per agent-hour before anything is measured
    prior_weight_ah: float = 4.0    # the prior counts as this many agent-hours of evidence
    warmup_ah: float = 1.0          # width stays at 1 until this many agent-hours have been measured
    admission_cmd: object = None    # optional command; exit 0 admits a job, anything else holds it
    claude_bin: str = None          # default: `claude` on PATH
    model: str = None               # default: whatever the CLI picks
    effort: str = None

    @classmethod
    def from_dict(cls, d):
        known = {f.name for f in fields(cls)}
        unknown = set(d) - known
        if unknown:
            raise ValueError(f"unknown setting(s): {', '.join(sorted(unknown))}")
        s = cls(**{k: v for k, v in d.items() if k != "seats"})
        s.seats = [Seat(x["id"], x["config_dir"]) for x in d.get("seats", [])]
        if len({x.id for x in s.seats}) != len(s.seats):
            raise ValueError("seat ids must be unique")
        return s

    def to_dict(self):
        d = {f.name: getattr(self, f.name) for f in fields(self)}
        d["seats"] = [{"id": x.id, "config_dir": x.config_dir} for x in self.seats]
        return d


def load(home=None):
    p = Path(home or data_home()) / "config.json"
    return Settings.from_dict(json.loads(p.read_text())) if p.exists() else Settings()


def save(settings, home=None):
    p = Path(home or data_home()) / "config.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(settings.to_dict(), indent=1) + "\n")
    return p
