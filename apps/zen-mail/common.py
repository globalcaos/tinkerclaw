"""Shared pieces for the mail reader: paths, settings, the local database and the model call.

Everything lives on this machine. The database and settings sit in ZEN_MAIL_DATA (default
~/.local/share/zen-mail), outside any git repository.
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import time

HOME = pathlib.Path.home()
DATA = pathlib.Path(os.environ.get("ZEN_MAIL_DATA", HOME / ".local/share/zen-mail"))
APP = pathlib.Path(__file__).resolve().parent
OUTLOOK_CLI = pathlib.Path(
    os.environ.get("ZEN_MAIL_OUTLOOK_CLI", HOME / ".openclaw/workspace/skills/outlook-hack/scripts/outlook.mjs")
)

CLAUDE = os.environ.get("ZEN_MAIL_CLAUDE") or shutil.which("claude") or "claude"

# The other places work and life arrive besides mail (the architect, 2026-10-15 13:46-13:50: "and with teams", "and with
# whatsapp", "context from all sides needs to be considered"). Each lands in `messages` like a mail thread, its conv
# prefixed with the source, so triage ranks everything in one list. Read-only: nothing is ever sent from here.
JIRA_CLI = pathlib.Path(os.environ.get("ZEN_MAIL_JIRA_CLI", HOME / ".openclaw/workspace/skills/jira/scripts/jira.py"))
TEAMS_CLI = pathlib.Path(
    os.environ.get("ZEN_MAIL_TEAMS_CLI", HOME / ".openclaw/workspace/skills/teams-hack/scripts/chat-recent.mjs")
)
WHATSAPP_DB = pathlib.Path(os.environ.get("ZEN_MAIL_WHATSAPP_DB", HOME / ".openclaw/data/whatsapp-history.db"))
# "jarvis:" (2026-10-16): cards Jarvis brings, released stream by stream (dams.py); never triaged by the model.
SOURCE_PREFIX = {"jira:": "jira", "teams:": "teams", "wa:": "whatsapp", "jarvis:": "jarvis", "gh:": "github", "ghstar:": "github",
                 "slack:": "slack", "clawhub:": "clawhub"}
SOURCE_LABEL = {"email": "Mail", "jira": "Jira", "teams": "Teams", "whatsapp": "WhatsApp", "jarvis": "Jarvis", "github": "GitHub", "slack": "Slack",
                "clawhub": "ClawHub"}


def source_of(conv):
    for prefix, name in SOURCE_PREFIX.items():
        if (conv or "").startswith(prefix):
            return name
    return "email"

DEFAULT_SETTINGS = {
    # Which mailboxes exist. "outlook" goes through the outlook-hack CLI, "gmail" through gog.
    # A work topic can only produce an Outlook draft and a personal one only a Gmail draft.
    "accounts": {
        "work": {"kind": "outlook", "label": "Work", "address": "", "sources": ["jira", "teams"]},
        "personal": {"kind": "gmail", "label": "Personal", "address": "", "sources": ["whatsapp"]},
    },
    "owner": "",
    "about_owner": "",
    # Senders (substring of the address or name) that are always set aside and never sent to the model.
    "always_aside": [],
    # Words in a subject that mark a CV or job application: those never go to the model.
    "private_words": ["cv", "c.v.", "currículum", "curriculum", "resume", "candidatura", "candidat", "job application"],
    "days": 21,
    "model": "sonnet",
    "nudge_days": 4,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, acct TEXT, conv TEXT, box TEXT, from_name TEXT, from_addr TEXT,
  rcpts TEXT, subject TEXT, date TEXT, unread INT, body TEXT, has_att INT, link TEXT,
  labels TEXT, unsub TEXT, unsub_post TEXT);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(acct, conv);
CREATE TABLE IF NOT EXISTS topics(
  id TEXT PRIMARY KEY, acct TEXT, conv TEXT, title TEXT, who TEXT, sender TEXT, need TEXT,
  deadline TEXT, urgency INT DEFAULT 0, importance INT DEFAULT 0, summary TEXT, facts TEXT,
  draft TEXT, draft_lang TEXT, options TEXT, choice TEXT, noise INT DEFAULT 0, private INT DEFAULT 0,
  state TEXT DEFAULT 'open', later_until TEXT, sig TEXT, last_date TEXT, reply_to TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS chat(
  id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, ts TEXT, who TEXT, text TEXT, changed INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS senders(acct TEXT, addr TEXT, name TEXT, state TEXT, PRIMARY KEY(acct, addr));
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS streams(id TEXT PRIMARY KEY, level INT DEFAULT 0, since TEXT, blocked_until TEXT);
CREATE TABLE IF NOT EXISTS candidates(
  id TEXT PRIMARY KEY, stream TEXT, acct TEXT, title TEXT, summary TEXT, facts TEXT, body TEXT, link TEXT,
  actions TEXT, score REAL DEFAULT 0, created TEXT, released TEXT, outcome TEXT, gone INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, topic TEXT, acct TEXT, src TEXT, stream TEXT, sender TEXT,
  act TEXT, signal REAL, age_s INT, u INT, i INT);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS pins(key TEXT PRIMARY KEY, at INT, text TEXT);
"""


