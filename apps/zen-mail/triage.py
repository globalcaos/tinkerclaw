"""Turn stored mail into topics: code rules first, then one short model call per batch of new threads."""
import datetime
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor

from common import ask_model, log, now_iso, parse_json, source_of, thread_language, topic_id, unique_texts
import merge
import promises

PROMPT_VERSION = "6"  # 6 (2026-10-22): the owner's priorities and focus, and need "seize"  # bump when SYSTEM changes: every thread is triaged again on the next run
# Not bumped for "same_as" (2026-10-19): only a thread with candidates can use it, and the candidates are in its sig,
# so exactly those threads are triaged again; a bump would re-run all ~500 for nothing.
# Not bumped for "slack" and "clawhub" (2026-10-22) either: only their own new threads carry those sources.
# Not bumped for "promise" (2026-10-27): a thread whose owner tail looks like a promise carries ":p" in its sig, so
# exactly those are triaged again; the others pick the field up the next time their mail changes.

SYSTEM = """You triage email, chats and tasks for one busy person so they never have to open their inbox.
Every item has a "source": "email", "teams" (a Microsoft Teams chat), "whatsapp" (a WhatsApp chat or group) or
"jira" (an open task assigned to the owner; its first message is the task itself, the rest are comments) or
"github" (an issue or pull request a stranger opened on the owner's open-source repos, or new stars with who starred:
strangers engaging with his work are the start of his funnel, so a real person to thank, answer or reach out to is
usually "seize" or "reply"; a well-followed stargazer is worth a message),
"slack" (a thread in The Frontier, Matthew Berman's AI community, where the owner posted and someone wrote after him:
the Forward Future team and members there are reach for his work, so an answer, an offer or a meeting is usually
"seize" or "reply"; the owner posts himself, the reply is a draft) or
"clawhub" (one of the owner's published skills or plugins gained comments, stars or a burst of installs: a comment is
a user to answer, a burst is a listing worth pushing, usually "seize").
"related_elsewhere" lists recent lines from the owner's OTHER sources that involve the same people or task keys:
use them as context (a question already answered on Teams is not "reply"; a mail about a task Jira shows moving is
less urgent; a chat chasing a task makes the task more urgent). Never summarise them as if they were this item.
For a jira item, need is usually "act" (it is work to do); urgency and importance follow its priority, its due
date, who is waiting on it and what the related lines say. For a chat, "reply" only when someone waits for the
owner; group chatter with nothing asked of the owner is "read" or "none".
For every item you receive, answer with one JSON object. Reply with a JSON array only, no prose.
Write "title", "summary", "facts" and the option labels in the item's "thread_language" (Spanish from Spain,
Catalan or English), even when some messages in it are in another language (the architect, 2026-10-15: "since the thread
was in Spanish it should all be in Spanish"). When "thread_language" is null, use the language most of its
messages are written in. "draft_lang" stays in English.
The messages run oldest first and each shows only what that message added: text quoted from an earlier message has
been removed, so read them in order as one conversation and cover all of it in the summary, from the first request
to the latest message.

Fields:
- "id": copy the thread id.
- "title": what the matter is, from the owner's point of view, as a plain sentence of at most 70 characters
  (e.g. "Norpack wants the line 2 delivery date confirmed"). Not the subject line.
- "who": the main person or company on the other side, short.
- "need": "reply" (someone waits for an answer), "decide" (a choice only the owner can make),
  "act" (something to do outside email: sign, pay, book), "seize" (a chance that serves the owner's own priorities
  and has a window that closes: someone who can spread the word about his work, a creator, journalist, podcast,
  conference, partner or buyer for his own projects, a request to talk or collaborate; put the closing date in
  "deadline" and weigh it by those priorities, never by how loud the mail is), "read" (worth knowing, nothing to do)
  or "none" (newsletters, notifications, receipts, automatic mail).
- "deadline": "YYYY-MM-DD" if the thread names or clearly implies one, else null.
- "urgency": 0-3. 3 = today or someone is blocked or chasing; 2 = within two working days, or a customer is
  waiting; 1 = this week, or someone waits with no date; 0 = no time pressure.
- Weigh importance and urgency with the owner's priorities and focus given below: what moves his own revenue,
  his funnel or his time counts more than its sender's tone; someone chasing several times is a signal.
- "importance": 0-3. 3 = customers, money, contracts, legal, company-level decisions, family;
  2 = suppliers, partners, colleagues' requests; 1 = internal information; 0 = automatic mail.
- "summary": two to four sentences that let the owner skip reading the thread: how it started, what happened
  since, what is asked now, any figure or date that matters. Plain words, no preamble.
- "facts": up to four short chips (dates, amounts, attachment names with what they contain).
- "draft": when need is "reply", the full reply the owner would send; otherwise null.
- "draft_lang": the language of the draft, in English (e.g. "Spanish").
- "options": when need is "decide", two or three choices, each {"label": "...", "draft": "full reply"};
  otherwise null.
- "same_as": "maybe_same_matter" lists the owner's other email threads that share a person with this one. Give a
  thread's "id" only when both are the SAME specific item: the same request or question, the same order or invoice,
  the same claim or case number, the same document, or one mail resent, forwarded or answered in a new thread. Then
  the two become one topic. Sharing a project, a process, a supplier or a person is NOT enough: two candidates for one
  job, two orders of one project, a past training and a new one, a meeting and a separate decision all stay apart,
  because joining them hides a question still open in one. When unsure, null.

Rules for drafts: write in the language of the other person's last message (Spanish from Spain, with
"vosotros"; Catalan; English). Short, direct and friendly, in the owner's voice. Greeting, the answer, a
one-word sign-off ("Gràcies,", "Un saludo,", "Best regards,") and NO name or signature: the mail client
adds it. Never invent facts, dates, prices or commitments that are not in the thread; when the answer
needs information the owner has not given, write a short holding reply or offer options.
When "you_wrote_last" is true and "days_waiting" is set, the owner wrote last some days ago. If their last
message still expects an answer (a question, a request, a pending quote), need is "reply" and the draft is a
short, polite nudge. If it closed the matter (thanks, confirmation, "OK"), need is "none".

- "promise": something the OWNER promised in his own messages and has not delivered yet, judged on the whole thread:
  "I'll send it tonight", "te lo envío mañana", "t'ho envio aquesta nit", "ho reviso i et dic", "entre avui i demà
  ho tindré". Only his own, and only while still pending: a thing he delivered in that message or a later one is NOT
  a promise ("et passo la versió", "here is the link": a message that carries the thing, as an attachment, a link or
  the text itself, has delivered it; never guess that an attachment is missing), and neither is a plan he just tells
  them ("I'll be at the airport at 9"), a question or a polite formula. Give {"what": a short phrase in thread_language ("enviar el document revisat"),
  "due": "YYYY-MM-DD" in the owner's time zone ("tonight" or "today" = the day of that message, "tomorrow" = the next
  day, "this week" = that Friday, no time given = two days after the message), "late_draft": a short message in the
  other person's language for when it is late: a brief apology and that it is on its way, no new date and nothing
  invented}; otherwise null. When the other side has written since and asks for it, need is "reply" or "act" and the
  summary says what he owes. Items with "owner_promise_check": true come only for this check: the owner wrote last,
  so need is "none" unless his last message also asks them something."""


