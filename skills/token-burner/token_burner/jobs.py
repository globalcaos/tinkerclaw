"""The job queue: a JSON Lines file you write. One job per line, run once each, in file order.

  {"id": "fix-typos", "prompt": "Fix the typos in README.md", "cwd": "~/src/myproject",
   "tools": ["Read", "Edit"], "permission_mode": "acceptEdits", "verify": ["sh", "-c", "! git diff --quiet"]}
  {"id": "nightly-tests", "cmd": ["./run-agent-tests.sh"], "cwd": "~/src/myproject", "agents": 2,
   "verify": ["pytest", "-q"]}

prompt jobs run `claude -p` on the burning seat; cmd jobs run your command with that seat's
CLAUDE_CONFIG_DIR set. verify is an optional command run in the job's folder afterwards: exit 0 means
the job produced what you wanted. Blank lines and lines starting with # are skipped. The file is read
again at every tick, so you can append jobs while it runs."""
import json
import random
import re
import shlex
from pathlib import Path

from . import steer as steermod

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
PROMPT_ONLY = ("model", "effort", "tools", "allowed_tools", "permission_mode", "system")
KNOWN = {"id", "prompt", "cmd", "verify", "cwd", "timeout", "agents"} | set(PROMPT_ONLY)


class QueueError(Exception):
    pass


def argv_of(v, what, where):
    if isinstance(v, str):
        argv = shlex.split(v)
    elif isinstance(v, list) and all(isinstance(x, str) for x in v):
        argv = list(v)
    else:
        raise QueueError(f"{where}: {what} must be a string or a list of strings")
    if not argv:
        raise QueueError(f"{where}: {what} is empty")
    return argv


def parse_job(d, where="job"):
    if not isinstance(d, dict):
        raise QueueError(f"{where}: not a JSON object")
    extra = set(d) - KNOWN
    if extra:
        raise QueueError(f"{where}: unknown field(s) {', '.join(sorted(extra))}")
    jid = d.get("id")
    if not isinstance(jid, str) or not ID_RE.match(jid):
        raise QueueError(f"{where}: id must be 1-80 letters, digits, '.', '_' or '-'")
    if ("prompt" in d) == ("cmd" in d):
        raise QueueError(f"{where}: give exactly one of prompt or cmd")
    job = {"id": jid, "agents": d.get("agents", 1), "timeout": d.get("timeout", 3600),
           "cwd": d.get("cwd"), "verify": argv_of(d["verify"], "verify", where) if "verify" in d else None}
    if not isinstance(job["agents"], int) or job["agents"] < 1:
        raise QueueError(f"{where}: agents must be a whole number of at least 1")
    if not isinstance(job["timeout"], (int, float)) or job["timeout"] <= 0:
        raise QueueError(f"{where}: timeout must be a positive number of seconds")
    if "prompt" in d:
        if not isinstance(d["prompt"], str) or not d["prompt"].strip():
            raise QueueError(f"{where}: prompt must be a non-empty string")
        job["prompt"] = d["prompt"]
        for k in PROMPT_ONLY:
            if k in d:
                job[k] = d[k]
    else:
        stray = [k for k in PROMPT_ONLY if k in d]
        if stray:
            raise QueueError(f"{where}: {', '.join(stray)} only apply to prompt jobs")
        job["cmd"] = argv_of(d["cmd"], "cmd", where)
    return job


def load(path):
    p = Path(path).expanduser()
    if not p.exists():
        return []
    jobs, seen = [], set()
    for n, line in enumerate(p.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        where = f"{p.name} line {n}"
        try:
            d = json.loads(line)
        except ValueError as e:
            raise QueueError(f"{where}: not valid JSON ({e.msg})")
        job = parse_job(d, where)
        if job["id"] in seen:
            raise QueueError(f"{where}: id {job['id']} is used twice")
        seen.add(job["id"])
        jobs.append(job)
    return jobs


class FileQueue:
    def __init__(self, path, steer=None):
        self.path = Path(path).expanduser()
        self.steer = steer   # the objective and strategy from settings.json, carried by every job

    def pending(self, status):
        """Jobs not yet started (or put back after a usage-limit stop), in file order."""
        return [steermod.apply(j, self.steer) for j in load(self.path)
                if j["id"] not in status or status[j["id"]]["status"] == "queued"]


class SimQueue:
    """Endless simulated jobs for the simulation; each lasts a random 0.15 to 0.6 hours."""

    def __init__(self, seed=0, hours=(0.15, 0.6)):
        self.seed, self.hours, self.i = seed, hours, 0

    def make(self, n):
        rng = random.Random(f"{self.seed}:{n}")
        return {"id": f"sim-{n}", "prompt": "simulated job", "agents": 1, "timeout": 3600, "cwd": None,
                "verify": None, "sim_hours": rng.uniform(*self.hours)}

    def pending(self, status):
        while f"sim-{self.i}" in status and status[f"sim-{self.i}"]["status"] != "queued":
            self.i += 1
        return [self.make(n) for n in range(self.i, self.i + 16)
                if f"sim-{n}" not in status or status[f"sim-{n}"]["status"] == "queued"]
