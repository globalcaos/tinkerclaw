"""The things besides mail that Jarvis can bring to Zen Mail, one stream per kind (the architect, 2026-10-16: "you can show me
tasks that I have pinned, you can add tasks from tabs we have open that are not written as tasks anywhere, and you can
be creative with the butler thing ... present a summary of those [crons] in the zen mail").

Each stream turns what it finds into CANDIDATES (a card that could be shown). Nothing here decides what the architect sees:
dams.py releases candidates one by one, only from streams it has opened, and only when he is not busy. Reading is
local or loopback; the only writes are the ones his buttons ask for (add a task, mark a task done).
"""
import datetime
import hashlib
import json
import pathlib
import re
import time

from common import HOME, ask_model, log, meta_get, meta_set, now_iso, run

GATEWAY_TIMEOUT = 90
TINKER = "http://127.0.0.1:18793/tinker/"
SESSIONS_DIR = HOME / ".openclaw/agents/main/sessions"
BUTLER_DIR = HOME / ".openclaw/workspace/memory/butler-log"
WORK_WORDS = re.compile(r"\b(orbis|orbisvision|customer|sv2|jetson|fore[12]|agv|RobotVendor|shinobi|planner|jira|teams)\b", re.I)
STAMP = re.compile(r"^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} GMT[+-]\d+\]\s*")

# Order of the dams, before any learning: `prior` is how sure Jarvis is the architect wants it. The cron tour comes first
# because he named it "a good idea" he has not had time for; the butler last because its value is the least proven.
STREAMS = {
    "crons": {"label": "Your crons, one at a time", "prior": 0.9, "group": "jarvis", "every_h": 6},
    "tabs": {"label": "Unwritten tasks in your chats", "prior": 0.8, "group": "tasks", "every_h": 24},
    "tasks": {"label": "From your task list", "prior": 0.7, "group": "tasks", "every_h": 1},
    "pins": {"label": "What you pinned", "prior": 0.65, "group": "tasks", "every_h": 1},
    "butler": {"label": "The butler", "prior": 0.5, "group": "home", "every_h": 24},
}


def gateway(method, params=None, timeout=GATEWAY_TIMEOUT):
    cmd = ["openclaw", "gateway", "call", method, "--timeout", str(timeout * 1000), "--json"]
    if params is not None:
        cmd += ["--params", json.dumps(params)]
    return json.loads(run(cmd, timeout=timeout + 15))


