"""Collect recent mail from Outlook (outlook-hack CLI) and Gmail (gog) into the local database."""
import base64
import glob
import hashlib
import sqlite3
import time
import datetime
import html
import json
import os
import pathlib
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from common import TEAMS_CLI, WHATSAPP_DB, gog, jira, log, now_iso, outlook, run, source_of

QUOTE_MARKERS = [
    r"^-{2,}\s*Original Message\s*-{2,}", r"^-{2,}\s*Mensaje original\s*-{2,}", r"^-{2,}\s*Missatge original\s*-{2,}",
    r"^On .{5,120} wrote:\s*$", r"^El .{5,120} escribió:\s*$", r"^El .{5,120} va escriure:\s*$",
    r"^(From|De|Enviado el|Sent|Enviat):\s", r"^_{10,}\s*$",
]
SIGNATURE_MARKERS = [r"^--\s*$", r"^\[cid:", r"^Sent from my ", r"^Enviado desde mi ", r"^Enviat des del meu "]
# Lines the mail system adds to every message: skipped, never a cut (the sender's text follows them).
BANNER_LINES = [r"^\[ ?EXTERN ?\]", r"^You don't often get email from ", r"^No suele recibir correo", r"^\[EXTERNAL\]"]


def clean_body(text):
    """Keep what the sender wrote in this message: no quoted history, no signature, no legal tail."""
    text = html.unescape(text or "").replace("\r\n", "\n").replace("\r", "\n")
    out = []
    lines = text.split("\n")
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(">") or any(re.match(p, stripped, re.I) for p in BANNER_LINES):
            continue
        # Gmail wraps its quote header over two lines ("El jue, 15 oct ... <x@y.com>" / "escribió:").
        two = stripped + " " + (lines[i + 1].strip() if i + 1 < len(lines) else "")
        if any(re.match(p, stripped, re.I) or re.match(p, two, re.I) for p in QUOTE_MARKERS + SIGNATURE_MARKERS):
            break
        if re.search(r"(CONFIDENCIAL|CONFIDENTIAL|AVISO LEGAL|AVÍS LEGAL|This e-?mail and any attachments)", stripped):
            break
        out.append(line.rstrip())
    body = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()
    return body[:4000]


