"""The butler pass (2026-10-16: act as a butler, handling everything possible and taking each requirement as far as
it can go before presenting it).

Each hourly run picks the few open topics that need something from the architect (a reply, a decision, an action), most urgent
first, and hands each to a Sonnet helper that WORKS the topic before he sees it: it searches his two mailboxes for what
the thread asks for (invoices, contracts, earlier figures), downloads the files into the topic's own folder, and
writes the full reply draft naming what is attached. It also leaves him a note: what is done, what is missing, and for
each gap how he could give access so next time nothing is missing.

What the helper may do is fixed in code, not trusted to the prompt: only search and read mail (gog, outlook.mjs read
commands), download attachments, read PDFs, and write inside the topic's folder. No send command exists in either tool
path it can reach, nothing is deleted, and the amygdala's hard-rule hook guards every command it runs. Approve still
only puts a draft in the mailbox; the architect sends.
"""
import datetime
import json
import os
import re
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from attachments import texts_for_topic
from common import APP, CLAUDE, HOME, JIRA_CLI, MEMORY_DIRS, OUTLOOK_CLI, db, log, now_iso, parse_json, run, settings, source_of, unique_texts
import owner

# 2026-10-22: no limit of 3 emails per turn; the primary agent detects what is new and starts one helper per
# subject, all in parallel. No per-run cap: every
# changed subject gets its own helper, all started together. The only brake is the Pi's memory (one helper is a
# Claude process of about 300 MB): a helper waits to start while less than MIN_FREE_MB would remain.
MIN_FREE_MB = 1500
TEAMS_DIR = HOME / ".openclaw/workspace/skills/teams-hack/scripts"
REPOS = [HOME / "src/orbisvision", HOME / "src/tinkerclaw"]
DOCS = [HOME / "Documents/ORBIS"]  # ORBIS's documents (test sheets, offers) for work topics; read only
TIMEOUT_S = 900
HARD_RULES = HOME / ".openclaw/data/amygdala-jev/hooks/hard-rules.mjs"
POLICY = HOME / ".openclaw/data/amygdala-jev/policy.json"

SCHEMA = """
CREATE TABLE IF NOT EXISTS butler(
  topic TEXT PRIMARY KEY, sig TEXT, ts TEXT, folder TEXT, files TEXT, note TEXT, needs TEXT, done TEXT,
  draft_before TEXT, error TEXT);
"""
KIT_COLUMNS = ("brief", "links", "commands")  # 2026-10-22: what the task means, links to open, commands to run

