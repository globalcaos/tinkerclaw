#!/usr/bin/env python3
"""One look at a machine for the Gantt tab's machines panel: the whole machine, and what we use on it.

Runs ON the machine, piped in by machines.py (`ssh HOST python3 - SPEC_B64`, or locally), so it must
stay Python 3.6-safe (the Advantech has 3.6.9) and use nothing outside the standard library. SPEC is
base64 JSON: {"dirs": [...], "jobs": {"label", "name_label"}, "images": [...], "du_max_age": s}.

"Ours" is approximate and says so: a process is ours when its working folder is inside one of
`dirs` (a runner container works in its slot under ~/sv2-runner, the worker's suite in the repo).
CPU is sampled over half a second, memory is PSS where the kernel has smaps_rollup (else RSS),
GPU memory is per process from nvidia-smi. Our disk is `du -sk` of `dirs`, which can take 20 s on
a 13 GB runner folder, so it runs detached and is cached on the machine (~/.cache/gantt-probe):
a probe returns the last measurement and starts a new one when it is older than du_max_age.
Prints one JSON object.
"""
import base64
import glob
import hashlib
import json
import os
import socket
import subprocess
import sys
import time

T0 = time.time()
PAGE = os.sysconf("SC_PAGE_SIZE")


def sh(argv, timeout=6):
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           universal_newlines=True, timeout=timeout)
        return p.stdout if p.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def cpu_ticks():
    """(busy, total) jiffies over all CPUs, from the first line of /proc/stat."""
    v = [int(x) for x in read("/proc/stat").split("\n", 1)[0].split()[1:9]]
    idle = v[3] + v[4]
    return sum(v) - idle, sum(v)


def our_pids(dirs):
    me = os.getpid()
    out = []
    for p in glob.glob("/proc/[0-9]*"):
        pid = int(p[6:])
        if pid == me:
            continue
        try:
            cwd = os.readlink(p + "/cwd")
        except OSError:
            continue
        if any(cwd == d or cwd.startswith(d + "/") for d in dirs):
            out.append(pid)
    return out


def pid_ticks(pid):
    s = read("/proc/%d/stat" % pid)
    if not s:
        return 0
    f = s.rsplit(")", 1)[1].split()
    return int(f[11]) + int(f[12])  # utime + stime


def pid_mem(pid):
    r = read("/proc/%d/smaps_rollup" % pid)
    if r:
        for line in r.split("\n"):
            if line.startswith("Pss:"):
                return int(line.split()[1]) * 1024
    m = read("/proc/%d/statm" % pid)
    return int(m.split()[1]) * PAGE if m else 0


def meminfo():
    m = {}
    for line in (read("/proc/meminfo") or "").split("\n"):
        k, _, v = line.partition(":")
        if v.strip():
            m[k] = int(v.split()[0]) * 1024
    return m


def jetson_gpu():
    """A Jetson's GPU from sysfs: load in per mille, temperature from the gpu thermal zone. JetPack 6
    ships an nvidia-smi that answers [N/A] for both, so this is read first (Orin NX on 2026-10-05)."""
    paths = (glob.glob("/sys/devices/gpu.0/load") + glob.glob("/sys/devices/platform/gpu.0/load")
             + glob.glob("/sys/devices/platform/*/17000000.*/load") + glob.glob("/sys/devices/platform/17000000.*/load"))
    for p in paths:
        v = read(p)
        if v and v.strip().isdigit():
            temp = None
            for z in glob.glob("/sys/class/thermal/thermal_zone*"):
                if "gpu" in (read(z + "/type") or "").lower():
                    t = read(z + "/temp")
                    if t and t.strip().lstrip("-").isdigit():
                        temp = int(t) / 1000.0
                        break
            return {"name": "Jetson GPU (shares RAM)", "util": int(v) / 10.0, "mem_used": None,
                    "mem_total": None, "temp": temp, "ours_mem": None}
    return None