def html_to_text(raw):
    raw = re.sub(r"(?is)<(script|style).*?</\1>", "", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", raw)
    return re.sub(r"<[^>]+>", "", raw)


def since_iso(days):
    d = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    return d.strftime("%Y-%m-%dT00:00:00Z")


def fetch_outlook(conn, acct, days):
    seen = 0
    for box, folder, since in (("inbox", "inbox", "2000-01-01T00:00:00Z"), ("sent", "sent", since_iso(days))):
        # the whole inbox (it is what Today must mirror), the owner's sent mail only for the window
        rows = outlook("mail", "sync", "--since", since, "--folder", folder, "--max", "2000", timeout=600)
        for m in rows:
            rcpts = [r.get("address", "").lower() for r in (m.get("to") or []) + (m.get("cc") or [])]
            conn.execute(
                "INSERT OR REPLACE INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread,"
                " body, has_att, link, labels, unsub, unsub_post) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,"
                " (SELECT unsub FROM messages WHERE id=?), (SELECT unsub_post FROM messages WHERE id=?))",
                (m["id"], acct, m.get("conversationId") or m["id"], box, (m.get("from") or {}).get("name", ""),
                 (m.get("from") or {}).get("address", "").lower(), json.dumps(rcpts), m.get("subject", ""),
                 m.get("date", ""), 0 if m.get("isRead") else 1, clean_body(m.get("body", "")),
                 1 if m.get("hasAttachments") else 0, m.get("webLink", ""), "", m["id"], m["id"]),
            )
            seen += 1
    conn.commit()
    log(f"[outlook] {acct}: {seen} messages in the last {days} days")


def complete_outlook_threads(conn, acct):
    """Bring in every message of each mail thread, from any folder (the architect, 2026-10-15 15:03: the a customer topic showed
    one mail of eight; the customer's mail and his forward to Pere sat in Archive and in Sent older than the window).
    A thread is fetched again only when its newest message changed. Rows land with box='thread', which tidy never
    moves; a message already stored (same id, or same sender and time under an id Outlook has since changed) is kept."""
    done = conn.execute("SELECT v FROM meta WHERE k='threads_complete'").fetchone()
    done = json.loads(done["v"]) if done else {}
    noise = {r["conv"] for r in conn.execute("SELECT conv FROM topics WHERE acct=? AND noise=1", (acct,))}
    newest = {r["conv"]: r["d"] for r in conn.execute("SELECT conv, MAX(date) d FROM messages WHERE acct=? GROUP BY conv", (acct,))}
    # Only real mail threads: a "jarvis:" card (colon at index 6) slipped past the old `":" not in c[:6]` test and
    # Graph refused the whole batch as a malformed id (2026-10-19, the work side failed every hour).
    todo = [c for c, d in newest.items() if source_of(c) == "email" and c not in noise and done.get(c) != d]
    added = 0
    for i in range(0, len(todo), 25):
        chunk = todo[i:i + 25]
        rows = outlook("mail", "conversation", *chunk, timeout=600)
        for m in rows:
            conv = m.get("conversationId")
            addr = (m.get("from") or {}).get("address", "").lower()
            if conn.execute("SELECT 1 FROM messages WHERE id=? OR (acct=? AND conv=? AND from_addr=? AND date=?)",
                            (m["id"], acct, conv, addr, m.get("date", ""))).fetchone():
                continue
            rcpts = [r.get("address", "").lower() for r in (m.get("to") or []) + (m.get("cc") or [])]
            conn.execute(
                "INSERT INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread, body, has_att,"
                " link, labels) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (m["id"], acct, conv, "thread", (m.get("from") or {}).get("name", ""), addr, json.dumps(rcpts),
                 m.get("subject", ""), m.get("date", ""), 0 if m.get("isRead") else 1, clean_body(m.get("body", "")),
                 1 if m.get("hasAttachments") else 0, m.get("webLink", ""), json.dumps([m.get("folder", "")])),
            )
            added += 1
        for c in chunk:
            done[c] = newest[c]
        conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('threads_complete', ?)", (json.dumps(done),))
        conn.commit()
    log(f"[outlook] {acct}: {len(todo)} threads completed from every folder, {added} older messages added")


def _gmail_part_text(payload):
    """Walk a Gmail payload and return the best text body."""
    plain, rich = [], []

    def walk(p):
        mime = p.get("mimeType", "")
        data = (p.get("body") or {}).get("data")
        if data:
            raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
            (plain if mime == "text/plain" else rich if mime == "text/html" else []).append(raw)
        for child in p.get("parts") or []:
            walk(child)

    walk(payload or {})
    if plain:
        return "\n".join(plain)
    return html_to_text("\n".join(rich))


def _has_attachment(payload):
    stack = [payload or {}]
    while stack:
        p = stack.pop()
        if p.get("filename"):
            return True
        stack.extend(p.get("parts") or [])
    return False


def _addr(header):
    m = re.search(r"<([^>]+)>", header or "")
    addr = (m.group(1) if m else (header or "")).strip().lower()
    name = re.sub(r"\s*<[^>]+>", "", header or "").strip().strip('"')
    return name or addr, addr


