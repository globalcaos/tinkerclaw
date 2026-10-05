#!/usr/bin/env python3
"""freeze-thaw — freeze every live agent turn, power the laptop off, resume it all on the next boot.

Why it exists (measured 2026-09-25): some owners power the laptop off for every commute,
twice a day. The gateway already resumes interrupted main chats at boot, but:
  1. it fires ~5 s after the gateway starts — and at one measured morning boot (2026-09-24),
     LLM calls failed with "network connection error" for at least ~100 s after
     NetworkManager had reported CONNECTED_GLOBAL;
  2. it never reopens terminal Claude Code sessions or Chrome;
  3. /tmp is wiped at boot (`D /tmp` in tmpfiles.d), taking finished subagent reports with it.

Subcommands:
  snapshot      print what is live right now (read-only)
  freeze        snapshot, stop the gateway and its workers, power off (detaches itself first)
  thaw          after login: wait for the network and the gateway, check every frozen chat
                was resumed (resume the ones that were not), reopen terminals and Chrome
  wait-online   gateway ExecStartPre: after a freeze or a fresh boot, hold the gateway
                until the model API answers, so its own boot-time resume does not run offline
  status        show the pending freeze and the effective configuration
  discard       drop the pending freeze (the next boot starts clean)
  install       autostart entry, app-grid + desktop launcher, gateway drop-in
  uninstall     remove all three

Configuration: every host-specific default below can be overridden by an environment
variable of the same name, or by a KEY=VALUE line in the config file
($FREEZE_THAW_CONFIG, default ~/.config/freeze-thaw/config.env). The file matters because
the autostart entry and the gateway's ExecStartPre do not see your shell's environment.
A variable set in the environment wins over the file.
"""

import argparse
import datetime as dt
import fcntl
import glob
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")


# ── configuration ─────────────────────────────────────────────────────────────

def _load_config_file():
    """KEY=VALUE lines, '#' comments, optional quotes. The environment wins over the file."""
    path = os.environ.get("FREEZE_THAW_CONFIG") or os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "freeze-thaw", "config.env")
    try:
        with open(path) as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, os.path.expandvars(os.path.expanduser(value)))
    return path


CONFIG_FILE = _load_config_file()


def env(name, default):
    value = os.environ.get(name, "").strip()
    return value or default


def _default_health_url():
    port = env("OPENCLAW_GATEWAY_PORT", "18789")
    return f"http://{port if ':' in port else '127.0.0.1:' + port}/healthz"


# Where OpenClaw/TinkerClaw and Claude Code keep their state.
OPENCLAW_DIR = env("OPENCLAW_STATE_DIR", os.path.join(HOME, ".openclaw"))
CLAUDE_DIR = env("CLAUDE_CONFIG_DIR", os.path.join(HOME, ".claude"))
# Outside the OpenClaw state dir on purpose: many hosts keep that tree in git with a remote,
# and a manifest carries subagent reports and session keys. The Tinker ⏸/▶ buttons read $XDG_STATE_HOME/freeze-thaw, so only point
# FREEZE_THAW_STATE elsewhere for a test run.
STATE = env("FREEZE_THAW_STATE", os.path.join(env("XDG_STATE_HOME", os.path.join(HOME, ".local/state")),
                                              "freeze-thaw"))
PENDING = os.path.join(STATE, "pending.json")
HISTORY = os.path.join(STATE, "history")
LOG = os.path.join(STATE, "freeze-thaw.log")
SCRIPT = os.path.abspath(__file__)
STORE_GLOB = os.path.join(OPENCLAW_DIR, "agents/*/sessions/sessions.json")
CC_SESSIONS = os.path.join(CLAUDE_DIR, "sessions")
CC_PROJECTS = os.path.join(CLAUDE_DIR, "projects")
GATEWAY_UNIT = env("FREEZE_THAW_GATEWAY_UNIT", "openclaw-gateway.service")
WORKER_UNITS = env("FREEZE_THAW_WORKER_UNITS", "tinkerclaw-worker-*")
WORKER_PREFIX = WORKER_UNITS.split("*", 1)[0]
GATEWAY_CLI = env("FREEZE_THAW_CLI", "openclaw")
HEALTH_URL = env("FREEZE_THAW_HEALTH_URL", _default_health_url())
PROBE_URL = env("FREEZE_THAW_PROBE_URL", "https://api.anthropic.com/")
OWNER = env("FREEZE_THAW_OWNER", "The user")  # who froze the laptop, as the resumed chat reads it
ICON = env("FREEZE_THAW_ICON", "weather-snow")
TERMINAL = env("FREEZE_THAW_TERMINAL", "gnome-terminal")  # must take gnome-terminal's flags
SHELL = env("FREEZE_THAW_SHELL", "bash")  # interactive shell the reopened `claude --resume` runs in
BROWSER_COMM = env("FREEZE_THAW_BROWSER_COMM", "chrome")
BROWSER_WRAPPER = env("FREEZE_THAW_BROWSER_WRAPPER", "google-chrome")
REPORT_GLOB = env("FREEZE_THAW_REPORT_GLOB", "/tmp/*.report.md")
DESKTOP_FILE = env("FREEZE_THAW_DESKTOP_FILE", "freeze-and-power-off.desktop")
SHELLS = {"bash", "zsh", "fish", "sh", "dash"}
GUARD_SECONDS = int(env("FREEZE_THAW_GUARD_SECONDS", "600"))  # no unattended freeze this soon after a boot or a thaw