def log(*parts):
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(stamp, *parts, file=sys.stderr, flush=True)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def settings():
    DATA.mkdir(parents=True, exist_ok=True)
    path = DATA / "settings.json"
    if not path.exists():
        path.write_text(json.dumps(DEFAULT_SETTINGS, indent=2, ensure_ascii=False), encoding="utf-8")
    loaded = json.loads(path.read_text(encoding="utf-8"))
    merged = dict(DEFAULT_SETTINGS)
    merged.update(loaded)
    return merged


def db():
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DATA / "zen.db", timeout=30)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    if "extra" not in {r["name"] for r in conn.execute("PRAGMA table_info(topics)")}:
        conn.execute("ALTER TABLE topics ADD COLUMN extra TEXT")  # a Jarvis card's stream, level, buttons and link
    if "atts" not in {r["name"] for r in conn.execute("PRAGMA table_info(messages)")}:
        conn.execute("ALTER TABLE messages ADD COLUMN atts TEXT")  # attachment list, fetched on first open (attachments.py)
    return conn


def meta_get(conn, key, default=None):
    row = conn.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
    return json.loads(row["v"]) if row else default


def meta_set(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)", (key, json.dumps(value, ensure_ascii=False)))
    conn.commit()


def topic_id(acct, conv):
    return acct + ":" + hashlib.sha1(conv.encode("utf-8")).hexdigest()[:16]


class AuthExpired(Exception):
    """The mailbox sign-in has lapsed; the owner has to renew it."""