def fetch_gmail(conn, acct, days, me):
    res = gog("gmail", "search", f"in:inbox newer_than:{days}d", "--max", "400")
    threads = res if isinstance(res, list) else res.get("threads", [])
    known = {r["conv"]: r["n"] for r in conn.execute("SELECT conv, COUNT(*) n FROM messages WHERE acct=? GROUP BY conv", (acct,))}
    todo = [t for t in threads if known.get(t["id"]) != t.get("messageCount")]

    def get(t):
        try:
            return gog("gmail", "thread", "get", t["id"])
        except Exception as err:  # one bad thread must not stop the run
            log(f"[gmail] thread {t['id']} failed: {err}")
            return None

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(get, todo))
    stored = 0
    for data in results:
        if not data:
            continue
        thread = data.get("thread", data)
        for m in thread.get("messages", []):
            h = {x.get("name", "").lower(): x.get("value", "") for x in (m.get("payload") or {}).get("headers", [])}
            name, addr = _addr(h.get("from", ""))
            labels = m.get("labelIds") or []
            rcpts = [_addr(x)[1] for x in re.split(r",(?![^<]*>)", (h.get("to", "") + "," + h.get("cc", ""))) if x.strip()]
            date = datetime.datetime.fromtimestamp(int(m.get("internalDate", "0")) / 1000, datetime.timezone.utc).isoformat()
            conn.execute(
                "INSERT OR REPLACE INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread,"
                " body, has_att, link, labels, unsub, unsub_post) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (m["id"], acct, m["threadId"], "sent" if addr == me else "inbox", name, addr, json.dumps(rcpts),
                 h.get("subject", ""), date, 1 if "UNREAD" in labels else 0, clean_body(_gmail_part_text(m.get("payload"))),
                 1 if _has_attachment(m.get("payload")) else 0,
                 f"https://mail.google.com/mail/u/0/#inbox/{m['threadId']}", json.dumps(labels),
                 h.get("list-unsubscribe"), h.get("list-unsubscribe-post")),
            )
            stored += 1
    conn.commit()
    log(f"[gmail] {acct}: {len(threads)} threads in the inbox, {len(todo)} new or changed, {stored} messages stored")


# ─── Jira, Teams, WhatsApp (2026-10-15) ─────────────────────────────────────────────────────────────────────────
# Each item becomes a pseudo-thread in `messages` so triage and the list treat it like mail. The conv carries the
# source prefix (common.SOURCE_PREFIX); its rows are rewritten on every run so an edit re-triages the topic.

def _put(conn, acct, conv, rows):
    """Replace a pseudo-thread's rows. rows: dicts with id, from_name, from_addr, subject, date, body, link, unread."""
    was_read = {x["id"] for x in conn.execute("SELECT id FROM messages WHERE acct=? AND conv=? AND unread=0", (acct, conv))}
    conn.execute("DELETE FROM messages WHERE acct=? AND conv=?", (acct, conv))
    for r in rows:
        if r["id"] in was_read:
            r = dict(r, unread=0)  # rewritten every hour: what he already read stays read
        conn.execute(
            "INSERT OR REPLACE INTO messages(id, acct, conv, box, from_name, from_addr, rcpts, subject, date, unread,"
            " body, has_att, link, labels, unsub, unsub_post) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)",
            (r["id"], acct, conv, "inbox", r.get("from_name", ""), r.get("from_addr", ""), "[]", r.get("subject", ""),
             r["date"], r.get("unread", 1), (r.get("body") or "")[:4000], 0, r.get("link", ""), json.dumps(r.get("labels", []))),
        )


def _close_gone(conn, acct, prefix, live):
    """Topics of this source that the source no longer returns (a Jira task closed) leave the list."""
    for row in conn.execute("SELECT DISTINCT conv FROM messages WHERE acct=? AND conv LIKE ?", (acct, prefix + "%")).fetchall():
        if row["conv"] not in live:
            conn.execute("DELETE FROM messages WHERE acct=? AND conv=?", (acct, row["conv"]))
            conn.execute("UPDATE topics SET state='done' WHERE acct=? AND conv=?", (acct, row["conv"]))


def _gh(*args, timeout=60):
    return json.loads(run(["gh", "api", *args], timeout=timeout) or "null")