AUTOSTART = os.path.join(HOME, ".config/autostart/freeze-thaw.desktop")
LAUNCHER = os.path.join(HOME, ".local/share/applications/freeze-thaw.desktop")
DROPIN = os.path.join(HOME, ".config/systemd/user", GATEWAY_UNIT + ".d", "zz-freeze-thaw-wait-online.conf")


# ── small helpers ─────────────────────────────────────────────────────────────

def now_ms():
    return int(time.time() * 1000)


def hhmm(ms):
    return dt.datetime.fromtimestamp(ms / 1000).strftime("%H:%M")


def minutes(seconds):
    return f"{round(seconds / 60)} minutes" if seconds >= 120 else f"{int(seconds)} s"


def log(msg):
    line = f"{dt.datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(STATE, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def notify(title, body):
    try:
        subprocess.run(["notify-send", "-a", "Freeze", "-i", ICON, title, body], timeout=5,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def load_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def uptime_s():
    with open("/proc/uptime") as f:
        return float(f.read().split()[0])


def proc_read(pid, name):
    try:
        with open(f"/proc/{pid}/{name}", "rb") as f:
            return f.read()
    except OSError:
        return b""


def proc_comm(pid):
    return proc_read(pid, "comm").decode(errors="replace").strip()


def proc_argv(pid):
    return [a.decode(errors="replace") for a in proc_read(pid, "cmdline").split(b"\0") if a]


def proc_ppid_tty(pid):
    stat = proc_read(pid, "stat").decode(errors="replace")
    fields = stat[stat.rfind(")") + 2:].split()  # comm may contain spaces
    return (int(fields[1]), int(fields[4])) if len(fields) > 4 else (0, 0)


def all_pids():
    return [int(p) for p in os.listdir("/proc") if p.isdigit()]


def systemctl(*args, timeout=150):
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=timeout)


# ── what is live ──────────────────────────────────────────────────────────────

def session_kind(key, entry):
    rest = key.split(":", 2)[2] if key.startswith("agent:") and key.count(":") >= 2 else key
    if entry.get("spawnDepth") or entry.get("subagentRole") or rest.startswith("subagent:"):
        return "subagent"
    if rest.startswith("cron:"):
        return "cron"
    if rest.startswith("acp:"):
        return "acp"
    return "main"


def load_stores():
    stores = {}
    for path in glob.glob(STORE_GLOB):
        data = load_json(path)
        if isinstance(data, dict):
            stores[path] = data
        else:
            log(f"cannot read session store {path}")
    return stores


def running_gateway_sessions():
    out = []
    for path, store in load_stores().items():
        for key, entry in store.items():
            if isinstance(entry, dict) and entry.get("status") == "running":
                out.append({
                    "key": key,
                    "store": path,
                    "kind": session_kind(key, entry),
                    "sessionId": entry.get("sessionId"),
                    "startedAt": entry.get("startedAt"),
                    "provider": entry.get("providerOverride"),
                    "model": entry.get("modelOverride"),
                })
    return out


def store_entry(path, key):
    store = load_json(path) or {}
    entry = store.get(key)
    return entry if isinstance(entry, dict) else {}


def claude_terminal_sessions():
    """Claude Code sessions a human is driving in a terminal.

    <claude dir>/sessions/<pid>.json maps a live process to its session id, cwd and
    idle/busy status. entrypoint "sdk-cli" is a gateway worker (the gateway resumes
    those); no controlling tty means a headless `claude -p` job, not a terminal.
    """
    out = []
    for f in glob.glob(os.path.join(CC_SESSIONS, "*.json")):
        d = load_json(f)
        if not isinstance(d, dict) or d.get("entrypoint") == "sdk-cli":
            continue
        pid, sid = d.get("pid"), d.get("sessionId")
        if not pid or not sid or not os.path.exists(f"/proc/{pid}"):
            continue
        if proc_ppid_tty(pid)[1] == 0:
            continue
        transcripts = glob.glob(os.path.join(CC_PROJECTS, "*", f"{sid}.jsonl"))
        if not transcripts or os.path.getsize(transcripts[0]) == 0:
            continue  # a pre-warmed spare that never got a conversation
        out.append({"pid": pid, "sessionId": sid, "cwd": d.get("cwd"), "status": d.get("status"),
                    "name": d.get("name")})
    return out