def _working_days_since(iso):
    try:
        start = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).date()
    except ValueError:
        return 0
    today = datetime.date.today()
    days, d = 0, start
    while d < today:
        d += datetime.timedelta(days=1)
        if d.weekday() < 5:
            days += 1
    return days


def _matches(text, needles):
    text = (text or "").lower()
    return any(n.lower() in text for n in needles if n)


def _upsert(conn, tid, acct, conv, fields):
    cols = ["id", "acct", "conv"] + list(fields)
    vals = [tid, acct, conv] + list(fields.values())
    sets = ", ".join(f"{c}=excluded.{c}" for c in fields)
    conn.execute(
        f"INSERT INTO topics({', '.join(cols)}) VALUES({', '.join('?' * len(cols))}) ON CONFLICT(id) DO UPDATE SET {sets}",
        vals,
    )


JIRA_KEY = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d+\b")


def _name_tokens(name):
    return {w for w in re.findall(r"\w+", (name or "").lower()) if len(w) >= 4}


def _related(convs, conv, msgs, me, limit=5):
    """Context from all sides (the architect, 2026-10-15 13:50): recent lines from OTHER sources of the same account that
    share a person (a name word of 4+ letters) or a Jira key with this item. Same account only: work and personal
    never mix."""
    src = source_of(conv)
    # One set of name words per person. A first name alone is not a person: "Sam" matched three different Sams
    # on 2026-10-15, so two names that both have a surname must share two words.
    people = [t for t in {frozenset(_name_tokens(m["from_name"])) for m in msgs if m["from_addr"] != me} if t]
    keys = set(JIRA_KEY.findall(" ".join((m["subject"] or "") + " " + (m["body"] or "") for m in msgs)))
    if not people and not keys:
        return []

    def same_person(name):
        other = _name_tokens(name)
        return any(len(p & other) >= min(2, len(p), len(other)) for p in people) if other else False

    hits = []
    for other, rows in convs.items():
        if other == conv or source_of(other) in (src, "jarvis"):
            continue
        for r in rows[-10:]:
            text = (r["subject"] or "") + " " + (r["body"] or "")
            if same_person(r["from_name"]) or (keys & set(JIRA_KEY.findall(text))):
                hits.append(r)
    hits.sort(key=lambda r: r["date"] or "", reverse=True)
    return [{"source": source_of(r["conv"]), "from": "owner" if r["from_addr"] == me else (r["from_name"] or r["from_addr"]),
             "date": (r["date"] or "")[:16], "about": (r["subject"] or "")[:80], "text": (r["body"] or "")[:300]}
            for r in hits[:limit]]