SYSTEM = """You are Oscar Serra's butler. Before he even opens this topic, take it as far as you can, so that all he
has to do is check and press send. the architect runs technology at Orbis Works (ORBIS). Work mail is Outlook
(owner@example.com); his personal mail is Gmail (owner@example.com), where many service receipts and invoices arrive.

You have tools to SEARCH and READ both mailboxes and to download attachments:
- Gmail: `gog gmail search '<query>' --max 30 --json --no-input`, `gog gmail thread get <threadId> --json --no-input`,
  `gog gmail attachment <messageId> <attachmentId> --out "<FOLDER>/<file name>" --json --no-input`
- Outlook: `node <OUTLOOK> mail search "<KQL>"`, `node <OUTLOOK> mail read <id>`, `node <OUTLOOK> mail attachments <id>`,
  `node <OUTLOOK> mail attachment <id> <attachmentId> --save "<FOLDER>/<file name>"`
- `pdftotext -layout <file> -` to read a PDF.
- `python3 -I <APP>/mail2pdf.py gmail|outlook <messageId> "<FOLDER>/<name>.pdf"` saves an email as a PDF: use it for
  receipts and confirmations that arrive only as an email body, so they can be attached like any invoice.
Write files only inside <FOLDER>.
- Teams (read only). Graph has no chat-read permission on this tenant, so `teams.mjs search/chats/chat` answer 403:
  never report that as a missing permission. Read chats through Teams' own chat service instead:
  `node <TEAMS>/chat-recent.mjs --from "<name>" --since <YYYY-MM-DD>` (who wrote what, with the chat id),
  `node <TEAMS>/chat-read-chatsvc.mjs <chatId> 50 --full` (one chat's last messages), and
  `node <TEAMS>/teams.mjs users --search "<surname>"` (a person's directory id; the 1:1 chat id with the architect is
  `19:<idA>_<idB>@unq.gbl.spaces`, the two ids in ascending order, the architect's starts <owner-id>). For OrbisVision work the
  people are usually two named colleagues.
- OrbisVision 2.0 (SV2) lives on branch sv2/build of the orbisvision repo, checked out in <REPOS>: its docs are in
  sv2/docs (the test sheet testers follow is sv2/docs/books/usecases/src/test-sheet.md; also TESTING.md, MANUAL.md and
  sv2/deploy/testpc/kit-README.md). The laptop's sv2-build folder is not on this machine: do not ask for it.
- Colleagues' work with Goku (the OrbisVision agent on the server, where testers report SV2 defects and results):
  `python3 -I <APP>/goku_notes.py <word> [<word> ...] [--days 30]` prints the messages holding every word.
- Jira (read only): `python3 -I <JIRA> get <KEY>`, `python3 -I <JIRA> search "<JQL>" --max 20`
- The code and its docs (read only): Read, Grep and Glob inside <REPOS>, and `git -C <repo> log --oneline -20`.
- Jarvis's memory about people, projects and decisions: Read, Grep and Glob in <MEMORY> (MEMORY.md is its index).
You cannot send, delete or change anything, and you must not try.

The topic may come from mail, a Jira task, a Teams chat or WhatsApp. Whatever it is, find out what it REALLY asks of
the architect before you answer: a Jira task with one line ("provar SV2 i validar-lo") means whatever the people involved said
about it in Teams and mail, so search Teams and mail for its key, its words and the people, read the repo docs it
points to, and say what it means in practice. You may write "nothing more is known" only after you searched every
source above and list the searches in "done".

Save the architect time: put every link he needs in "links" (documents, PDFs as absolute file paths, web pages, the Jira or
Teams link) and every command he would run in "commands", copied exactly from the repo or the conversation (for
example the command that starts a program he has to test). Never invent a command or a path you did not find.

Do the work the thread asks for. If it asks for invoices, receipts, a document, figures or dates, find them and
download the documents into <FOLDER>. Check each document really matches (supplier, date within a few days, amount;
dollars and euros differ by the exchange rate). Do not invent anything you did not find. Attach everything you found that belongs; never plan to "forward it
separately". In the draft, never state as fact on the architect's behalf anything he has not said himself in the thread:
who made a purchase, who approved it, a promise or a date. Present what you attach and let him add the rest.

Then reply with ONE JSON object and nothing else:
{"brief": "one or two sentences, in the language of the thread: what this really asks of the architect and what the
   next step is",
 "links": [{"label": "short name", "target": "https://... or an absolute file path you found"}],
 "commands": [{"label": "what it does", "cmd": "the exact command, copied from where you found it"}],
 "draft": "only when someone waits for an answer by mail: the full reply the architect would send, in the language of the thread, short and warm, saying what is attached and,
   if something is still missing, that he is looking for the rest; greeting and a one-word sign-off, no signature",
 "attach": ["file names in <FOLDER> to attach to the reply, only the ones that belong"],
 "note": "to the architect, in the language of the thread, 2-4 sentences: what you did, what you found, what is missing, and
   anything he should know before sending (for example a document that shows a personal address or a personal project)",
 "needs": [{"what": "what you could not get", "how": "the simplest way the architect could give you access next time (a login
   to share in the browser, a billing email to move to his work address, an export to set up), one sentence"}],
 "done": ["short lines: each thing you did"]}"""


def _ensure(conn):
    conn.executescript(SCHEMA)
    have = {r[1] for r in conn.execute("PRAGMA table_info(butler)")}
    for c in KIT_COLUMNS:
        if c not in have:
            conn.execute(f"ALTER TABLE butler ADD COLUMN {c} TEXT")


def _folder(t):
    stamp = (t["last_date"] or now_iso())[:10]
    title = re.sub(r'[\\/:*?"<>|\n]+', " ", t["title"] or "topic").strip()[:70]
    base = HOME / "Documents" / ("ORBIS" if t["acct"] == "work" else "") / "Zen Mail"
    return base / f"{stamp} {title}"


def _settings_file():
    """Only the amygdala's hard-rule hook: every command the helper runs is checked like Jarvis's own."""
    hooks = {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "timeout": 10,
             "command": f"AMYGDALA_POLICY_PATH='{POLICY}' node '{HARD_RULES}'"}]}]}} if HARD_RULES.exists() else {}
    f = tempfile.NamedTemporaryFile("w", suffix=".json", prefix="zen-butler-", delete=False)
    json.dump(hooks, f)
    f.close()
    return f.name