def chrome_launches():
    """argv of each top-level Chrome process. Chrome restores its own tabs on relaunch when
    session.restore_on_startup == 1 in the profile's Preferences (check each profile you use)."""
    launches = []
    for pid in all_pids():
        if proc_comm(pid) != BROWSER_COMM:
            continue
        ppid, _ = proc_ppid_tty(pid)
        if proc_comm(ppid) == BROWSER_COMM:
            continue
        argv = proc_argv(pid)
        if len(argv) == 1 and " " in argv[0]:
            argv = argv[0].split()  # Chrome rewrites its process title into one space-joined string
        if argv and argv not in launches:
            launches.append(argv)
    return launches


def terminal_shells():
    """Plain shell tabs in the terminal emulator (Claude tabs are covered by claude_terminal_sessions)."""
    server_prefix = os.path.basename(TERMINAL)[:15]  # /proc/<pid>/comm is cut at 15 chars
    servers = [p for p in all_pids() if proc_comm(p).startswith(server_prefix)]
    children = {}
    for pid in all_pids():
        ppid, _ = proc_ppid_tty(pid)
        children.setdefault(ppid, []).append(pid)
    out = []
    for server in servers:
        for sh in children.get(server, []):
            if proc_comm(sh) not in SHELLS:
                continue
            kids = children.get(sh, [])
            if any(proc_comm(k) == "claude" for k in kids):
                continue
            try:
                cwd = os.readlink(f"/proc/{sh}/cwd")
            except OSError:
                continue
            out.append({"cwd": cwd, "running": [" ".join(proc_argv(k))[:200] for k in kids]})
    return out


def transient_units():
    """Ad-hoc `systemd-run` jobs (downloads, headless agents). Enabled services come back
    by themselves at boot; these do not, and re-running an arbitrary command twice is not
    safe, so they are recorded and reported, never relaunched."""
    names = systemctl("list-units", "--type=service", "--state=running", "--no-legend", "--plain").stdout.split()
    skip = tuple(p for p in (WORKER_PREFIX, "freeze-thaw") if p)
    names = [n for n in names if n.endswith(".service") and not n.startswith(skip)]
    if not names:
        return []
    shown = systemctl("show", "-p", "Id,Transient,ExecStart", *names).stdout
    out = []
    for block in shown.strip().split("\n\n"):
        props = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        if props.get("Transient") == "yes":
            argv = props.get("ExecStart", "")
            start = argv.find("argv[]=")
            out.append({"unit": props.get("Id"), "command": argv[start + 7:argv.find(" ;", start)] if start >= 0 else argv})
    return out


def snapshot(origin=None, reason="snapshot"):
    ms = now_ms()
    return {
        "version": 1,
        "id": dt.datetime.fromtimestamp(ms / 1000).strftime("%Y%m%d-%H%M%S"),
        "reason": reason,
        "frozenAtMs": ms,
        "frozenAt": dt.datetime.fromtimestamp(ms / 1000).isoformat(timespec="seconds"),
        "bootId": proc_read("sys/kernel/random", "boot_id").decode().strip(),
        "origin": origin,
        "gatewaySessions": running_gateway_sessions(),
        "claudeTerminals": claude_terminal_sessions(),
        "chrome": chrome_launches(),
        "terminalShells": terminal_shells(),
        "transientUnits": transient_units(),
    }


def summarize(m):
    by = {}
    for s in m["gatewaySessions"]:
        if s["key"] != m.get("origin"):
            by[s["kind"]] = by.get(s["kind"], 0) + 1
    busy = sum(1 for t in m["claudeTerminals"] if t.get("status") == "busy")
    parts = [f"{by.get('main', 0)} chat(s) mid-thought"]
    if by.get("subagent"):
        parts.append(f"{by['subagent']} subagent(s)")
    if by.get("cron"):
        parts.append(f"{by['cron']} cron run(s)")
    parts.append(f"{len(m['claudeTerminals'])} terminal Claude session(s) ({busy} busy)")
    if m["terminalShells"]:
        parts.append(f"{len(m['terminalShells'])} shell tab(s)")
    parts.append("Chrome" if m["chrome"] else "no Chrome")
    if m["transientUnits"]:
        parts.append(f"{len(m['transientUnits'])} background job(s) that will NOT restart")
    return ", ".join(parts)


# ── network ───────────────────────────────────────────────────────────────────

def api_reachable():
    """A real TLS round trip to the model API. Any HTTP status counts; a captive portal
    fails certificate verification and correctly reads as offline."""
    try:
        urllib.request.urlopen(urllib.request.Request(PROBE_URL, method="HEAD"), timeout=5)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def wait_online(timeout):
    start = time.time()
    while True:
        if api_reachable():
            return time.time() - start
        if time.time() - start >= timeout:
            return None
        time.sleep(3)