def _key(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def _date(v):
    """Control Panel dates come as epoch numbers (ms or s) or ISO text; None when absent or unreadable."""
    try:
        if isinstance(v, (int, float)) and v > 0:
            return datetime.datetime.fromtimestamp(v / 1000 if v > 1e11 else v).date()
        if isinstance(v, str) and v:
            return datetime.date.fromisoformat(v[:10])
    except (ValueError, OSError, OverflowError):
        pass
    return None


def _side(text):
    return "work" if WORK_WORDS.search(text or "") else "personal"


def _put(conn, stream, key, acct, title, summary, body, facts=(), link="", actions=(), score=0.0):
    """Insert or refresh one candidate. A released one keeps its release; a candidate that came back is not gone."""
    cid = f"{stream}:{key}"
    old = conn.execute("SELECT released FROM candidates WHERE id=?", (cid,)).fetchone()
    if old and old["released"]:
        conn.execute("UPDATE candidates SET gone=0 WHERE id=?", (cid,))
        return
    conn.execute(
        "INSERT INTO candidates(id, stream, acct, title, summary, facts, body, link, actions, score, created, gone)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET acct=excluded.acct, title=excluded.title,"
        " summary=excluded.summary, facts=excluded.facts, body=excluded.body, link=excluded.link,"
        " actions=excluded.actions, score=excluded.score, gone=0",
        (cid, stream, acct, title[:140], summary, json.dumps(list(facts), ensure_ascii=False), body, link,
         json.dumps(list(actions), ensure_ascii=False), float(score), now_iso()),
    )


def _mark_gone(conn, stream, live_ids):
    """A source that no longer returns an item (task resolved, pin removed): its unreleased candidate goes."""
    for r in conn.execute("SELECT id FROM candidates WHERE stream=? AND released IS NULL AND gone=0", (stream,)).fetchall():
        if r["id"] not in live_ids:
            conn.execute("UPDATE candidates SET gone=1 WHERE id=?", (r["id"],))


# ─── crons: a guided tour, one job per card ─────────────────────────────────────────────────────────────────────────

CRON_SYSTEM = """You explain an AI assistant's scheduled jobs (crons) to their owner, the architect, who set them up long ago
and wants to understand what each one does without reading its brief. For every job you get, write in plain English:
- "title": what the job does for him, as a sentence of at most 70 characters (not its name).
- "summary": two or three short sentences: what it does, when it runs, and what its last run found (from "last_report"),
  in words he can act on. No jargon, no file paths.
Reply with a JSON object only: {"<job id>": {"title": "...", "summary": "..."}, ...}."""


def collect_crons(conn):
    jobs = gateway("cronpanel.list").get("jobs") or []
    summ = {s["jobId"]: s for s in (gateway("cronpanel.board.list").get("summaries") or [])}
    jobs = [j for j in jobs if j.get("enabled")]
    cache = meta_get(conn, "cron_words", {}) or {}
    todo = []
    for j in jobs:
        report = (j.get("report") or {}).get("deltas") or []
        sig = _key(j.get("description"), j.get("scheduleHuman"), json.dumps(report[:3]))
        if (cache.get(j["id"]) or {}).get("sig") != sig:
            todo.append((j, sig, report))
    for i in range(0, len(todo), 8):
        chunk = todo[i:i + 8]
        prompt = json.dumps([{"id": j["id"], "name": j.get("name"), "description": j.get("description"),
                              "schedule": j.get("scheduleHuman"), "last_status": (j.get("state") or {}).get("lastStatus"),
                              "last_report": [str(d)[:400] for d in rep[:3]]} for j, _, rep in chunk], ensure_ascii=False)
        try:
            words = json.loads(re.search(r"\{.*\}", ask_model(prompt, CRON_SYSTEM), re.S).group(0))
        except Exception as err:  # keep the old words; the next run tries again
            log(f"[streams] cron words failed: {err}")
            continue
        for j, sig, _ in chunk:
            w = words.get(j["id"])
            if isinstance(w, dict) and w.get("title"):
                cache[j["id"]] = {"sig": sig, "title": w["title"], "summary": w.get("summary", "")}
    meta_set(conn, "cron_words", cache)
    live = set()
    for j in jobs:
        w = cache.get(j["id"])
        if not w:
            continue
        s = summ.get(j["id"]) or {}
        flags = s.get("openCount") or 0
        st = j.get("state") or {}
        facts = [j.get("scheduleHuman") or "", f"last run {st.get('lastStatus') or 'not yet'}"]
        if flags:
            facts.append(f"{flags} open flags")
        report = "\n".join(f"• {str(d)[:300]}" for d in ((j.get("report") or {}).get("deltas") or [])[:4])
        body = f"{j.get('name')}\n\n{j.get('description') or ''}" + (f"\n\nLast report:\n{report}" if report else "")
        cid = f"crons:{j['id']}"
        live.add(cid)
        # Jobs that left him flags come first: those are where the tour pays off at once.
        _put(conn, "crons", j["id"], "both", w["title"], w["summary"], body, facts, TINKER,
             [{"k": "useful", "label": "Useful"}, {"k": "open", "label": "Open the cron panel"}], score=min(flags, 30) / 30 + 0.2)
    _mark_gone(conn, "crons", live)


# ─── tasks: the Control Panel list ──────────────────────────────────────────────────────────────────────────────────

def collect_tasks(conn):
    rows = gateway("control-panel.tasks.list")
    rows = rows.get("tasks", rows) if isinstance(rows, dict) else rows
    today = datetime.date.today()
    live = set()
    for t in rows:
        if t.get("status") not in ("open", "in_progress") or t.get("hands") == "assistant":
            continue
        due = _date(t.get("due_date"))
        rank = t.get("priority_rank") if isinstance(t.get("priority_rank"), (int, float)) else 100
        score = max(0.0, 1 - rank / 200)
        if due:
            score += 1.0 if (due - today).days <= 2 else 0.3
        if t.get("status") == "in_progress":
            score += 0.3
        ctx = re.sub(r"\s+", " ", t.get("context_md") or "").strip()
        created = _date(t.get("created_at"))
        since = f"{created:%-d %b}" if created else "a while"
        summary = (ctx[:400] + ("…" if len(ctx) > 400 else "")) if ctx else f"On your list since {since}."
        facts = [x for x in [t.get("priority_axis") or "", f"due {due:%a %-d %b}" if due else "", t.get("status").replace("_", " ")] if x]
        cid = f"tasks:{t['id']}"
        live.add(cid)
        axis = t.get("priority_axis") or ""
        _put(conn, "tasks", t["id"], "work" if axis.startswith("orbis") else _side(t.get("text")), t.get("text") or "(task)",
             summary, (t.get("text") or "") + ("\n\n" + (t.get("context_md") or "") if ctx else ""), facts, TINKER,
             [{"k": "taskdone", "label": "Done"}, {"k": "useful", "label": "Good reminder"}], score=score)
    _mark_gone(conn, "tasks", live)


# ─── tabs: unfinished work in open chats that no task records ───────────────────────────────────────────────────────

TABS_SYSTEM = """the architect works with an AI assistant (Jarvis) in chat tabs. You get his recent tabs (name, his last few
messages, the end of the assistant's last answer) and his open task list. Find work he asked for, or agreed to, that is
NOT finished and is NOT already on the task list, so it would be forgotten when the tab closes. Skip tabs whose work is
done, chit-chat, and anything already covered by a task (same aim, even if worded differently). At most 5.
Reply with a JSON array only: [{"key": "<tab key>", "task": "<the task, imperative, at most 90 characters>",
"why": "<one sentence: what is left and why it matters>", "side": "work" if it is about ORBIS or OrbisVision,
else "personal"}]. An empty array is a fine answer."""


def _tail_messages(path, n_user=3):
    users, last = [], ""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 400_000))
            lines = fh.read().decode("utf-8", "replace").splitlines()[1:]
    except OSError:
        return users, last
    for line in lines:
        try:
            o = json.loads(line)
        except ValueError:
            continue
        m = o.get("message") or {}
        c = m.get("content")
        text = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text") if isinstance(c, list) else (c if isinstance(c, str) else "")
        text = text.strip()
        if not text:
            continue
        if m.get("role") == "user" and STAMP.match(text):
            users.append(STAMP.sub("", text)[:400])
        elif m.get("role") == "assistant":
            last = text[-700:]
    return users[-n_user:], last