def gpus(ours):
    out = []
    j = jetson_gpu()
    if j:
        return [j]
    q = sh(["nvidia-smi", "--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits"])
    if q:
        apps = {}
        if ours:  # each nvidia-smi call costs up to a second on a laptop GPU waking up
            for line in (sh(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,used_memory",
                             "--format=csv,noheader,nounits"]) or "").strip().split("\n"):
                f = [x.strip() for x in line.split(",")]
                if len(f) == 3 and f[1].isdigit() and int(f[1]) in ours:
                    apps[f[0]] = apps.get(f[0], 0) + (int(f[2]) if f[2].isdigit() else 0)
        num = lambda x: float(x) if x.replace(".", "", 1).isdigit() else None
        for line in q.strip().split("\n"):
            f = [x.strip() for x in line.split(",")]
            out.append({"name": f[1], "util": num(f[2]), "mem_used": (num(f[3]) or 0) * 2 ** 20,
                        "mem_total": (num(f[4]) or 0) * 2 ** 20, "temp": num(f[5]),
                        "ours_mem": apps.get(f[0], 0) * 2 ** 20})
        return out
    return out


def gpu_util_ours(ours, proc):
    """Our share of GPU compute from `nvidia-smi pmon` (one sample, about a second)."""
    if proc is None:
        return None
    try:
        out, _ = proc.communicate(timeout=4)
    except subprocess.SubprocessError:
        proc.kill()
        return None
    total, seen = 0.0, False
    for line in out.split("\n"):
        f = line.split()
        if len(f) > 3 and not line.lstrip().startswith("#"):
            seen = True
            if f[1].isdigit() and int(f[1]) in ours and f[3].replace(".", "", 1).isdigit():
                total += float(f[3])
    return total if seen else None


def cpu_temp():
    best = None
    for h in glob.glob("/sys/class/hwmon/hwmon*"):
        if (read(h + "/name") or "").strip() in ("coretemp", "k10temp", "zenpower", "cpu_thermal"):
            for t in glob.glob(h + "/temp*_input"):
                v = read(t)
                if v and v.strip().lstrip("-").isdigit():
                    best = max(best or -1e9, int(v) / 1000.0)
    if best is None:
        for z in glob.glob("/sys/class/thermal/thermal_zone*"):
            if any(k in (read(z + "/type") or "").lower() for k in ("x86_pkg", "cpu")):
                v = read(z + "/temp")
                if v and v.strip().lstrip("-").isdigit():
                    best = max(best or -1e9, int(v) / 1000.0)
    return best


