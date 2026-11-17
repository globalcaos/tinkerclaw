"""Running jobs. LiveRunner starts real work and refuses to exist unless live mode was allowed;
SimRunner pretends, for the simulation. Live calls never see an API key: prompt jobs get a clean
environment, and cmd jobs get yours minus the variables that would bill a pay-per-token account."""
import json
import os
import queue
import re
import shlex
import shutil
import subprocess
import threading
import time
from pathlib import Path

from . import config, steer as steermod

LIMIT_RE = re.compile(r"usage limit|hit your (?:usage )?limit|limit reached|quota exceeded|too many requests", re.I)
# Any of these would move the bill from the subscription to a metered account.
BILLING_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_BASE_URL")


class LiveRefused(Exception):
    pass


def live_allowed(flag, env=None):
    env = os.environ if env is None else env
    return bool(flag) and env.get("TOKEN_BURNER_ALLOW_LIVE") == "1"


def claude_path(s):
    return s.claude_bin or shutil.which("claude") or "claude"


def prompt_argv(job, s):
    argv = [claude_path(s), "-p", "--output-format", "json", "--no-session-persistence"]
    for flag, val in (("--model", job.get("model") or s.model), ("--effort", job.get("effort") or s.effort),
                      ("--permission-mode", job.get("permission_mode")), ("--append-system-prompt", job.get("system"))):
        if val:
            argv += [flag, val]
    for flag, key in (("--tools", "tools"), ("--allowedTools", "allowed_tools")):
        if key in job:
            v = job[key]
            argv.append(f"{flag}={','.join(v) if isinstance(v, list) else v}")
    return argv


def prompt_env(seat, s):
    bindir = str(Path(claude_path(s)).parent) if os.sep in claude_path(s) else "/usr/local/bin"
    env = {"HOME": str(config.HOME), "PATH": f"{bindir}:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    if not seat.is_default:
        env["CLAUDE_CONFIG_DIR"] = str(seat.path)
    return env


def cmd_env(seat, job, base=None):
    env = dict(os.environ if base is None else base)
    for k in BILLING_VARS + ("CLAUDE_CONFIG_DIR",):
        env.pop(k, None)
    if not seat.is_default:   # the default login lives in ~/.claude only when CLAUDE_CONFIG_DIR is unset
        env["CLAUDE_CONFIG_DIR"] = str(seat.path)
    env.update({"TOKEN_BURNER_SEAT": seat.id, "TOKEN_BURNER_SEAT_DIR": str(seat.path), "TOKEN_BURNER_JOB": job["id"]})
    env.update(steermod.env_of(job.get("steer")))
    return env


def job_cwd(job, work_root):
    d = Path(job["cwd"]).expanduser() if job.get("cwd") else Path(work_root) / job["id"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def execute(job, seat, s, out_dir, work_root):
    """Run one job and its verifier, synchronously. Returns {ok, verified, error, output, limit}."""
    cwd = job_cwd(job, work_root)
    out = Path(out_dir) / f"{job['id']}.out"
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        if "prompt" in job:
            r = subprocess.run(prompt_argv(job, s), input=job["prompt"], env=prompt_env(seat, s), cwd=cwd,
                               capture_output=True, text=True, timeout=job["timeout"])
            try:
                o = json.loads(r.stdout)
            except ValueError:
                o = {}
            text = (o.get("result") if isinstance(o, dict) else None) or r.stdout
            ok = r.returncode == 0 and isinstance(o, dict) and not o.get("is_error") and bool(text.strip())
        else:
            r = subprocess.run(job["cmd"], env=cmd_env(seat, job), cwd=cwd, capture_output=True, text=True,
                               timeout=job["timeout"])
            text, ok = r.stdout, r.returncode == 0
        err = None if ok else f"exit {r.returncode}: {text[-300:].strip()} {r.stderr[-300:].strip()}".strip()
    except subprocess.TimeoutExpired:
        text, ok, err = "", False, f"timeout after {job['timeout']} s"
    except OSError as e:
        text, ok, err = "", False, f"could not start: {e}"
    out.write_text(text)
    verified = None
    if ok and job.get("verify"):
        env = cmd_env(seat, job)
        env["TOKEN_BURNER_OUTPUT"] = str(out)
        try:
            v = subprocess.run(job["verify"], env=env, cwd=cwd, capture_output=True, text=True, timeout=600)
            verified = v.returncode == 0
            if not verified:
                err = f"verifier exit {v.returncode}: {(v.stderr or v.stdout)[-300:]}".strip()
        except (subprocess.TimeoutExpired, OSError) as e:
            verified, err = False, f"verifier did not run: {e}"
    return {"ok": ok, "verified": verified, "error": err, "output": str(out), "limit": bool(err and LIMIT_RE.search(err))}


class LiveRunner:
    sim = False

    def __init__(self, settings, out_dir, work_root, allow_live=False):
        if not allow_live:
            raise LiveRefused("live mode is off: pass --live and set TOKEN_BURNER_ALLOW_LIVE=1")
        self.s, self.out_dir, self.work_root = settings, out_dir, work_root
        self.done = queue.Queue()

    def start(self, job, seat, now, run_id):
        def work():
            try:
                res = execute(job, seat, self.s, self.out_dir, self.work_root)
            except Exception as e:  # noqa: BLE001 - a crashed job is a failed job, never a dead loop
                res = {"ok": False, "verified": None, "error": f"{type(e).__name__}: {e}", "output": None, "limit": False}
            self.done.put((run_id, job, res, time.time()))
        threading.Thread(target=work, daemon=True).start()

    def poll(self, now):
        out = []
        while not self.done.empty():
            out.append(self.done.get())
        return out


class SimRunner:
    """Each job 'runs' for its sim_hours and succeeds. No process, no network."""
    sim = True

    def __init__(self):
        self.pending = []

    def start(self, job, seat, now, run_id):
        end = now + job.get("sim_hours", 0.25) * 3600
        self.pending.append((end, run_id, job))

    def poll(self, now):
        due = sorted((p for p in self.pending if p[0] <= now), key=lambda p: p[0])
        self.pending = [p for p in self.pending if p[0] > now]
        return [(rid, job, {"ok": True, "verified": None, "error": None, "output": None, "limit": False}, end)
                for end, rid, job in due]


def admission(cmd, job, seat, width, timeout=30):
    """Your optional admission hook. Exit 0 admits the job; anything else, or no answer, holds it."""
    if not cmd:
        return True, None
    argv = cmd if isinstance(cmd, list) else shlex.split(cmd)
    env = dict(os.environ, TOKEN_BURNER_SEAT=seat.id, TOKEN_BURNER_JOB=job["id"], TOKEN_BURNER_WIDTH=str(width),
               TOKEN_BURNER_AGENTS=str(job["agents"]))
    try:
        r = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"admission hook did not answer: {e}"
    return (True, None) if r.returncode == 0 else (False, f"admission hook held {job['id']} (exit {r.returncode})")