def collect_tabs(conn):
    sessions = gateway("sessions.list")
    sessions = sessions.get("sessions", sessions) if isinstance(sessions, dict) else sessions
    cutoff = (time.time() - 7 * 86400) * 1000
    tabs = []
    for s in sessions:
        key = s.get("key") or ""
        if ":tinker:" not in key or (s.get("updatedAt") or 0) < cutoff or "Zen Mail" in (s.get("cookiePhrase") or ""):
            continue
        users, last = _tail_messages(SESSIONS_DIR / f"{s.get('sessionId')}.jsonl")
        if users:
            tabs.append({"key": key, "name": s.get("cookiePhrase") or key.split(":")[-1], "oscar_said": users, "assistant_last": last})
    if not tabs:
        return
    tasks = gateway("control-panel.tasks.list")
    tasks = tasks.get("tasks", tasks) if isinstance(tasks, dict) else tasks
    open_tasks = [t.get("text", "")[:160] for t in tasks if t.get("status") in ("open", "in_progress")]
    prompt = json.dumps({"tabs": tabs, "open_tasks": open_tasks}, ensure_ascii=False)
    found = json.loads(re.search(r"\[.*\]", ask_model(prompt, TABS_SYSTEM, timeout=400), re.S).group(0))
    names = {t["key"]: t["name"] for t in tabs}
    live = set()
    for f in found[:5]:
        if not isinstance(f, dict) or f.get("key") not in names or not f.get("task"):
            continue
        k = _key(f["key"], f["task"])
        live.add(f"tabs:{k}")
        _put(conn, "tabs", k, "work" if f.get("side") == "work" else "personal", f["task"],
             f"{f.get('why') or ''} It lives only in the chat “{names[f['key']]}”.",
             f"From the chat “{names[f['key']]}”.", [names[f["key"]][:40]],
             TINKER + "?tab=" + f["key"],
             [{"k": "addtask", "label": "Add to my tasks", "text": f["task"]}, {"k": "open", "label": "Open the chat"}],
             score=0.7)
    _mark_gone(conn, "tabs", live)


# ─── pins: answers he pinned to the top of a chat ───────────────────────────────────────────────────────────────────

def save_pins(conn, pins, removed=None):
    """POST /api/pins from a Tinker page (pin-dock.ts): pins added or changed, and keys unpinned. Only named keys are
    removed: another browser with no pins of its own must never wipe these (2026-10-16)."""
    n = 0
    for p in pins or []:
        if not isinstance(p, dict) or not p.get("key") or not (p.get("text") or "").strip():
            continue
        conn.execute("INSERT OR REPLACE INTO pins(key, at, text) VALUES(?,?,?)", (p["key"], int(p.get("at") or 0), p["text"][:3000]))
        n += 1
    for key in removed or []:
        if isinstance(key, str):
            conn.execute("DELETE FROM pins WHERE key=?", (key,))
    conn.commit()
    return n