def _allowed(folder):
    o = str(OUTLOOK_CLI)
    return [
        "Bash(gog gmail search:*)", "Bash(gog gmail thread get:*)", "Bash(gog gmail attachment:*)",
        f"Bash(node {o} mail search:*)", f"Bash(node {o} mail read:*)", f"Bash(node {o} mail attachments:*)",
        f"Bash(node {o} mail attachment:*)", "Bash(pdftotext:*)", "Bash(ls:*)", f"Bash(python3 -I {APP}/mail2pdf.py:*)",
        # Absolute paths in Claude permission rules take a leading "//" (the folder already starts with one "/").
        f"Bash(node {TEAMS_DIR}/teams.mjs search:*)", f"Bash(node {TEAMS_DIR}/teams.mjs chats:*)",
        f"Bash(node {TEAMS_DIR}/teams.mjs chat:*)", f"Bash(node {TEAMS_DIR}/chat-recent.mjs:*)",
        f"Bash(node {TEAMS_DIR}/chat-read-chatsvc.mjs:*)", f"Bash(node {TEAMS_DIR}/teams.mjs users:*)",
        f"Bash(python3 -I {APP}/goku_notes.py:*)",
        f"Bash(python3 -I {JIRA_CLI} get:*)", f"Bash(python3 -I {JIRA_CLI} search:*)",
        *[f"Bash(git -C {r} {verb}:*)" for r in REPOS for verb in ("log", "show")],
        "Read", "Grep", "Glob", f"Write(/{folder}/**)",
    ]


def candidates(conn):
    """Open topics that need the architect, never handled for their current state, most urgent first."""
    _ensure(conn)
    done = {r["topic"]: r["sig"] for r in conn.execute("SELECT topic, sig FROM butler")}
    rows = conn.execute(
        "SELECT * FROM topics WHERE state='open' AND private=0 AND noise=0 AND need IN ('reply','decide','act','seize')"
        " ORDER BY urgency DESC, importance DESC, last_date DESC").fetchall()
    # Every source (2026-10-22): a Jira task or a Teams chat gets worked like a mail. Jarvis's own cards carry their work.
    return [t for t in rows if source_of(t["conv"]) != "jarvis" and done.get(t["id"]) != t["sig"]]