def _thread_view(msgs, keep=10):
    """The whole thread for the model, each text once: the first message (how it started) and the latest ones."""
    pairs = list(zip(msgs, unique_texts([m["body"] for m in msgs])))
    return pairs if len(pairs) <= keep else pairs[:1] + pairs[-(keep - 1):]


def triage(conn, acct, me, cfg, owner_about, _depth=0):
    rows = conn.execute("SELECT * FROM messages WHERE acct=? ORDER BY date", (acct,)).fetchall()
    convs = {}
    for r in rows:
        convs.setdefault(r["conv"], []).append(r)
    # Rule 2 of merge.py: the other mail threads that share a person with a thread, for the model to call "same matter".
    topics_by_conv = {r["conv"]: r for r in conn.execute(
        "SELECT id, conv, title, state, noise, private FROM topics WHERE acct=?", (acct,))}
    conv_of_tid = {t["id"]: c for c, t in topics_by_conv.items()}
    people_of = {c: {m["from_addr"] for m in ms if m["from_addr"] and m["from_addr"] != me
                     and not merge.SYSTEM_SENDER.search(m["from_addr"])}
                 for c, ms in convs.items() if source_of(c) == "email"}

    def candidates(conv):
        mine = people_of.get(conv)
        if not mine:
            return []
        out = []
        for c, ppl in people_of.items():
            t = topics_by_conv.get(c)
            if c == conv or not t or t["state"] == "merged" or t["noise"] or t["private"] or not (mine & ppl):
                continue
            out.append({"id": t["id"], "title": t["title"] or "", "last": (convs[c][-1]["date"] or "")[:10]})
        return sorted(out, key=lambda x: x["last"], reverse=True)[:4]

    muted = {r["addr"] for r in conn.execute("SELECT addr FROM senders WHERE acct=? AND state='muted'", (acct,))}
    batch = []
    for conv, msgs in convs.items():
        if source_of(conv) == "jarvis":
            continue  # Jarvis's own cards carry their fields already (dams.py)
        inbound = [m for m in msgs if m["from_addr"] != me]
        if not inbound:
            continue  # only the owner's own mail: nothing to triage
        tid = topic_id(acct, conv)
        mhash = hashlib.sha1("|".join(m["date"] + m["from_addr"] for m in msgs).encode()).hexdigest()  # ids change when Outlook archives
        related = _related(convs, conv, msgs, me)
        maybe = candidates(conv)
        # The related lines and the merge candidates are part of the signature: news on another side re-triages this
        # item (mhash stays last, the new-mail test below reads it).
        # The signature depends on MAIL only. Hashing the candidates' titles, then their card state (merged, noise,
        # done: all set by the model), made threads that share a person re-triage each other on every run
        # (2026-10-27: 28, then 11 work threads every sync). The peers are the four newest threads sharing a person,
        # from the messages; the model still gets the filtered candidates with their titles.
        mine = people_of.get(conv) or set()
        peers = sorted(((convs[c][-1]["date"] or "")[:10], c) for c, ppl in people_of.items() if c != conv and mine & ppl)[-4:]
        key = [related, peers] if peers else related
        rhash = hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest()[:12]
        # The owner wrote last and his words look like "I'll ..." (promises.py): the model judges the promise.
        owed = msgs[-1]["from_addr"] == me and promises.shortlist(msgs, me)
        sig = PROMPT_VERSION + ":" + rhash + ":" + mhash + (":p" if owed else "")
        old = conn.execute("SELECT sig, state, later_until, last_date FROM topics WHERE id=?", (tid,)).fetchone()
        last, last_in = msgs[-1], inbound[-1]
        you_last = last["from_addr"] == me
        waiting = _working_days_since(last["date"]) if you_last else 0
        nudge_due = you_last and waiting >= cfg["nudge_days"]
        base = {"sender": last_in["from_addr"], "last_date": last["date"], "reply_to": last_in["id"], "sig": sig,
                "updated": now_iso()}
        if old and old["sig"] == sig and not (nudge_due and old["state"] == "waiting"):
            continue
        # New mail = a message newer than the last one this topic knew. Older mail brought in to complete the thread
        # (sources.complete_outlook_threads) changes mhash and re-triages, but never reopens a closed topic.
        new_mail = not old or (last["date"] or "") > (old["last_date"] or "")
        state = "open" if (new_mail and not you_last) or not old else old["state"]  # new mail puts it back in the list
        if nudge_due and state in ("waiting", "approved"):
            state = "open"  # nobody answered in time: back in the list with a nudge
        if you_last and not nudge_due and not owed:
            _upsert(conn, tid, acct, conv, dict(base, title=last["subject"] or "(no subject)", who=last_in["from_name"],
                                                need="none", state="waiting", noise=0, private=0))
            promises.store(conn, tid, None)  # he wrote again with no promise in it: whatever he owed is settled
            continue
        labels = json.loads(last_in["labels"] or "[]")
        subject = last_in["subject"] or ""
        if (_matches(last_in["from_addr"] + " " + last_in["from_name"], cfg["always_aside"]) or last_in["from_addr"] in muted
                or "CATEGORY_PROMOTIONS" in labels or "CATEGORY_SOCIAL" in labels):
            _upsert(conn, tid, acct, conv, dict(base, title=subject or "(no subject)", who=last_in["from_name"], need="none",
                                                noise=1, private=0, state=state, summary=None, draft=None))
            continue
        if re.search(r"(?<!\w)(" + "|".join(map(re.escape, cfg["private_words"])) + r")(?!\w)", subject, re.I):
            _upsert(conn, tid, acct, conv, dict(
                base, title=f"{last_in['from_name'] or last_in['from_addr']} sent a CV or an application", who=last_in["from_name"],
                need="read", urgency=1, importance=2, noise=0, private=1, state=state, draft=None,
                summary="This looks like a CV or a job application, so it was not sent to any model. Read it in the mailbox.",
                facts=json.dumps([subject[:60]])))
            continue
        batch.append({
            "id": tid, "conv": conv, "base": base, "state": state, "owed": owed, "nudge_due": nudge_due,
            "made": last["date"] if you_last else "",
            "item": {
                "id": tid, "mailbox": acct, "source": source_of(conv), "subject": subject, "you_wrote_last": you_last,
                "thread_language": thread_language([m["body"] for m in msgs]),
                "related_elsewhere": related,
                "maybe_same_matter": maybe,
                "days_waiting": waiting if you_last else None,
                **({"owner_promise_check": True} if owed else {}),
                "messages": [{"from": f"{m['from_name']} <{m['from_addr']}>", "is_owner": m["from_addr"] == me,
                              "date": m["date"][:16], "recipients": len(json.loads(m["rcpts"] or "[]")),
                              "has_attachments": bool(m["has_att"]), "text": text[:3000]}
                             for m, text in _thread_view(msgs)],
            },
        })
    conn.commit()
    if not batch:
        log(f"[triage] {acct}: nothing new")
        return 0
    convs_by_id = convs
    groups = [batch[i:i + 6] for i in range(0, len(batch), 6)]
    today = datetime.date.today().isoformat()
    system = SYSTEM + f"\n\nToday is {today}. About the owner: {owner_about}"

    def call(group):
        prompt = json.dumps([g["item"] for g in group], ensure_ascii=False)
        try:
            return group, parse_json(ask_model(prompt, system))
        except Exception as err:
            log(f"[triage] a batch of {len(group)} failed: {err}")
            return group, []

    done = 0
    to_merge = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        for group, answers in pool.map(call, groups):
            by_id = {a.get("id"): a for a in answers if isinstance(a, dict)}
            for g in group:
                a = by_id.get(g["id"])
                if not a:
                    continue
                need = a.get("need") if a.get("need") in ("reply", "decide", "act", "seize", "read", "none") else "read"
                state = g["state"]
                # 2026-10-23: a re-triage closed the ERP card and wiped the draft its chat had written for the architect 17 min
                # earlier, while he was typing on it. A card the owner has talked on keeps its draft and stays open.
                worked = conn.execute("SELECT 1 FROM chat WHERE topic=? AND who='me' LIMIT 1", (g["id"],)).fetchone()
                kept = conn.execute("SELECT draft FROM topics WHERE id=?", (g["id"],)).fetchone()
                draft = a.get("draft") or (kept[0] if worked and kept else None)
                if need == "read" and state == "open" and not worked and not any(m["unread"] for m in convs_by_id[g["conv"]]):
                    state = "done"  # only to read, and the owner had already read it in the mailbox
                promise = promises.clean(a.get("promise"), g["made"] or (g["base"]["last_date"] or ""))
                if g["owed"] and not g["nudge_due"]:
                    # Checked only for a promise: it stays out of the list, waiting, until its day passes (promises.py).
                    need, state, draft = ("act" if promise else "none"), "waiting", (kept[0] if kept else None)
                _upsert(conn, g["id"], acct, g["conv"], dict(
                    g["base"], title=(a.get("title") or g["item"]["subject"])[:120], who=a.get("who") or "", need=need,
                    deadline=a.get("deadline"), urgency=int(a.get("urgency") or 0), importance=int(a.get("importance") or 0),
                    summary=a.get("summary") or "", facts=json.dumps(a.get("facts") or [], ensure_ascii=False),
                    draft=draft, draft_lang=a.get("draft_lang") or "",
                    options=json.dumps(a.get("options"), ensure_ascii=False) if a.get("options") else None, choice=None,
                    noise=1 if need == "none" else 0, private=0,
                    state=state))
                promises.store(conn, g["id"], promise)
                done += 1
                if a.get("same_as") in {x["id"] for x in g["item"]["maybe_same_matter"]}:
                    to_merge.append((g["conv"], conv_of_tid[a["same_as"]]))
            conn.commit()
    log(f"[triage] {acct}: {done} of {len(batch)} threads triaged by the model")
    joined = 0
    for conv, other in to_merge:
        newer = (convs[other][-1]["date"] or "") >= (convs[conv][-1]["date"] or "")
        joined += merge.merge(conn, acct, conv if newer else other, other if newer else conv, "the model: same matter")
    if joined:
        conn.commit()
        merge.apply(conn, acct)
        if _depth == 0:  # read each joined matter whole, once, in this same run
            done += triage(conn, acct, me, cfg, owner_about, _depth=1)
    return done