def collect_pins(conn):
    names = {}
    try:
        sessions = gateway("sessions.list")
        for s in sessions.get("sessions", sessions) if isinstance(sessions, dict) else sessions:
            names[s.get("key")] = s.get("cookiePhrase") or ""
    except Exception as err:
        log(f"[streams] pins: no tab names ({err})")
    live = set()
    for p in conn.execute("SELECT * FROM pins").fetchall():
        text = p["text"]
        k = _key(p["key"], text[:300])
        live.add(f"pins:{k}")
        first = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
        tab = names.get(p["key"]) or p["key"].split(":")[-1]
        when = datetime.datetime.fromtimestamp(p["at"] / 1000).strftime("%-d %b") if p["at"] else ""
        _put(conn, "pins", k, _side(text + " " + tab), first[:110] or "A pinned answer",
             f"You pinned this in the chat “{tab}”{(' on ' + when) if when else ''}. Is it still open?", text, [tab[:40]],
             TINKER + "?tab=" + p["key"], [{"k": "open", "label": "Open the chat"}, {"k": "useful", "label": "Useful"}], score=0.5)
    _mark_gone(conn, "pins", live)


# ─── butler: the household, one helpful nudge at a time ─────────────────────────────────────────────────────────────

BUTLER_SYSTEM = """You are the architect's household butler. You get his open household notes (kids' events, tradesmen, home
finance). Pick at most 3 things where a nudge THIS WEEK would help him: a date coming up, something waiting on him,
money that needs a decision. For each, propose one concrete next step you could prepare for him (a reminder, a draft
message, a comparison). Plain English, warm and brief, no invented facts.
Reply with a JSON array only: [{"key": "<short stable id>", "title": "<at most 70 characters>",
"summary": "<two sentences: what and why now>", "step": "<the next step you would prepare>"}]."""


def collect_butler(conn):
    notes = []
    for f in sorted(BUTLER_DIR.glob("*-open.md")) + [BUTLER_DIR / "household-finance.md"]:
        if f.exists():
            notes.append(f"## {f.name}\n{f.read_text(encoding='utf-8', errors='replace')[:6000]}")
    if not notes:
        return
    prompt = f"Today is {datetime.date.today():%A %-d %B %Y}.\n\n" + "\n\n".join(notes)
    found = json.loads(re.search(r"\[.*\]", ask_model(prompt, BUTLER_SYSTEM, timeout=300), re.S).group(0))
    live = set()
    for f in found[:3]:
        if not isinstance(f, dict) or not f.get("title"):
            continue
        k = _key(f.get("key") or f["title"])
        live.add(f"butler:{k}")
        _put(conn, "butler", k, "personal", f["title"], f.get("summary") or "",
             (f.get("summary") or "") + ("\n\nWhat I can prepare: " + f["step"] if f.get("step") else ""), [], "",
             [{"k": "useful", "label": "Yes, prepare it" if f.get("step") else "Useful"}], score=0.6)
    _mark_gone(conn, "butler", live)


COLLECTORS = {"crons": collect_crons, "tasks": collect_tasks, "tabs": collect_tabs, "pins": collect_pins, "butler": collect_butler}


def collect(conn, only_open=True):
    """Hourly from sync.py. A stream is read only once dams.py has opened it (or is about to: the next in line), so a
    sealed dam costs no model call. Each stream keeps its own cadence."""
    from dams import next_in_line, open_streams  # local: dams imports this module's STREAMS
    wanted = set(open_streams(conn)) | ({next_in_line(conn)} - {None}) if only_open else set(STREAMS)
    stamps = meta_get(conn, "stream_runs", {}) or {}
    for sid in STREAMS:
        if sid not in wanted:
            continue
        last = stamps.get(sid) or 0
        if time.time() - last < STREAMS[sid]["every_h"] * 3600 - 300:
            continue
        try:
            COLLECTORS[sid](conn)
            conn.commit()
            stamps[sid] = time.time()
            n = conn.execute("SELECT COUNT(*) FROM candidates WHERE stream=? AND gone=0 AND released IS NULL", (sid,)).fetchone()[0]
            log(f"[streams] {sid}: {n} candidates waiting")
        except Exception as err:
            log(f"[streams] {sid} failed: {err}")
    meta_set(conn, "stream_runs", stamps)