def work_topic(conn, t):
    folder = _folder(t)
    folder.mkdir(parents=True, exist_ok=True)
    msgs = conn.execute("SELECT * FROM messages WHERE acct=? AND conv=? ORDER BY date", (t["acct"], t["conv"])).fetchall()
    me = settings()["accounts"][t["acct"]]["address"].lower()
    texts = unique_texts([m["body"] for m in msgs])
    item = {
        "today": datetime.date.today().isoformat(), "mailbox": t["acct"], "topic": t["title"], "summary": t["summary"],
        "current_draft": t["draft"],
        "thread": [{"from": "the architect" if m["from_addr"] == me else (m["from_name"] or m["from_addr"]), "date": (m["date"] or "")[:16],
                    "text": x[:3000]} for m, x in list(zip(msgs, texts))[-10:]],
        "attachments_in_thread": texts_for_topic(conn, t["id"]),
        "folder": str(folder),
    }
    item["source"] = source_of(t["conv"])
    item["owner"] = owner.brief()
    repos = [str(r) for r in REPOS + (DOCS if t["acct"] == "work" else []) if r.is_dir()]
    mem = [str(d) for d in MEMORY_DIRS if d.is_dir()]
    system = (SYSTEM.replace("<FOLDER>", str(folder)).replace("<OUTLOOK>", str(OUTLOOK_CLI)).replace("<APP>", str(APP))
              .replace("<TEAMS>", str(TEAMS_DIR)).replace("<JIRA>", str(JIRA_CLI)).replace("<REPOS>", ", ".join(repos))
              .replace("<MEMORY>", ", ".join(mem)))
    hooks = _settings_file()
    try:
        cmd = [CLAUDE, "-p", "--model", settings().get("butler_model", "sonnet"), "--output-format", "json",
               "--setting-sources", "", "--settings", hooks, "--strict-mcp-config", "--tools", "Bash,Read,Write,Grep,Glob",
               "--allowedTools", *_allowed(folder), "--add-dir", str(folder),
               *[a for d in repos + mem for a in ("--add-dir", d)], "--no-session-persistence",
               "--disable-slash-commands", "--system-prompt", system]
        out = json.loads(run(cmd, timeout=TIMEOUT_S, input_text=json.dumps(item, ensure_ascii=False), cwd=str(folder)))
    finally:
        os.unlink(hooks)
    if out.get("is_error"):
        raise RuntimeError(str(out.get("result"))[:300])
    ans = parse_json(out.get("result") or "")
    files = [f for f in ans.get("attach") or [] if isinstance(f, str) and (folder / os.path.basename(f)).is_file()]
    # The files to attach get their own sub-folder, so Approve attaches exactly these and nothing the helper left around.
    send_dir = folder / "attach"
    if send_dir.exists():
        shutil.rmtree(send_dir)
    send_dir.mkdir()
    for f in files:
        shutil.copy2(folder / os.path.basename(f), send_dir / os.path.basename(f))
    draft = (ans.get("draft") or "").strip()
    conn.execute(
        "INSERT OR REPLACE INTO butler(topic, sig, ts, folder, files, note, needs, done, draft_before, error, brief, links,"
        " commands) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?)",
        (t["id"], t["sig"], now_iso(), str(folder), json.dumps([os.path.basename(f) for f in files], ensure_ascii=False),
         ans.get("note") or "", json.dumps(ans.get("needs") or [], ensure_ascii=False),
         json.dumps(ans.get("done") or [], ensure_ascii=False), t["draft"], ans.get("brief") or "",
         json.dumps([x for x in ans.get("links") or [] if isinstance(x, dict) and x.get("target")], ensure_ascii=False),
         json.dumps([x for x in ans.get("commands") or [] if isinstance(x, dict) and x.get("cmd")], ensure_ascii=False)))
    if draft and source_of(t["conv"]) == "email":
        conn.execute("UPDATE topics SET draft=? WHERE id=?", (draft, t["id"]))
    conn.commit()
    log(f"[butler] {t['id']}: {len(files)} files, {len(ans.get('needs') or [])} needs")
    return ans


def _free_mb():
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 1 << 20


_start_lock = threading.Lock()


def _one(t):
    """One helper for one subject, on its own database connection. Waits to START (never mid-run) while the Pi is short
    of memory; the lock spaces the starts so each new process shows up in MemAvailable before the next one checks."""
    with _start_lock:
        while _free_mb() < MIN_FREE_MB:
            time.sleep(5)
        time.sleep(2)
    conn = db()
    try:
        work_topic(conn, t)
        return True
    except Exception as err:  # one subject failing never stops the others; it is retried on the next run
        log(f"[butler] {t['id']} failed: {err}")
        conn.execute("INSERT OR REPLACE INTO butler(topic, sig, ts, error) VALUES(?,?,?,?)",
                     (t["id"], "failed:" + (t["sig"] or ""), now_iso(), str(err)[:300]))
        conn.commit()
        return False
    finally:
        conn.close()


def butler_pass(conn):
    """The primary pass: find every subject that changed since its helper last ran, and give each its own helper,
    all in parallel."""
    todo = candidates(conn)
    if not todo:
        log("[butler] nothing new")
        return 0
    log(f"[butler] {len(todo)} subjects changed: one helper each, all started together")
    with ThreadPoolExecutor(max_workers=len(todo)) as pool:
        n = sum(pool.map(_one, todo))
    log(f"[butler] {n} of {len(todo)} subjects worked")
    return n


def payload(conn, tid):
    """What the page shows under "From your butler" (None when the butler has not worked this topic)."""
    _ensure(conn)
    b = conn.execute("SELECT * FROM butler WHERE topic=? AND error IS NULL", (tid,)).fetchone()
    if not b:
        return None
    folder = b["folder"] or ""
    files = []
    for name in json.loads(b["files"] or "[]"):
        p = os.path.join(folder, "attach", name)
        if os.path.isfile(p):
            files.append({"name": name, "size": os.path.getsize(p)})
    keys = b.keys()
    return {"note": b["note"], "needs": json.loads(b["needs"] or "[]"), "done": json.loads(b["done"] or "[]"),
            "files": files, "folder": folder, "ts": b["ts"],
            "brief": b["brief"] if "brief" in keys else "",
            "links": json.loads((b["links"] if "links" in keys else None) or "[]"),
            "commands": json.loads((b["commands"] if "commands" in keys else None) or "[]")}