def du_ours(dirs, max_age):
    """Last `du -sk` of dirs (bytes, measured-at) and a detached refresh when it is stale."""
    if not dirs:
        return None, None, False
    cache = os.path.expanduser("~/.cache/gantt-probe")
    try:
        os.makedirs(cache, exist_ok=True)
    except OSError:
        return None, None, False
    key = hashlib.sha1("\0".join(dirs).encode()).hexdigest()[:12]
    tsv, lock = os.path.join(cache, "du-%s.tsv" % key), os.path.join(cache, "du-%s.run" % key)
    total, at = None, None
    try:
        rows = [l.split("\t") for l in open(tsv).read().strip().split("\n") if "\t" in l]
        total, at = sum(int(r[0]) for r in rows) * 1024, os.path.getmtime(tsv)
    except (OSError, ValueError):
        pass
    running = os.path.exists(lock) and time.time() - os.path.getmtime(lock) < 1800
    if (at is None or time.time() - at > max_age) and not running:
        open(lock, "w").close()
        q = lambda s: "'" + s.replace("'", "'\\''") + "'"
        script = ("nice -n 19 du -sk %s 2>/dev/null > %s.tmp; mv -f %s.tmp %s; rm -f %s"
                  % (" ".join(q(d) for d in dirs if os.path.exists(d)) or "/dev/null",
                     q(tsv), q(tsv), q(tsv), q(lock)))
        subprocess.Popen(["sh", "-c", script], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        running = True
    return total, at, running


def jobs(spec):
    if not spec or not spec.get("label"):
        return None
    lab = spec.get("name_label") or ""
    fmt = "{{.Names}}\t{{.RunningFor}}\t" + ('{{.Label "%s"}}' % lab if lab else "")
    out = sh(["docker", "ps", "--filter", "label=" + spec["label"], "--format", fmt])
    if out is None:
        return None
    rows = []
    for line in out.strip().split("\n"):
        f = line.split("\t")
        if f[0]:
            rows.append({"name": (len(f) > 2 and f[2]) or f[0], "for": f[1] if len(f) > 1 else ""})
    return rows


def image_bytes(refs):
    if not refs:
        return None
    ids = set()
    for r in refs:
        ids.update((sh(["docker", "image", "ls", "-q", "--filter", "reference=" + r]) or "").split())
    if not ids:
        return 0 if sh(["docker", "version", "-f", "{{.Server.Version}}"]) else None
    out = sh(["docker", "image", "inspect", "-f", "{{.Size}}"] + sorted(ids))
    return sum(int(x) for x in out.split() if x.isdigit()) if out else None


def main():
    spec = json.loads(base64.b64decode(sys.argv[1]).decode()) if len(sys.argv) > 1 else {}
    dirs = [os.path.realpath(os.path.expanduser(d)) for d in spec.get("dirs") or []]
    ours = set(our_pids(dirs)) if dirs else set()
    pmon = None
    if ours and os.path.exists("/usr/bin/nvidia-smi") and not jetson_gpu():
        try:
            pmon = subprocess.Popen(["nvidia-smi", "pmon", "-c", "1", "-s", "u"], stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, universal_newlines=True)
        except OSError:
            pmon = None
    b0, t0 = cpu_ticks()
    o0 = {p: pid_ticks(p) for p in ours}
    time.sleep(0.5)
    b1, t1 = cpu_ticks()
    o1 = sum(max(0, pid_ticks(p) - o0[p]) for p in ours if os.path.exists("/proc/%d" % p))
    dt_ = max(1, t1 - t0)
    m = meminfo()
    g = gpus(ours)
    gu = gpu_util_ours(ours, pmon)
    if g and (gu is not None or not ours):
        g[0]["ours_util"] = gu if ours else 0.0
    home = dirs[0] if dirs and os.path.exists(dirs[0]) else os.path.expanduser("~")
    st = os.statvfs(home)
    du_b, du_at, du_running = du_ours(dirs, float(spec.get("du_max_age", 600)))
    load = [float(x) for x in read("/proc/loadavg").split()[:3]]
    up = float(read("/proc/uptime").split()[0])
    print(json.dumps({
        "hostname": socket.gethostname(),
        "cores": os.cpu_count(),
        "uptime_s": up,
        "load": load,
        "cpu": {"pct": 100.0 * (b1 - b0) / dt_, "ours_pct": 100.0 * o1 / dt_, "temp": cpu_temp()},
        "mem": {"total": m.get("MemTotal"), "available": m.get("MemAvailable", m.get("MemFree")),
                "ours": sum(pid_mem(p) for p in ours), "swap_total": m.get("SwapTotal"),
                "swap_used": (m.get("SwapTotal") or 0) - (m.get("SwapFree") or 0)},
        "gpus": g,
        "disk": {"path": home, "total": st.f_blocks * st.f_frsize, "free": st.f_bavail * st.f_frsize,
                 "used": (st.f_blocks - st.f_bfree) * st.f_frsize, "ours": du_b, "ours_at": du_at,
                 "measuring": du_running, "image": image_bytes(spec.get("images"))},
        "procs": len(ours),
        "jobs": jobs(spec.get("jobs")),
        "probe_ms": round((time.time() - T0) * 1000),
    }))


if __name__ == "__main__":
    main()