def gateway_healthy():
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def gateway_age_s():
    out = systemctl("show", "-p", "ActiveEnterTimestampMonotonic", "--value", GATEWAY_UNIT).stdout.strip()
    try:
        return uptime_s() - int(out) / 1e6 if int(out) else None
    except ValueError:
        return None


# ── freeze ────────────────────────────────────────────────────────────────────

def guard_reason():
    """Why an unattended freeze must not run now. A chat resumed after a thaw may still
    hold the instruction that froze the laptop; it must never power it off again."""
    if os.path.exists(PENDING):
        return "a previous freeze has not been thawed yet"
    if uptime_s() < GUARD_SECONDS:
        return f"the laptop booted {int(uptime_s())} s ago"
    newest = max(glob.glob(os.path.join(HISTORY, "*.json")), key=os.path.getmtime, default=None)
    if newest and time.time() - os.path.getmtime(newest) < GUARD_SECONDS:
        return f"a thaw finished less than {minutes(GUARD_SECONDS)} ago"
    return None


def ask(then, m):
    if not shutil.which("zenity"):
        log("freeze --ask needs zenity for its dialog; install it, or run freeze without --ask")
        notify("Freeze", "zenity is not installed, so the confirm dialog cannot open. Nothing was frozen.")
        return None
    ok = "Restart" if then == "reboot" else "Power off"
    other = "Power off instead" if then == "reboot" else "Restart instead"
    text = (f"Freeze everything and {ok.lower()}?\n\n{summarize(m)}.\n\n"
            "Everything picks up again after you log in.")
    r = subprocess.run(["zenity", "--question", "--title=Freeze", f"--text={text}", f"--ok-label={ok}",
                        "--cancel-label=Cancel", f"--extra-button={other}", f"--icon-name={ICON}"],
                       capture_output=True, text=True)
    if r.returncode == 0:
        return then
    if r.stdout.strip() == other:
        return "poweroff" if then == "reboot" else "reboot"
    return None