def run(cmd, timeout=120, input_text=None, cwd=None):
    proc = subprocess.run(cmd, input=input_text, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        if "AADSTS700084" in err or "Token refresh failed" in err:
            raise AuthExpired(err[-300:])
        raise RuntimeError(f"{cmd[0]} {' '.join(cmd[1:3])} failed: {err[-400:]}")
    return proc.stdout


def outlook(*args, timeout=180):
    return json.loads(run(["node", str(OUTLOOK_CLI), *args], timeout=timeout))


def jira(*args, timeout=60):
    return json.loads(run([sys.executable, "-I", str(JIRA_CLI), *args], timeout=timeout))


def gog(*args, timeout=120):
    return json.loads(run(["gog", *args, "--json", "--no-input"], timeout=timeout))


# Jarvis's memory, readable by the topic chat (the architect, 2026-10-19 19:24: "zen mail is amnesic … allow it to fetch your
# memories"). Read-only: the model gets Read, Grep and Glob, and only inside these folders.
MEMORY_DIRS = [HOME / ".openclaw/agent-memory", HOME / ".openclaw/workspace/memory"]


def ask_model(prompt, system, model=None, timeout=300, read_dirs=None):
    """One subscription-billed Claude call with no hooks or project files loaded. No tools, unless read_dirs is given:
    then Read, Grep and Glob inside those folders only (they are its working folders; anything outside needs a
    permission nobody can give in -p mode, so it is refused)."""
    dirs = [str(d) for d in (read_dirs or []) if pathlib.Path(d).is_dir()]
    tools = ["--tools", "Read,Grep,Glob", "--allowedTools", *[f"Read(/{d}/**)" for d in dirs]] if dirs else ["--tools", ""]
    cmd = [
        CLAUDE, "-p", "--model", model or settings()["model"], "--output-format", "json",
        "--setting-sources", "", "--strict-mcp-config", *tools, "--disable-slash-commands",
        "--no-session-persistence", "--system-prompt", system,
    ]
    for d in dirs[1:]:
        cmd += ["--add-dir", d]
    for attempt in range(4):
        try:
            out = run(cmd, timeout=timeout, input_text=prompt, cwd=dirs[0] if dirs else "/tmp")
            break
        except (OSError, RuntimeError) as err:  # the CLI is reinstalled now and then: its binary vanishes for seconds
            if attempt == 3:
                raise
            log(f"[model] call failed ({str(err)[:120]}), retrying in 15 s")
            time.sleep(15)
    data = json.loads(out)
    if data.get("is_error"):
        raise RuntimeError("model call failed: " + str(data.get("result", ""))[:300])
    return data.get("result", "")


def unique_texts(bodies):
    """Each paragraph of a thread once (the architect, 2026-10-15: "I want to see each mail text once"). bodies run oldest
    first; a paragraph of 30+ characters already written in an earlier message (a quoted reply, a forwarded mail, a
    banner, a repeated sign-off) is dropped from the later ones. Returns the bodies in the same order."""
    seen, out = set(), []
    for body in bodies:
        keep = []
        for para in re.split(r"\n\s*\n", body or ""):
            key = re.sub(r"\s+", " ", para).strip().lower()
            if len(key) >= 30 and key in seen:
                continue
            seen.add(key)
            if key:
                keep.append(para.strip("\n"))
        out.append("\n\n".join(keep))
    return out


LANG_WORDS = {
    "Spanish": {"y", "los", "las", "con", "para", "pero", "porque", "gracias", "también", "muy", "hoy", "nuestro", "nuestra",
                "está", "están", "estamos", "hemos", "tenemos", "vosotros", "usted", "os", "del", "una", "saludos", "buenos"},
    "Catalan": {"i", "els", "amb", "per", "però", "perquè", "aquest", "aquesta", "gràcies", "també", "és", "són", "hem",
                "molt", "avui", "seva", "nostre", "nostra", "dels", "pel", "doncs", "ho", "hi", "salut", "bon", "fer"},
    "English": {"the", "and", "with", "for", "you", "this", "that", "is", "are", "we", "please", "thanks", "regards", "of"},
}


def thread_language(bodies):
    """The language a topic is written in, decided in code, not by the model (2026-10-15: a thread of five Spanish
    mails and three short Catalan ones came out in Catalan). Each message votes for the language with the most
    marker words; the most votes wins, a tie goes to the first message (how the thread started)."""
    votes = []
    for body in bodies:
        words = re.findall(r"[\wàèéíïòóúüç·]+", (body or "").lower())
        score = {lang: sum(w in marks for w in words) for lang, marks in LANG_WORDS.items()}
        best = max(score, key=score.get)
        if score[best] >= 2:
            votes.append(best)
    if not votes:
        return None
    count = {lang: votes.count(lang) for lang in votes}
    top = max(count.values())
    return next(v for v in votes if count[v] == top)


def parse_json(text):
    """The model is asked for bare JSON; tolerate a fenced block or leading words anyway."""
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start = min([i for i in (text.find("["), text.find("{")) if i >= 0], default=-1)
    if start < 0:
        raise ValueError("no JSON in model reply: " + text[:200])
    # raw_decode stops at the end of the first value: words after the JSON ("Extra data", 5 triage batches lost by
    # 2026-10-19) no longer throw the whole answer away.
    return json.JSONDecoder().raw_decode(text[start:])[0]


def parse_date(s):
    try:
        return datetime.datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def in_today(t, now, unread=None):
    """The one rule for what Today shows. Everything else also leaves the mailbox's inbox (tidy.py)."""
    if t["noise"] or t["need"] == "none":
        return False
    if t["state"] == "later":
        until = parse_date(t["later_until"])
        return bool(until and until <= now)
    return t["state"] == "open"