def fetch_github(conn, acct, owner_login="globalcaos"):
    """The opportunity radar's GitHub lane (the architect, 2026-10-22: "git stars, git PRs ... opportunities for me to get the
    word out"). Open issues and PRs other people opened on the owner's repos, one pseudo-thread each (gh:repo#n); and,
    per repo that gained stars since the last run, one pseudo-thread naming the new stargazers with their reach
    (followers, bio, site), because a well-followed stargazer is a person worth reaching out to (ghstar:repo)."""
    live = set()
    q = f"user:{owner_login} is:open -author:{owner_login}"
    for it in (_gh("-X", "GET", "search/issues", "-f", f"q={q}", "-f", "per_page=50") or {}).get("items", []):
        repo = it["repository_url"].rsplit("/", 1)[-1]
        conv = f"gh:{repo}#{it['number']}"
        live.add(conv)
        kind = "Pull request" if it.get("pull_request") else "Issue"
        head = f"{kind} on {owner_login}/{repo} by {it['user']['login']} · {it.get('comments', 0)} comments\n{it.get('title', '')}"
        _put(conn, acct, conv, [{"id": f"{conv}@{it.get('updated_at')}", "from_name": it["user"]["login"],
                                 "from_addr": "github:" + it["user"]["login"], "subject": f"{kind}: {it.get('title', '')}",
                                 "date": it.get("updated_at") or it.get("created_at"), "body": head + "\n\n" + (it.get("body") or ""),
                                 "link": it.get("html_url", ""), "labels": ["github", kind.lower()]}])
    _close_gone(conn, acct, "gh:", live)
    seen = json.loads((conn.execute("SELECT v FROM meta WHERE k='gh_stargazers'").fetchone() or {"v": "{}"})["v"])
    first = not seen
    for r in _gh(f"users/{owner_login}/repos?per_page=100") or []:
        if not r.get("stargazers_count"):
            continue
        name = r["name"]
        gazers = _gh(f"repos/{owner_login}/{name}/stargazers?per_page=100", "-H",
                     "Accept: application/vnd.github.star+json", "--paginate", timeout=120) or []
        logins = [(g["user"]["login"], g.get("starred_at")) for g in gazers]
        new = [(lg, at) for lg, at in logins if lg not in set(seen.get(name, []))]
        seen[name] = [lg for lg, _ in logins]
        if first or not new:
            continue  # the first run only learns who is there; news starts with the next star
        lines = []
        for lg, at in new[:15]:
            u = _gh(f"users/{lg}") or {}
            reach = f"{u.get('followers', 0)} followers"
            extra = " · ".join(x for x in (u.get("name"), u.get("company"), u.get("blog"), (u.get("bio") or "")[:160]) if x)
            lines.append(f"- {lg} ({reach}){' · ' + extra if extra else ''} · starred {(at or '')[:10]}")
        conv = f"ghstar:{name}"
        body = (f"{len(new)} new star(s) on {owner_login}/{name}, {len(logins)} in total.\n" + "\n".join(lines))
        _put(conn, acct, conv, [{"id": f"{conv}@{new[-1][1]}", "from_name": "GitHub stars", "from_addr": "github:stars",
                                 "subject": f"New stars on {name}", "date": new[-1][1] or now_iso(), "body": body,
                                 "link": f"https://github.com/{owner_login}/{name}/stargazers", "labels": ["github", "stars"]}])
    conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('gh_stargazers', ?)", (json.dumps(seen),))
    conn.commit()
    log(f"[github] {acct}: {len(live)} open issues/PRs by others; star watch on {len(seen)} repos")


# ─── Slack and ClawHub radar lanes (2026-10-22, the architect: "Slack and Clawhub should be available for you anytime") ─────

SLACK_ME = "U0C887M8SBU"  # the architect in The Frontier (Matthew Berman's community); the token is read-only, user scopes