def wait_session_settled(key, timeout):
    """The chat that asked for the freeze should finish its reply before the gateway stops,
    or the next boot would resume it — and it would read its own freeze instruction again."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        running = any(s["key"] == key for s in running_gateway_sessions())
        if not running:
            return True
        time.sleep(2)
    return False


def backup_reports(m):
    """Copy recent finished subagent reports out of /tmp, which is wiped at boot."""
    backup = os.path.join(STATE, m["id"], "tmp")
    m["tmpReports"] = []
    for f in glob.glob(REPORT_GLOB):
        if time.time() - os.path.getmtime(f) < 3 * 86400:
            os.makedirs(backup, exist_ok=True)
            shutil.copy2(f, backup)
            m["tmpReports"].append(os.path.abspath(f))


def restore_reports(m, dry_run):
    backup = os.path.join(STATE, m["id"], "tmp")
    for entry in m.get("tmpReports", []):
        # Older manifests stored bare names that all lived in /tmp.
        dst = entry if os.path.isabs(entry) else os.path.join("/tmp", entry)
        src = os.path.join(backup, os.path.basename(dst))
        if os.path.exists(src) and not os.path.exists(dst) and not dry_run:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)


def cmd_freeze(a):
    origin = a.origin if a.origin is not None else os.environ.get("TC_SESSION_KEY") or None
    if a.ask:
        m = snapshot(origin)
        then = ask(a.then, m)
        if not then:
            log("freeze cancelled at the dialog")
            return 0
        a.then, a.force = then, True
    if not a.force and not a.dry_run:
        reason = guard_reason()
        if reason:
            log(f"refusing to freeze: {reason}. A human can override with --force.")
            return 3

    if a.dry_run:
        m = snapshot(origin, reason="dry-run")
        print(json.dumps(m, indent=1))
        log(f"dry run: would freeze {summarize(m)}; then stop {GATEWAY_UNIT} and {WORKER_UNITS}, then {a.then}")
        return 0

    if not a.foreground:
        # Stopping the gateway kills everything in its cgroup, including an agent turn that
        # called this script. Hand the work to an independent transient unit and return.
        unit = f"freeze-thaw-{int(time.time())}"
        cmd = ["systemd-run", "--user", f"--unit={unit}", "--collect", "--quiet", "--",
               sys.executable, SCRIPT, "freeze", "--foreground", "--force", f"--then={a.then}",
               f"--origin={origin or ''}", f"--origin-timeout={a.origin_timeout}"]
        subprocess.run(cmd, check=True)
        waiting = " once this chat's turn ends" if origin else ""
        log(f"freeze handed to unit {unit}: stops the gateway{waiting}, then {a.then}")
        print(f"Freeze scheduled (unit {unit}). End this turn now; the laptop will {a.then}{waiting}.")
        return 0

    origin = origin or None
    notify("Freezing", "Waiting for the requesting chat to finish its reply…" if origin else "Saving what is live…")
    if origin and not wait_session_settled(origin, a.origin_timeout):
        log(f"requesting chat {origin} still running after {a.origin_timeout} s; freezing anyway")

    m = snapshot(origin, reason="freeze")
    m["then"] = a.then
    m["summary"] = summarize(m)  # the ⏸/▶ hover in Tinker's SESSIONS header reads this
    backup_reports(m)
    old = load_json(PENDING)
    if old:  # an earlier freeze never thawed (only reachable with --ask/--force): keep its record
        old["superseded"] = m["id"]
        write_json_atomic(os.path.join(HISTORY, old["id"] + ".json"), old)
    # Written BEFORE anything stops: if the stop hangs or the battery dies, the thaw still
    # knows what was live.
    write_json_atomic(PENDING, m)
    log(f"frozen {m['id']}: {summarize(m)}")

    r = systemctl("stop", GATEWAY_UNIT, timeout=150)
    log(f"stopped {GATEWAY_UNIT} (rc={r.returncode})")
    # The gateway leaves an interrupted chat as status=running on disk and resumes it at
    # boot. Record what the stop actually left, so the thaw can tell a chat the gateway
    # settled during shutdown from one it will resume by itself.
    m["statusAfterStop"] = {s["key"]: store_entry(s["store"], s["key"]).get("status")
                            for s in m["gatewaySessions"]}
    write_json_atomic(PENDING, m)
    # Workers are separate systemd-run units and outlive a gateway stop. Stop them after
    # the gateway, so the gateway never sees them die and settles their runs as finished.
    r = systemctl("stop", WORKER_UNITS, timeout=60)
    log(f"stopped {WORKER_UNITS} (rc={r.returncode})")
    subprocess.run(["sync"])

    if a.then == "none":
        # No power-off follows, so the terminal Claude sessions would keep thinking: pause them
        # for real. `thaw` sends SIGCONT; on a power-off systemd sends SIGCONT with SIGTERM.
        m["pausedPids"] = []
        for t in m["claudeTerminals"]:
            try:
                os.kill(t["pid"], signal.SIGSTOP)
                m["pausedPids"].append({"pid": t["pid"], "sessionId": t["sessionId"]})
            except OSError as e:
                log(f"could not pause terminal Claude {t['pid']}: {e}")
        write_json_atomic(PENDING, m)
        notify("Frozen", f"{summarize(m)}. The gateway stays stopped until `thaw`.")
        log("frozen; gateway left stopped. Run `freeze_thaw.py thaw` to resume without a reboot.")
        return 0
    notify("Frozen", f"{summarize(m)}. {'Restarting' if a.then == 'reboot' else 'Powering off'}…")
    time.sleep(2)
    subprocess.run(["systemctl", a.then])
    return 0


# ── thaw ──────────────────────────────────────────────────────────────────────

def recovery_journal(since_ms):
    r = subprocess.run(["journalctl", "--user", "-u", GATEWAY_UNIT, "--since", f"@{since_ms // 1000}",
                        "--no-pager", "-o", "cat"], capture_output=True, text=True, timeout=30)
    return [l for l in r.stdout.splitlines() if "[main-session-restart-recovery]" in l]


def gateway_verdict(key, journal):
    """What the gateway's own boot-time recovery decided for this chat, from its journal.
    The last decision wins: a resume that later ran offline is logged as `failed` after it."""
    verdict = None
    mentions = re.compile(re.escape(key) + r"(?=$|\s|\(|: )")
    for line in journal:
        if not mentions.search(line):
            continue
        if "resumed interrupted main session" in line or "dispatched resume to interrupted" in line:
            verdict = "resumed"
        elif "last turn already completed (idle)" in line:
            verdict = "idle"
        elif "marked interrupted main session failed" in line or "failed to resume" in line:
            verdict = "failed"
    return verdict


def thaw_message(m):
    # SCOPE comes first because of a measured failure (2026-09-25): this message, sent to a
    # scratch chat with no earlier turn, made the model go looking for "its" work on disk, adopt
    # the half-built freeze-thaw skill another chat was writing, overwrite its SKILL.md with
    # a false "verified end-to-end" line, and run `install`. "Resume your turn" without a
    # scope is an invitation to pick up anyone's work.
    return (
        f"[System] {OWNER} froze the laptop for travel at {hhmm(m['frozenAtMs'])} and it came back at "
        f"{hhmm(now_ms())}; that may have interrupted your previous turn in THIS chat.\n"
        "0. SCOPE — resume only a turn that THIS chat's transcript shows unfinished. If the transcript "
        "has no unfinished turn, reply in one line that there was nothing to resume and stop. Never "
        "adopt work you find on disk that this chat did not start.\n"
        "Otherwise resume it, and make the resume legible:\n"
        "1. ORIENT FIRST — one to three sentences on where you are picking up (plan step if you have one; "
        "otherwise what the transcript tail shows was in flight).\n"
        "2. RECOVER CONTEXT — read half-written artifacts and run `git status`; continue from what is on disk, "
        "not from memory. Subagents you spawned did not survive the power-off: their finished reports were "
        "restored to /tmp, re-dispatch only the ones that are missing.\n"
        "3. CHECK BEFORE REDOING — if everything the turn owed is already on disk, say so in one line and stop. "
        "Never re-run a deploy, a send, a delete or a freeze on the strength of this message.\n"
        "4. CONTINUE as if nothing happened."
    )


def dispatch_resume(m, s):
    # No provider/model: a CLI caller is refused ("overrides are not authorized for this
    # caller", tested 2026-09-25), and the run applies the chat's stored modelOverride itself
    # (agent-command.ts `storedModelOverride` — read in the code, not yet seen live on a
    # pinned chat). The gateway's own recovery pins explicitly only because it dispatches while the
    # store may still be warming; the thaw runs at least 60 s after the gateway starts.
    params = {
        "sessionKey": s["key"],
        "message": thaw_message(m),
        # Stable per freeze and chat: a second thaw in the same gateway process is deduplicated.
        "idempotencyKey": f"freeze-thaw:{m['id']}:{s['key']}",
        "deliver": False,
        "lane": "main",
    }
    r = subprocess.run([GATEWAY_CLI, "gateway", "call", "agent", "--json", "--timeout", "15000",
                        "--params", json.dumps(params)], capture_output=True, text=True, timeout=60)
    # A missed ack is not a failed delivery: the gateway acks only once the turn is under
    # way (lesson from main-session-restart-recovery.ts, 2026-09-04).
    if r.returncode == 0 or "timeout" in (r.stderr + r.stdout).lower():
        return "resumed by thaw"
    return f"resume failed: {(r.stderr or r.stdout).strip()[-200:]}"


def live_claude_session_ids():
    ids = set()
    for f in glob.glob(os.path.join(CC_SESSIONS, "*.json")):
        d = load_json(f)
        if isinstance(d, dict) and d.get("pid") and os.path.exists(f"/proc/{d['pid']}"):
            ids.add(d.get("sessionId"))
    return ids


def claude_command(m, t):
    cmd = f"claude --resume {shlex.quote(t['sessionId'])}"
    if t.get("status") == "busy":
        cmd += " " + shlex.quote(
            f"The laptop was frozen for travel at {hhmm(m['frozenAtMs'])} while you were working, and "
            "powered back on now. Resume where you stopped: check what is already on disk (git status, the "
            "files you were writing) before redoing anything, then continue as if nothing happened.")
    # An interactive shell reads its rc file, which is usually what puts node and claude on
    # PATH; stay in a shell after.
    return [SHELL, "-ic", f"{cmd}; exec {shlex.quote(SHELL)}"]


def spawn(argv, dry_run):
    if dry_run:
        print("would run:", shlex.join(argv))
        return
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except OSError as e:  # e.g. FREEZE_THAW_TERMINAL is not installed: report it, finish the thaw
        log(f"could not start {argv[0]}: {e}")


def cmd_thaw(a):
    m = load_json(PENDING)
    if not m:
        log("thaw: nothing frozen")
        return 0
    os.makedirs(STATE, exist_ok=True)
    lock = open(os.path.join(STATE, "thaw.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("thaw: another thaw is running")
        return 0
    gui = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    report = {"thawStartedAt": dt.datetime.now().isoformat(timespec="seconds"), "sessions": {}, "gui": []}
    log(f"thaw {m['id']}: {summarize(m)}")

    restore_reports(m, a.dry_run)

    # Chrome first: the user sees their tabs while the rest waits for the network.
    if gui and m.get("chrome") and not any(proc_comm(p) == BROWSER_COMM for p in all_pids()):
        for argv in m["chrome"]:
            wrapper = os.path.join(os.path.dirname(argv[0]), BROWSER_WRAPPER)
            spawn([wrapper, *argv[1:]] if os.path.exists(wrapper) else argv, a.dry_run)
        report["gui"].append("Chrome relaunched (it restores its own tabs)")

    waited = wait_online(0 if a.dry_run else 5)
    if waited is None and not a.dry_run:
        notify("Thawing", "Waiting for the network before resuming the chats…")
        waited = wait_online(a.net_timeout)
    report["networkWaitS"] = None if waited is None else round(waited)
    log(f"network: {'reachable' if waited is not None else 'NOT reachable'}"
        + (f" after {round(waited)} s" if waited else ""))

    if systemctl("is-active", GATEWAY_UNIT).stdout.strip() != "active" and not a.dry_run:
        systemctl("start", GATEWAY_UNIT)  # the `freeze --then none` path left it stopped
        log(f"started {GATEWAY_UNIT}")
    deadline = time.time() + (0 if a.dry_run else 300)
    while not gateway_healthy() and time.time() < deadline:
        time.sleep(3)
    # Its own recovery fires 5 s after start and retries at +10 s and +20 s.
    age = gateway_age_s()
    if age is not None and age < 60 and not a.dry_run:
        time.sleep(60 - age)

    journal = recovery_journal(m["frozenAtMs"])
    for s in m["gatewaySessions"]:
        key = s["key"]
        if key == m.get("origin"):
            report["sessions"][key] = "the chat that asked for the freeze; not resumed"
            continue
        if s["kind"] != "main":
            report["sessions"][key] = {
                "subagent": "subagent: not resumed; its parent chat re-dispatches what is missing",
                "cron": "cron run: the scheduler runs it again on its next slot",
                "acp": "ACP session: not resumed",
            }[s["kind"]]
            continue
        verdict = gateway_verdict(key, journal)
        entry = store_entry(s["store"], key)
        if verdict == "resumed":
            outcome = "resumed by the gateway"
        elif verdict == "idle":
            outcome = "its turn had already finished; nothing to resume"
        elif verdict is None and entry.get("status") == "running" and not entry.get("abortedLastRun"):
            outcome = "already running again"
        elif a.dry_run:
            outcome = f"would resume (gateway verdict: {verdict or 'none'}, status now: {entry.get('status')})"
        else:
            outcome = dispatch_resume(m, s)
        report["sessions"][key] = outcome
        log(f"{key}: {outcome}")

    for p in m.get("pausedPids", []):
        # Only the same session: after a reboot the pid may belong to something else entirely.
        d = load_json(os.path.join(CC_SESSIONS, f"{p['pid']}.json")) or {}
        if d.get("sessionId") == p["sessionId"] and os.path.exists(f"/proc/{p['pid']}") and not a.dry_run:
            os.kill(p["pid"], signal.SIGCONT)
            report["gui"].append(f"terminal Claude {p['sessionId'][:8]} woken")

    if gui:
        live = live_claude_session_ids()
        for t in m.get("claudeTerminals", []):
            if t["sessionId"] in live:
                continue
            spawn([TERMINAL, "--window", f"--working-directory={t['cwd']}", "--",
                   *claude_command(m, t)], a.dry_run)
            report["gui"].append(f"terminal Claude {t['sessionId'][:8]} in {t['cwd']} ({t.get('status')})")
        shells = m.get("terminalShells", [])
        if shells:
            argv = [TERMINAL, "--window", f"--working-directory={shells[0]['cwd']}"]
            for sh in shells[1:]:
                argv += ["--tab", f"--working-directory={sh['cwd']}"]
            spawn(argv, a.dry_run)
            report["gui"].append(f"{len(shells)} shell tab(s) reopened")
    else:
        report["gui"].append("no display: terminals and Chrome not reopened")
    if m.get("transientUnits"):
        report["notRestarted"] = m["transientUnits"]

    resumed = sum(1 for v in report["sessions"].values() if "resumed" in v and "failed" not in v)
    failed = [k for k, v in report["sessions"].items() if "failed" in v]
    body = f"{resumed} chat(s) resumed; " + "; ".join(report["gui"] or ["nothing to reopen"])
    if failed:
        body += f". Could not resume: {', '.join(failed)}"
    if m.get("transientUnits"):
        body += f". Not restarted: {', '.join(u['unit'] for u in m['transientUnits'])}"
    if a.dry_run:
        print(json.dumps(report, indent=1))
        log("thaw dry run: pending freeze left in place")
        return 0
    report["summary"] = body
    report["finishedAt"] = dt.datetime.now().isoformat(timespec="seconds")
    m["thaw"] = report
    write_json_atomic(os.path.join(HISTORY, m["id"] + ".json"), m)
    os.remove(PENDING)
    notify("Thawed", body)
    log(f"thawed {m['id']}: {body}")
    return 1 if failed else 0


# ── gateway gate, status, install ─────────────────────────────────────────────

def cmd_wait_online(a):
    if not (a.always or os.path.exists(PENDING) or uptime_s() < GUARD_SECONDS):
        return 0
    waited = wait_online(a.timeout)
    if waited is None:
        print(f"freeze-thaw: model API still unreachable after {a.timeout} s; starting the gateway anyway", flush=True)
    else:
        print(f"freeze-thaw: model API reachable after {round(waited)} s", flush=True)
    return 0  # never block the gateway for good


def cmd_snapshot(a):
    m = snapshot(os.environ.get("TC_SESSION_KEY"))
    print(json.dumps(m, indent=1))
    print("\n" + summarize(m))
    return 0


def cmd_status(a):
    m = load_json(PENDING)
    if m:
        print(f"FROZEN since {m['frozenAt']} (then: {m.get('then')}): {summarize(m)}")
    else:
        print("nothing frozen")
    newest = max(glob.glob(os.path.join(HISTORY, "*.json")), key=os.path.getmtime, default=None)
    if newest:
        h = load_json(newest) or {}
        print(f"last thaw: {h.get('id')} → {json.dumps(h.get('thaw', {}).get('sessions', {}))}")
    for path in (AUTOSTART, LAUNCHER, DROPIN):
        print(f"{'installed' if os.path.exists(path) else 'MISSING  '} {path}")
    print(f"config file: {CONFIG_FILE or 'none'}")
    print(f"state {STATE} · gateway {GATEWAY_UNIT} ({HEALTH_URL}) · workers {WORKER_UNITS} · "
          f"probe {PROBE_URL} · cli {GATEWAY_CLI} · terminal {TERMINAL} ({SHELL}) · guard {GUARD_SECONDS} s")
    return 0


def cmd_discard(a):
    m = load_json(PENDING)
    if not m:
        print("nothing frozen")
        return 0
    m["discarded"] = dt.datetime.now().isoformat(timespec="seconds")
    write_json_atomic(os.path.join(HISTORY, m["id"] + ".json"), m)
    os.remove(PENDING)
    log(f"discarded {m['id']}; the gateway still resumes interrupted chats on its own")
    return 0


def desktop_entry(name, comment, exec_, extra=""):
    return (f"[Desktop Entry]\nType=Application\nName={name}\nComment={comment}\nExec={exec_}\n"
            f"Icon={ICON}\nTerminal=false\n{extra}")


def desktop_dir():
    try:
        return subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, text=True).stdout.strip()
    except OSError:
        return ""


def cmd_install(a):
    py = sys.executable
    files = {
        AUTOSTART: desktop_entry("Thaw after freeze", "Resume what was live before the last freeze",
                                 f"{py} {SCRIPT} thaw", "NoDisplay=true\nX-GNOME-Autostart-enabled=true\n"),
        LAUNCHER: desktop_entry(
            "Freeze & Power Off", "Freeze all agent thinking, power off, resume everything after login",
            f"{py} {SCRIPT} freeze --ask", "Categories=System;\nKeywords=freeze;travel;shutdown;suspend;thaw;\n"
            "Actions=restart;\n\n[Desktop Action restart]\nName=Freeze & Restart\n"
            f"Exec={py} {SCRIPT} freeze --ask --then=reboot\n"),
        DROPIN: ("# freeze-thaw: after a freeze or a fresh boot, hold the gateway until the model API\n"
                 "# answers, so its own boot-time resume does not run offline. '-' = never blocks a start.\n"
                 f"[Service]\nExecStartPre=-{py} {SCRIPT} wait-online --timeout 600\nTimeoutStartSec=12min\n"),
    }
    for path, body in files.items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(body)
        print("wrote", path)
    desktop = desktop_dir()
    if desktop and os.path.isdir(desktop) and desktop != HOME:
        icon = os.path.join(desktop, DESKTOP_FILE)
        shutil.copy(LAUNCHER, icon)
        os.chmod(icon, 0o755)
        try:
            subprocess.run(["gio", "set", icon, "metadata::trusted", "true"], stderr=subprocess.DEVNULL)
        except OSError:
            print("gio not found: mark the desktop icon as trusted by hand (right-click, Allow Launching)")
        print("wrote", icon)
    systemctl("daemon-reload")
    print("systemd user daemon reloaded (the gateway was NOT restarted; the gate applies from its next start)")
    return 0


def cmd_uninstall(a):
    paths = [AUTOSTART, LAUNCHER, DROPIN]
    desktop = desktop_dir()
    if desktop:
        paths.append(os.path.join(desktop, DESKTOP_FILE))
    for path in paths:
        if os.path.exists(path):
            os.remove(path)
            print("removed", path)
    systemctl("daemon-reload")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("snapshot")
    f = sub.add_parser("freeze")
    f.add_argument("--then", choices=["poweroff", "reboot", "none"], default="poweroff")
    f.add_argument("--ask", action="store_true", help="confirm in a dialog (the launcher uses this)")
    f.add_argument("--dry-run", action="store_true")
    f.add_argument("--force", action="store_true", help="skip the boot/thaw guard (a human's explicit call only)")
    f.add_argument("--foreground", action="store_true", help=argparse.SUPPRESS)
    f.add_argument("--origin", default=None, help=argparse.SUPPRESS)
    f.add_argument("--origin-timeout", type=int, default=300, help=argparse.SUPPRESS)
    t = sub.add_parser("thaw")
    t.add_argument("--dry-run", action="store_true")
    t.add_argument("--net-timeout", type=int, default=900)
    w = sub.add_parser("wait-online")
    w.add_argument("--timeout", type=int, default=600)
    w.add_argument("--always", action="store_true", help="probe even without a pending freeze")
    for name in ("status", "discard", "install", "uninstall"):
        sub.add_parser(name)
    a = p.parse_args()
    return {
        "snapshot": cmd_snapshot, "freeze": cmd_freeze, "thaw": cmd_thaw, "wait-online": cmd_wait_online,
        "status": cmd_status, "discard": cmd_discard, "install": cmd_install, "uninstall": cmd_uninstall,
    }[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
