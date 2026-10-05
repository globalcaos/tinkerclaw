#!/usr/bin/env python3
"""build-gantt: the machines a build runs on, for the Gantt tab's machines panel.

  machines.py PLAN.json
      Probe every machine in the plan's "machines" list at once and print one JSON object:
      {"show", "at", "machines": [{name, host, role, local, via, status, since, last_ok, error,
      rtt_ms, data, data_at, stale}]}. "show" is false when the build uses only this machine
      (no list, or only "host": "local"), and the panel stays hidden.

Each probe is machine_probe.py, piped to `python3 -` over ssh (or run here for "local"). ssh keeps
one shared connection per machine for two minutes (ControlMaster), so the tab's 15-s refresh does
not log in to a colleague's desktop four times a minute, and the round trip it reports is the link
itself. A machine that cannot be reached keeps the numbers of its last good probe, marked stale.
Link state (up/down since, last reached, recent round trips) lives in
~/.cache/gantt-machines/state.json, so a reload or a server restart keeps "down since".
GANTT_SSH replaces the ssh binary (tests use a fake one).
"""
import base64
import concurrent.futures
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "machine_probe.py")
TIMEOUT_S = 25


def state_dir():
    return os.path.expanduser(os.environ.get("GANTT_MACHINES_STATE") or "~/.cache/gantt-machines")


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def ssh_cmd(host, *rest):
    d = state_dir()
    return [os.environ.get("GANTT_SSH", "ssh"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
            "-o", "ControlMaster=auto", "-o", "ControlPath=" + os.path.join(d, "cm-%C"),
            "-o", "ControlPersist=120", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
            host, *rest]


def why(stderr, rc):
    """The line of ssh's complaint a person needs ("No route to host", "Permission denied")."""
    lines = [l.strip() for l in stderr.replace("\r", "").split("\n") if l.strip()]
    keys = ("No route", "timed out", "refused", "Permission denied", "Could not resolve", "Host key",
            "Connection closed", "unreachable", "not found")
    hit = next((l for l in lines if any(k in l for k in keys)), None)
    return (hit or (lines[-1] if lines else "exit %d" % rc))[:200]


def via_of(host):
    """The ssh jump host this machine is reached through, from ssh's own config (none = direct)."""
    if host == "local":
        return None
    try:
        out = subprocess.run([os.environ.get("GANTT_SSH", "ssh"), "-G", host], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, universal_newlines=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.split("\n"):
        k, _, v = line.partition(" ")
        if k == "proxyjump" and v.strip() and v.strip() != "none":
            return v.strip().split(",")[-1].split("@")[-1]
    return None


def probe(m):
    """(data or None, error or None, elapsed ms)."""
    spec = {k: m[k] for k in ("dirs", "jobs", "images", "du_max_age") if k in m}
    arg = base64.b64encode(json.dumps(spec).encode()).decode()
    local = m.get("host") == "local"
    argv = [sys.executable, PROBE, arg] if local else ssh_cmd(m["host"], "python3", "-", arg)
    t0 = time.time()
    # stderr goes to a file, not a pipe: ssh's ProxyJump helper outlives the call with the shared
    # connection and would hold a pipe open until ControlPersist ends.
    with tempfile.TemporaryFile("w+") as err, open(PROBE) as src:
        try:
            p = subprocess.run(argv, stdin=subprocess.DEVNULL if local else src, stdout=subprocess.PIPE,
                               stderr=err, universal_newlines=True, timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired:
            return None, "no answer in %d s" % TIMEOUT_S, (time.time() - t0) * 1000
        except OSError as e:
            return None, str(e)[:200], (time.time() - t0) * 1000
        ms = (time.time() - t0) * 1000
        err.seek(0)
        stderr = err.read()
    if p.returncode != 0:
        return None, why(stderr, p.returncode), ms
    try:
        return json.loads(p.stdout.strip().split("\n")[-1]), None, ms
    except (ValueError, IndexError):
        return None, "the probe printed no result: " + why(stderr or p.stdout, 0), ms


def load_state(path):
    try:
        s = json.load(open(path))
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(path, s):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".%d.tmp" % os.getpid()
    json.dump(s, open(tmp, "w"), ensure_ascii=False)
    os.replace(tmp, path)


def run(plan):
    specs = [m for m in plan.get("machines") or [] if isinstance(m, dict) and m.get("host")]
    out = {"show": any(m["host"] != "local" for m in specs), "at": now_iso(), "machines": []}
    if not out["show"]:
        return out
    os.makedirs(state_dir(), exist_ok=True)
    path = os.path.join(state_dir(), "state.json")
    state = load_state(path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(specs) * 2) as ex:
        probes = [ex.submit(probe, m) for m in specs]
        vias = [ex.submit(via_of, m["host"]) for m in specs]
        results = [(f.result(), v.result()) for f, v in zip(probes, vias)]
    by_host = {m["host"]: m.get("name") or m["host"] for m in specs}
    stamp = out["at"]
    for m, ((data, err, ms), via) in zip(specs, results):
        st = state.get(m["host"]) or {}
        status = "up" if data is not None else "down"
        if st.get("status") != status:
            st["status"], st["since"] = status, stamp
        if data is not None:
            st.update(last_ok=stamp, error=None, data=data, data_at=stamp)
            if m["host"] != "local":  # the link's round trip: the call minus the probe's own time
                st["rtt"] = (st.get("rtt") or [])[-19:] + [max(0, round(ms - (data.get("probe_ms") or 0)))]
        else:
            st["error"] = err
        state[m["host"]] = st
        out["machines"].append({
            "name": m.get("name") or m["host"], "host": m["host"], "role": m.get("role", ""),
            "local": m["host"] == "local", "via": by_host.get(via, via), "via_host": via,
            "status": status, "since": st.get("since"), "last_ok": st.get("last_ok"),
            "error": st.get("error"), "rtt_ms": (st.get("rtt") or [None])[-1] if data else None,
            "rtt_recent": st.get("rtt") or [], "ours_declared": bool(m.get("dirs")),
            "data": st.get("data"), "data_at": st.get("data_at"), "stale": data is None,
        })
    down = {r["host"] for r in out["machines"] if r["status"] == "down"}
    for r in out["machines"]:
        if r["status"] == "down" and r["via_host"] in down:
            r["error"] = "through %s, which is down too (%s)" % (r["via"], r["error"])
    save_state(path, state)
    return out


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    print(json.dumps(run(json.load(open(argv[1]))), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