def _slack_token():
    if os.environ.get("SLACK_USER_TOKEN"):
        return os.environ["SLACK_USER_TOKEN"]
    env = pathlib.Path.home() / ".openclaw/.env"
    for line in env.read_text().splitlines() if env.exists() else []:
        if line.startswith("SLACK_USER_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("SLACK_USER_TOKEN is not set")


def fetch_slack(conn, acct, me, days=14):
    """The Frontier, read only: every thread the architect posted in during the last `days` where someone wrote after his last
    post, one pseudo-thread each (slack:<channel>:<thread>), from his last post on. A thread whose last word is his
    leaves the list: nothing waits for him there."""
    tok = _slack_token()

    def api(method, **params):
        req = urllib.request.Request(f"https://slack.com/api/{method}?" + urllib.parse.urlencode(params),
                                     headers={"Authorization": "Bearer " + tok})
        out = json.load(urllib.request.urlopen(req, timeout=30))
        if not out.get("ok"):
            raise RuntimeError(f"slack {method}: {out.get('error')}")
        return out

    names = {}

    def name(uid):
        if uid not in names:
            u = api("users.info", user=uid).get("user") or {}
            names[uid] = (u.get("profile") or {}).get("display_name") or u.get("real_name") or uid
        return names[uid]

    after = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    live, seen = set(), set()
    for m in api("search.messages", query=f"from:me after:{after}", count=100, sort="timestamp")["messages"]["matches"]:
        ch = m["channel"]["id"]
        root = (urllib.parse.parse_qs(urllib.parse.urlparse(m.get("permalink", "")).query).get("thread_ts") or [m["ts"]])[0]
        if (ch, root) in seen:
            continue
        seen.add((ch, root))
        msgs = api("conversations.replies", channel=ch, ts=root, limit=200).get("messages", [])
        mine = max((float(x["ts"]) for x in msgs if x.get("user") == SLACK_ME), default=0)
        if not any(float(x["ts"]) > mine for x in msgs):
            continue
        conv = f"slack:{ch}:{root}"
        live.add(conv)
        chan = m["channel"].get("name") or ch
        subject = f"#{chan}: " + " ".join((msgs[0].get("text") or "").split())[:80]
        rows = []
        for x in msgs:
            if float(x["ts"]) < mine:
                continue
            own = x.get("user") == SLACK_ME
            reacts = " ".join(f":{e['name']}: {e['count']}" for e in x.get("reactions", []))
            rows.append({"id": f"{conv}@{x['ts']}", "from_name": "the architect" if own else name(x.get("user") or ""),
                         "from_addr": me if own else "slack:" + (x.get("user") or ""), "subject": subject,
                         "date": datetime.datetime.fromtimestamp(float(x["ts"])).astimezone().isoformat(),
                         "body": (x.get("text") or "") + (f"\n[reactions: {reacts}]" if reacts else ""),
                         "unread": 0 if own else 1, "link": m.get("permalink", ""), "labels": ["slack", chan]})
        _put(conn, acct, conv, rows)
    _close_gone(conn, acct, "slack:", live)
    conn.commit()
    log(f"[slack] {acct}: {len(seen)} threads with the architect's posts in {days} days, {len(live)} with replies after his")


CLAWHUB_API = "https://clawhub.ai/api/v1"
CLAWHUB_CATALOG = pathlib.Path.home() / ".openclaw/workspace/memory/online-presence/clawhub-catalog.json"
CLAWHUB_INSTALL_JUMP = 10  # installs gained since the last notice that make a listing worth a look


def fetch_clawhub(conn, acct, owner_login="globalcaos"):
    """The ClawHub lane: our skills and plugins (the list the daily catalog cron keeps), live stats from the public
    API. A listing that gained comments or stars, or CLAWHUB_INSTALL_JUMP installs since its last notice, becomes a
    pseudo-thread (clawhub:<slug>): someone engaged, which is a person to answer or a listing worth pushing."""
    cat = json.loads(CLAWHUB_CATALOG.read_text())
    items = [("skill", s) for s in cat.get("skills", {})] + [("plugin", p) for p in cat.get("plugins", {})]

    def stats(item):
        kind, slug = item
        path = (f"/skills/{slug}?owner={owner_login}" if kind == "skill"
                else "/packages/" + urllib.parse.quote(f"@{owner_login}/{slug}", safe=""))
        try:
            d = json.load(urllib.request.urlopen(urllib.request.Request(CLAWHUB_API + path,
                                                 headers={"User-Agent": "zen-mail"}), timeout=30))
        except Exception:
            return item, None
        return item, (d.get("skill") or d.get("package") or {}).get("stats")

    with ThreadPoolExecutor(max_workers=6) as pool:
        now = dict(pool.map(stats, items))
    last = json.loads((conn.execute("SELECT v FROM meta WHERE k='clawhub_stats'").fetchone() or {"v": "{}"})["v"])
    first = not last
    news = 0
    for (kind, slug), s in now.items():
        if not s:
            continue
        key = f"{kind}:{slug}"
        prev = last.get(key)
        last[key] = dict(s, noticed_installs=(prev or {}).get("noticed_installs", s.get("installs", 0)))
        if first or not prev:
            continue  # the first sight only learns the numbers
        gained = {k: s.get(k, 0) - prev.get(k, 0) for k in ("comments", "stars")}
        jump = s.get("installs", 0) - last[key]["noticed_installs"]
        if not (gained["comments"] > 0 or gained["stars"] > 0 or jump >= CLAWHUB_INSTALL_JUMP):
            continue
        last[key]["noticed_installs"] = s.get("installs", 0)
        parts = [f"+{gained['comments']} comment(s)" if gained["comments"] > 0 else "",
                 f"+{gained['stars']} star(s)" if gained["stars"] > 0 else "",
                 f"+{jump} installs since the last notice" if jump >= CLAWHUB_INSTALL_JUMP else ""]
        what = ", ".join(p for p in parts if p)
        link = (f"https://clawhub.ai/{owner_login}/{slug}" if kind == "skill"
                else "https://clawhub.ai/plugins/" + urllib.parse.quote(f"@{owner_login}/{slug}", safe=""))
        conv = f"clawhub:{slug}"
        body = (f"ClawHub {kind} {slug}: {what}. Now {s.get('installs', 0)} installs, {s.get('downloads', 0)} downloads,"
                f" {s.get('stars', 0)} stars, {s.get('comments', 0)} comments."
                + (" Read the new comments on the listing page and answer them." if gained["comments"] > 0 else ""))
        _put(conn, acct, conv, [{"id": f"{conv}@{now_iso()}", "from_name": "ClawHub", "from_addr": "clawhub:stats",
                                 "subject": f"ClawHub: {slug}, {what}", "date": now_iso(), "body": body, "link": link,
                                 "labels": ["clawhub", kind]}])
        news += 1
    conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('clawhub_stats', ?)", (json.dumps(last),))
    conn.commit()
    log(f"[clawhub] {acct}: {sum(1 for v in now.values() if v)} of {len(items)} listings read, {news} with news")


def fetch_jira(conn, acct):
    """Open Jira tasks assigned to the owner: one pseudo-thread per task, the task itself as the inbound item."""
    found = jira("search", "assignee=currentUser() AND statusCategory != Done ORDER BY updated DESC", "--max", "100")
    live = set()
    for brief in found.get("issues", []):
        i = jira("get", brief["key"])
        conv = "jira:" + i["key"]
        live.add(conv)
        head = (f"Jira task {i['key']} · status {i.get('status')} · priority {i.get('priority') or 'none'}"
                f" · type {i.get('type')} · labels {', '.join(i.get('labels') or []) or 'none'}")
        rows = [{"id": f"{conv}@{i.get('updated')}", "from_name": i.get("reporter") or "Jira", "from_addr": "jira",
                 "subject": f"[{i['key']}] {i.get('summary')}", "date": i.get("updated") or i.get("created"),
                 "body": head + "\n\n" + (i.get("description") or "(no description)"), "link": i.get("url", ""),
                 "labels": ["jira", i.get("status") or ""]}]
        for n, c in enumerate(i.get("comments") or []):
            rows.append({"id": f"{conv}#c{n}@{c.get('created')}", "from_name": c.get("author") or "", "from_addr": "jira",
                         "subject": rows[0]["subject"], "date": c.get("created") or rows[0]["date"],
                         "body": c.get("text") or "", "link": i.get("url", ""), "labels": ["jira"]})
        _put(conn, acct, conv, rows)
    _close_gone(conn, acct, "jira:", live)
    conn.commit()
    log(f"[jira] {acct}: {len(live)} open tasks assigned to the owner")


def _local_iso(stamp):
    """'YYYY-MM-DD HH:MM' in this machine's zone (what chat-recent prints) to an ISO time with offset."""
    return datetime.datetime.strptime(stamp, "%Y-%m-%d %H:%M").astimezone().isoformat()


def fetch_teams(conn, acct, days, me, owner):
    """Teams chats with activity in the window, the last 15 lines each. Lines by the owner count as the owner's."""
    out = json.loads(run(["node", str(TEAMS_CLI), "--since", f"{days * 24}h", "--n", "15", "--json"], timeout=300) or "[]")
    chats = {}
    for m in out:
        chats.setdefault(m["chat"], []).append(m)
    owner_l = (owner or "").strip().lower()
    for chat_id, lines in chats.items():
        conv = "teams:" + chat_id
        others = sorted({l["from"] for l in lines if (l.get("from") or "").strip().lower() != owner_l and l.get("from")})
        topic = chat_id if not chat_id.startswith("19:") else ""
        subject = topic or ("Teams chat with " + ", ".join(others) if others else "Teams chat")
        rows = []
        for l in lines[-15:]:
            mine = (l.get("from") or "").strip().lower() == owner_l
            text = l.get("text") or ""
            if l.get("files"):
                text += "\n[files: " + ", ".join(l["files"]) + "]"
            if l.get("images"):
                text += f"\n[{l['images']} image(s)]"
            rows.append({"id": "teams:" + hashlib.sha1(f"{chat_id}|{l['time']}|{l.get('from')}|{text}".encode()).hexdigest()[:20],
                         "from_name": l.get("from") or "", "from_addr": me if mine else "teams:" + (l.get("from") or "").lower(),
                         "subject": subject, "date": _local_iso(l["time"]), "body": text, "unread": 0 if mine else 1,
                         "link": f"https://teams.microsoft.com/l/chat/{chat_id}/0", "labels": ["teams"]})
        _put(conn, acct, conv, rows)
    conn.commit()
    log(f"[teams] {acct}: {len(chats)} chats with activity in the last {days} days")


# The owner's phone book, imported by skill phone-contacts into the people database (the architect, 2026-10-27: "Who the fuck
# is jdthinking by the way??? You have access to my contact list in the phone"). A WhatsApp profile name is whatever the
# contact typed for himself; the phone book is what the owner calls them. Missing files (a fresh clone) = no names.
PEOPLE_ALIASES = pathlib.Path(os.environ.get(
    "ZEN_MAIL_PEOPLE_ALIASES", pathlib.Path.home() / ".openclaw/workspace/memory/people/_aliases.json"))
WA_STORE_GLOB = os.environ.get(
    "ZEN_MAIL_WA_STORE", str(pathlib.Path.home() / ".openclaw/cred*/whatsapp/default/whatsmeow.db"))


def _bare_jid(jid):
    """'10000000000099:26@lid' -> '10000000000099@lid': a device suffix is the same person."""
    user, _, server = (jid or "").partition("@")
    return user.split(":")[0] + "@" + server if server else ""


def _phonebook_names():
    """WhatsApp id ('<digits>@s.whatsapp.net' or '<lid>@lid') -> the owner's phone-book name. Privacy ids (@lid) the
    people database has not seen are mapped through WhatsApp's own lid -> number table, read-only."""
    try:
        aliases = json.loads(PEOPLE_ALIASES.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    names, by_number = {}, {}
    for a in aliases.values():
        shown = (a.get("displayName") or "").strip()
        if not shown or shown.lstrip("+").replace(" ", "").isdigit():  # a bare number is no name
            continue
        for phone in a.get("phones") or []:
            digits = re.sub(r"\D", "", phone)
            if digits:
                by_number.setdefault(digits, shown)
        for lid in a.get("lids") or []:
            names.setdefault(_bare_jid(lid), shown)
    for digits, shown in by_number.items():
        names.setdefault(digits + "@s.whatsapp.net", shown)
    store = next(iter(glob.glob(WA_STORE_GLOB)), None)
    if store:
        try:
            src = sqlite3.connect(f"file:{store}?mode=ro", uri=True)
            for lid, number in src.execute("SELECT lid, pn FROM whatsmeow_lid_map"):
                shown = by_number.get(re.sub(r"\D", "", str(number or "")))
                if shown:
                    names.setdefault(f"{lid}@lid", shown)
            src.close()
        except sqlite3.Error as err:
            log("[whatsapp] lid map unreadable, profile names stay:", err)
    return names


def fetch_whatsapp(conn, acct, days, me):
    """WhatsApp chats (direct and groups) with an incoming message in the window, the last 15 lines each.
    Read-only on the local archive; chats where only the owner writes (the self-chat) are skipped."""
    src = sqlite3.connect(f"file:{WHATSAPP_DB}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    cut = int(time.time()) - days * 86400
    book = _phonebook_names()
    jids = [r["chat_jid"] for r in src.execute(
        "SELECT chat_jid FROM messages WHERE timestamp>? AND from_me=0 AND chat_jid NOT LIKE 'status@%'"
        " GROUP BY chat_jid", (cut,))]
    for jid in jids:
        lines = src.execute(
            "SELECT * FROM (SELECT * FROM messages WHERE chat_jid=? AND timestamp>? ORDER BY timestamp DESC LIMIT 15)"
            " ORDER BY timestamp", (jid, cut)).fetchall()
        name = book.get(_bare_jid(jid)) or next((l["chat_name"] for l in reversed(lines) if l["chat_name"]), "") or jid.split("@")[0]
        group = jid.endswith("@g.us")
        digits = jid.split("@")[0] if jid.endswith("@s.whatsapp.net") else ""
        rows = []
        for l in lines:
            text = l["text_content"] or l["caption"] or (f"[{l['message_type']}]" if l["message_type"] else "")
            if not text:
                continue
            who = "" if l["from_me"] else (book.get(_bare_jid(l["sender_jid"] or jid)) or l["sender_name"] or l["sender_pushname"] or name)
            rows.append({"id": "wa:" + l["id"], "from_name": who, "from_addr": me if l["from_me"] else "wa:" + (l["sender_jid"] or jid),
                         "subject": ("WhatsApp group " if group else "WhatsApp chat with ") + name,
                         "date": datetime.datetime.fromtimestamp(l["timestamp"], datetime.timezone.utc).isoformat(),
                         "body": text, "unread": 0 if l["from_me"] else 1,
                         "link": f"https://wa.me/{digits}" if digits else "", "labels": ["whatsapp"]})
        if rows:
            _put(conn, acct, "wa:" + jid, rows)
    src.close()
    conn.commit()
    log(f"[whatsapp] {acct}: {len(jids)} chats with incoming messages in the last {days} days")
