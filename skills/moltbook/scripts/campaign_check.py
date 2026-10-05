#!/usr/bin/env python3
"""Mechanical checks for the Inbound Marketing Campaign cron (skills/moltbook/CAMPAIGN.md).

  measure [--write-state]  visitor numbers from their sources, week over week
  preflight --kind comment|post --text-file F [--evidence "phrase=>path" ...] [--allow-repo-link]
                           refuses a Moltbook text that breaks guardrails 1-2 (exit 1)
  links                    HTTP-checks every URL in our SERVED Moltbook content

Why this exists: on 2026-09-12 an audit of 37 cron-posted items found 20 with invented features,
11 dead links, and a report claiming "0 spam" that was wrong. The playbook's rules were prose;
these are the parts of them a script can enforce.

Config (environment; every source is optional and reported as "configured": false when unset):
  MOLTBOOK_AGENT_NAME         our Moltbook handle (else "username" in the Moltbook credentials file)
  CAMPAIGN_STATE_DIR          where state lives (default ~/.openclaw/workspace/memory/moltbook-campaign)
  CAMPAIGN_GH_REPO            GitHub repo to measure and protect, as owner/name
  CAMPAIGN_REPO_DIR           local checkout of that repo (for evidence and link checks without HTTP)
  CAMPAIGN_REPO_REF           git ref that counts as "published" (default origin/main)
  CAMPAIGN_SITE_HOST          your site's host; its links must carry utm_source=moltbook
  CAMPAIGN_GA4_FILE           JSON with GA4 numbers (shape in CAMPAIGN.md)
  CAMPAIGN_CLAWHUB_CATALOG    JSON with ClawHub downloads per skill/plugin
  CAMPAIGN_CLAWHUB_SNAPSHOTS  directory of dated catalog snapshots (YYYY-MM-DD.json) for week deltas
  CAMPAIGN_KNOWN_FALSE        JSON list of {"pattern", "why"} claims proven false
                              (default $CAMPAIGN_STATE_DIR/known-false.json; see references/known-false.example.json)
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import moltbook as mb  # noqa: E402


def _env_path(name, default=None):
    v = os.environ.get(name) or default
    return Path(v).expanduser() if v else None


STATE_DIR = _env_path("CAMPAIGN_STATE_DIR", "~/.openclaw/workspace/memory/moltbook-campaign")
STATE = STATE_DIR / "inbound-campaign-state.json"
GA4_FILE = _env_path("CAMPAIGN_GA4_FILE")
CATALOG = _env_path("CAMPAIGN_CLAWHUB_CATALOG")
SNAP_DIR = _env_path("CAMPAIGN_CLAWHUB_SNAPSHOTS")
REPO = _env_path("CAMPAIGN_REPO_DIR")
REPO_REF = os.environ.get("CAMPAIGN_REPO_REF") or "origin/main"
REPO_BRANCH = REPO_REF.rsplit("/", 1)[-1]
GH_REPO = (os.environ.get("CAMPAIGN_GH_REPO") or "").strip("/")
SITE_HOST = (os.environ.get("CAMPAIGN_SITE_HOST") or "").strip("/")
KNOWN_FALSE_FILE = _env_path("CAMPAIGN_KNOWN_FALSE") or STATE_DIR / "known-false.json"
FARM_LIFETIME_COMMENTS = 1000
FARM_COMMENTS_PER_DAY = 100
ZERO_VISIT_RUNS_BEFORE_HALVING = 4

URL_RE = re.compile(r"(?:https?://|(?<![\w/.])(?:www\.)?github\.com/)[^\s)\]>\"'`]+")


def load_known_false():
    """Claims an audit proved false, as (pattern, why) pairs matched case-insensitively.
    Kept in a data file so each deployment lists the false claims about ITS project."""
    if not KNOWN_FALSE_FILE.is_file():
        return []
    return [(row["pattern"], row["why"]) for row in json.loads(KNOWN_FALSE_FILE.read_text())]


FIRST_PERSON_RE = re.compile(r"\b(?:[Ww]e|[Oo]urs?|[Mm]y|I)\b")
OPINION_RE = re.compile(r"\b(I would|I'd|I think|I suspect|I'm curious|my hunch|we should|let's)\b", re.I)


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


API_ERRORS = []  # every Moltbook call that failed; a non-empty list makes measure/links exit 2


def api(method, path, params=None):
    """moltbook.call returns {"_error": ...} instead of raising (seen 2026-09-14: a self-signed
    certificate from a network middlebox). Swallowing that turned an outage into "0 replies, 0 flags"."""
    try:
        res = mb.call(method, path, params=params)
    except (SystemExit, Exception) as e:
        res = {"_error": str(e)}
    if isinstance(res, dict) and ("_error" in res or "error" in res and len(res) == 1):
        API_ERRORS.append(f"{method} {path}: {str(res.get('_error') or res.get('error'))[:160]}")
    return res if isinstance(res, dict) else {}


def me():
    try:
        return mb.agent_name()
    except SystemExit as e:
        API_ERRORS.append(f"agent handle: {e}")
        return None


def blocked_hint():
    joined = " ".join(API_ERRORS)
    if "self-signed" in joined or "CERTIFICATE_VERIFY_FAILED" in joined:
        return ("Moltbook TLS failed with a self-signed certificate: a network web filter (for example a "
                "workplace firewall's DNS/URL block page) is answering for www.moltbook.com. "
                "Do NOT bypass it; skip Moltbook steps and run them from another network.")
    return "Moltbook API calls failed; skip Moltbook steps this run and report the errors."


def gh_api(path):
    try:
        r = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"error": f"gh: {type(e).__name__}: {e}"[:200]}
    if r.returncode:
        return {"error": r.stderr.strip()[:200]}
    return json.loads(r.stdout)


def on_ref(path):
    """True when <path> exists on CAMPAIGN_REPO_REF in the local checkout."""
    if not REPO:
        return False
    return subprocess.run(["git", "-C", str(REPO), "cat-file", "-e", f"{REPO_REF}:{path}"],
                          capture_output=True).returncode == 0


def http_status(url):
    try:
        from curl_cffi import requests as cr  # some sites block plain HTTP clients by TLS fingerprint
        return cr.get(url, impersonate="chrome124", timeout=25, allow_redirects=True).status_code
    except ImportError:
        pass
    except Exception as e:
        return f"ERR {type(e).__name__}"
    import urllib.request, urllib.error
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return f"ERR {type(e).__name__}"


def extract_urls(text):
    urls = []
    for u in URL_RE.findall(text or ""):
        u = u.rstrip(".,;:!?—–")
        urls.append(u if u.startswith("http") else "https://" + u)
    return urls


def url_status(url, cache):
    if url in cache:
        return cache[url]
    m = None
    if GH_REPO and REPO:
        m = re.search(r"github\.com/" + re.escape(GH_REPO) + r"/(?:blob|tree)/" + re.escape(REPO_BRANCH)
                      + r"/(.+?)/?(?:[?#].*)?$", url)
    cache[url] = (200 if on_ref(m.group(1)) else 404) if m else http_status(url)
    return cache[url]


def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def walk(comments):
    for c in comments:
        yield c
        yield from walk(c.get("replies") or [])


def find_in_thread(post_id, comment_id):
    """The /agents/<name>/comments list is a stale cache for older comments; the thread is truth."""
    for sort in ("new", "old", "best"):
        tree = api("GET", f"/posts/{post_id}/comments", {"sort": sort, "limit": 100}).get("comments", [])
        hit = next((c for c in walk(tree) if c.get("id") == comment_id), None)
        if hit:
            return hit
    return None


# ---------------------------------------------------------------- measure
def measure_github():
    if not GH_REPO:
        return {"configured": False, "note": "set CAMPAIGN_GH_REPO=owner/name", "moltbook_visits": None}
    views = gh_api(f"repos/{GH_REPO}/traffic/views")
    refs = gh_api(f"repos/{GH_REPO}/traffic/popular/referrers")
    repo = gh_api(f"repos/{GH_REPO}")
    referrers = {} if isinstance(refs, dict) else {r["referrer"]: {"count": r["count"], "uniques": r["uniques"]} for r in refs}
    errors = [x["error"] for x in (views, repo) if isinstance(x, dict) and "error" in x] + ([refs["error"]] if isinstance(refs, dict) and "error" in refs else [])
    return {
        "as_of": now_iso(), "window": "rolling 14 days (GitHub traffic API)",
        "views": views.get("count"), "uniques": views.get("uniques"),
        "stars": repo.get("stargazers_count"), "forks": repo.get("forks_count"),
        "referrers": referrers,
        # A failed referrers call is missing data, not zero visits.
        "moltbook_visits": None if isinstance(refs, dict) else sum(v["count"] for k, v in referrers.items() if "moltbook" in k.lower()),
        "errors": errors,
    }


def measure_ga4():
    if not GA4_FILE or not GA4_FILE.is_file():
        return {"configured": False, "note": "set CAMPAIGN_GA4_FILE to a GA4 export (shape in CAMPAIGN.md)", "moltbook_visits": None}
    e = json.loads(GA4_FILE.read_text())
    g = e.get("ga4", {})
    as_of = e.get("last_run")
    sources = g.get("top_sources_7d") or ""
    m = re.search(r"moltbook[^;]*?(\d+)v", sources, re.I)
    stale = bool(as_of) and dt.date.fromisoformat(as_of[:10]) < dt.date.today() - dt.timedelta(days=1)
    return {
        "as_of": as_of, "stale": stale, "window": "7 days",
        "sessions_7d": (g.get("g7d") or {}).get("sessions"), "users_7d": (g.get("g7d") or {}).get("users"),
        "views_7d": (g.get("g7d") or {}).get("views"), "sources_7d": sources,
        "top_landing_7d": g.get("top_landing_7d"),
        "moltbook_visits": int(m.group(1)) if m else 0,
    }


def _clawhub_totals(doc):
    # catalog:   {"skills": {slug: {downloads, installs}}, "plugins": {...}}
    # snapshots: {"skills": [{slug, dls, inst}, ...]}
    per = {}
    for kind in ("skills", "plugins"):
        block = doc.get(kind) or {}
        rows = block.items() if isinstance(block, dict) else ((r.get("slug"), r) for r in block if isinstance(r, dict))
        for slug, v in rows:
            dls = v.get("downloads", v.get("dls")) if isinstance(v, dict) else None
            if isinstance(dls, (int, float)):
                per[f"{kind[:-1]}:{slug}"] = (dls, v.get("installs", v.get("inst", 0)) or 0)
    return per


def measure_clawhub():
    if not CATALOG or not CATALOG.is_file():
        return {"configured": False, "note": "set CAMPAIGN_CLAWHUB_CATALOG to a ClawHub catalog JSON"}
    cur_doc = json.loads(CATALOG.read_text())
    cur = _clawhub_totals(cur_doc)
    as_of = cur_doc.get("as_of") or ""
    out = {"as_of": as_of, "downloads_total": sum(d for d, _ in cur.values()),
           "installs_total": sum(i for _, i in cur.values()), "items": len(cur)}
    if not SNAP_DIR or not SNAP_DIR.is_dir():
        out["week_delta_downloads"] = None
        out["week_delta_note"] = "set CAMPAIGN_CLAWHUB_SNAPSHOTS to a directory of YYYY-MM-DD.json snapshots"
        return out
    target = (dt.date.fromisoformat(as_of[:10]) if as_of else dt.date.today()) - dt.timedelta(days=7)
    all_snaps = sorted(SNAP_DIR.glob("????-??-??.json"))
    snaps = [p for p in all_snaps if dt.date.fromisoformat(p.stem) <= target]
    if not snaps:
        # Snapshots are younger than a week: compare with the oldest one and say how many days it spans.
        older = [p for p in all_snaps if as_of and p.stem < as_of[:10]]
        if not older:
            out["week_delta_downloads"] = None
            out["week_delta_note"] = f"no snapshot older than {as_of[:10]} in {SNAP_DIR}"
            return out
        snaps = older[:1]
    base_path = snaps[-1]
    out["delta_span_days"] = (dt.date.fromisoformat(as_of[:10]) - dt.date.fromisoformat(base_path.stem)).days if as_of else None
    base = _clawhub_totals(json.loads(base_path.read_text()))
    # Only items present in BOTH files: a newly listed item's whole count is not a week of growth.
    common = [k for k in cur if k in base]
    deltas = {k: cur[k][0] - base[k][0] for k in common}
    out.update({
        "week_baseline": base_path.stem,
        "week_delta_downloads": sum(deltas.values()),
        "items_compared": len(common),
        "new_items_since_baseline": sorted(k for k in cur if k not in base),
        "top_gainers": sorted(({"item": k, "downloads": v} for k, v in deltas.items() if v > 0),
                              key=lambda x: -x["downloads"])[:5],
    })
    return out


def _author_profile(name, cache):
    if name not in cache:
        a = api("GET", "/agents/profile", {"name": name}).get("agent", {})
        created = a.get("created_at")
        days = max(1, (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(created.replace("Z", "+00:00"))).days) if created else None
        n = a.get("comments_count") or 0
        per_day = round(n / days, 1) if days else None
        cache[name] = {"lifetime_comments": n, "comments_per_day": per_day,
                       "farm": n > FARM_LIFETIME_COMMENTS or (per_day or 0) > FARM_COMMENTS_PER_DAY}
    return cache[name]


def measure_moltbook(since):
    name_me = me()
    me_doc = api("GET", "/agents/me")
    agent = me_doc.get("agent", me_doc)
    since_dt = dt.datetime.fromisoformat(since) if since else dt.datetime.now().astimezone() - dt.timedelta(days=7)
    notes, cursor = [], None
    for _ in range(5):
        d = api("GET", "/notifications", {"cursor": cursor} if cursor else None)
        batch = d.get("notifications", [])
        notes += batch
        cursor = d.get("next_cursor")
        oldest = min((n.get("createdAt") for n in batch), default=None)
        if not d.get("has_more") or not cursor or (oldest and dt.datetime.fromisoformat(oldest.replace("Z", "+00:00")) < since_dt):
            break
    profiles, replies = {}, []
    for n in notes:
        created = dt.datetime.fromisoformat(n["createdAt"].replace("Z", "+00:00"))
        if created < since_dt or not n.get("relatedCommentId") or not n.get("relatedPostId"):
            continue
        c = find_in_thread(n["relatedPostId"], n["relatedCommentId"])
        name = ((c or {}).get("author") or {}).get("name")
        if not name or name == name_me:
            continue
        p = _author_profile(name, profiles)
        replies.append({"author": name, "farm": p["farm"], "lifetime_comments": p["lifetime_comments"],
                        "thread": (n.get("post") or {}).get("title", "")[:80], "at": n["createdAt"][:16]})
    recent_cut = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=14)
    mine = api("GET", f"/agents/{name_me}/comments", {"limit": 100}).get("comments", []) if name_me else []
    flagged = [{"id": c["id"][:8], "at": c["created_at"][:16]} for c in mine
               if c.get("is_spam") and dt.datetime.fromisoformat(c["created_at"].replace("Z", "+00:00")) >= recent_cut]
    return {
        "as_of": now_iso(), "agent": name_me, "replies_since": since_dt.isoformat(timespec="seconds"),
        "karma": agent.get("karma"), "comments": agent.get("comments_count"),
        "posts": agent.get("posts_count"), "followers": agent.get("follower_count"),
        "replies_total": len(replies), "replies_non_farm": [r for r in replies if not r["farm"]],
        "replies_farm_count": sum(r["farm"] for r in replies),
        "spam_flagged_recent": len(flagged), "spam_flagged_recent_items": flagged,
    }


def cmd_measure(a):
    state = load_state()
    out = {"measured_at": now_iso(), "github": measure_github(), "ga4": measure_ga4(),
           "clawhub": measure_clawhub(), "moltbook": measure_moltbook(state.get("last_run"))}
    measured = [x["moltbook_visits"] for x in (out["github"], out["ga4"]) if x.get("moltbook_visits") is not None]
    visits = sum(measured) if measured else None
    hist = state.get("referrers_history", [])
    streak = 0
    for row in reversed(hist):
        v = row.get("moltbook_visits", 0)
        if v is None:
            continue  # an unmeasured run neither extends nor breaks the streak
        if v == 0:
            streak += 1
        else:
            break
    if visits is not None:
        streak = streak + 1 if visits == 0 else 0
    out["channel_rule"] = {
        "moltbook_visits_this_run": visits, "consecutive_zero_visit_runs": streak,
        "halve_moltbook_volume": streak >= ZERO_VISIT_RUNS_BEFORE_HALVING,
        "moltbook_comment_cap": 1 if streak >= ZERO_VISIT_RUNS_BEFORE_HALVING else 3,
    }
    if visits is None:
        out["channel_rule"]["note"] = ("no visit source measured (configure CAMPAIGN_GH_REPO and/or CAMPAIGN_GA4_FILE): "
                                       "this run does not count toward the channel rule")
    if a.write_state:
        gh, ga, ch = out["github"], out["ga4"], out["clawhub"]
        state.setdefault("referrers_history", []).append({
            "date": out["measured_at"][:10],
            "github_views_14d": gh.get("views"), "github_uniques_14d": gh.get("uniques"),
            "github_referrers": gh.get("referrers"), "stars": gh.get("stars"), "forks": gh.get("forks"),
            "ga4_sessions_7d": ga.get("sessions_7d"), "ga4_sources_7d": ga.get("sources_7d"), "ga4_as_of": ga.get("as_of"),
            "clawhub_downloads_total": ch.get("downloads_total"), "clawhub_week_delta": ch.get("week_delta_downloads"),
            "moltbook_visits": visits, "moltbook_non_farm_replies": len(out["moltbook"]["replies_non_farm"]),
            "moltbook_spam_flagged_recent": out["moltbook"]["spam_flagged_recent"],
            "moltbook_measured": not API_ERRORS,
        })
        state.setdefault("drafts_offered", {})
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(state, indent=1, ensure_ascii=False) + "\n")
        out["state_written"] = str(STATE)
    if API_ERRORS:
        out["moltbook"]["unmeasured"] = True
        out["moltbook"]["note"] = "Moltbook API unreachable: its zeros and nulls above are MISSING, not zero. Report them as unmeasured; make no Moltbook writes this run."
        out["api_errors"] = API_ERRORS[:10]
        out["blocked_hint"] = blocked_hint()
    print(json.dumps(out, indent=1, ensure_ascii=False))
    sys.exit(2 if API_ERRORS else 0)


# ---------------------------------------------------------------- preflight
NUMBER_WORDS = {"a": "1", "an": "1", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
                "seven": "7", "eight": "8", "nine": "9", "ten": "10", "twelve": "12", "fifteen": "15",
                "twenty": "20", "thirty": "30", "forty": "40", "fifty": "50", "sixty": "60", "hundred": "100"}
UNIT_RE = r"(?:seconds?|s|minutes?|mins?|hours?|days?|weeks?|months?|years?|%|percent|x|times|spawns?|runs?|comments?|posts?|items?|files?|links?|downloads?|visits?|lines?)"
# Long words so common in agent notes that sharing them proves nothing about topic.
EVIDENCE_STOPWORDS = {
    "because", "before", "between", "cannot", "change", "changed", "should", "without", "another", "already",
    "always", "anything", "everything", "nothing", "something", "itself", "whether", "rather", "really",
    "memory", "session", "sessions", "agent", "agents", "comment", "comments", "record", "records", "thread",
    "written", "writes", "running", "result", "results", "though", "through", "within", "during", "around",
}
DETAIL_RE = re.compile(
    r"\b(?:\d[\d,.]*|" + "|".join(k for k in NUMBER_WORDS if len(k) > 2) + r"|a|an)[ -]" + UNIT_RE + r"\b"
    r"|\b\d[\d,.]*%|\b\d{2,}[\d,.]*\b", re.I)


def _ref_path(path):
    """'<ref>:<path>' (e.g. origin/main:README.md) -> '<path>', else None."""
    prefix = REPO_REF + ":"
    return path[len(prefix):] if path.startswith(prefix) else None


def _evidence_text(path):
    rp = _ref_path(path)
    if rp is not None:
        if not REPO:
            return ""
        r = subprocess.run(["git", "-C", str(REPO), "show", f"{REPO_REF}:{rp}"], capture_output=True, text=True)
        return r.stdout if r.returncode == 0 else ""
    p = Path(path).expanduser()
    return p.read_text(errors="replace") if p.is_file() else ""


def _details(sentence):
    """Numbers and durations a reader would take as measured facts: '30 minutes', 'a month', '55%', '159'."""
    out = []
    for m in DETAIL_RE.finditer(sentence):
        d = m.group(0).strip().casefold()
        if re.fullmatch(r"(a|an) (spawns?|runs?|comments?|posts?|items?|files?|links?|downloads?|visits?|lines?|x|s)", d):
            continue  # "a comment", "a file": not a quantity
        out.append(d)
    return out


def _detail_forms(detail):
    """Equivalent spellings: 'thirty minutes' ~ '30 minutes' ~ '30-minute' ~ '30 min'; 'a month' ~ '1 month'."""
    parts = re.split(r"[ -]", detail, maxsplit=1)
    num = NUMBER_WORDS.get(parts[0], parts[0])
    nums = {parts[0], num} | ({"a", "an", "one"} if num == "1" else set())
    if len(parts) == 1:
        return {detail, num, num.replace(",", "")}
    unit = parts[1].rstrip("s") if len(parts[1]) > 2 else parts[1]
    units = {unit, unit + "s", {"minute": "min", "second": "sec", "percent": "%"}.get(unit, unit)}
    return {f"{n}{sep}{u}" for n in nums for u in units for sep in (" ", "-", "")}


def cmd_preflight(a):
    text = Path(a.text_file).read_text()
    failures, cache = [], {}
    urls = extract_urls(text)
    repo_url = f"github.com/{GH_REPO}" if GH_REPO else None
    for u in urls:
        if repo_url and f"{repo_url}/blob/" in u:
            failures.append(f"blob link inside the repo (files move; a docs folder vanished 2026-09-07 and killed 11 links): {u}")
            continue
        st = url_status(u, cache)
        if st != 200:
            failures.append(f"link returns {st}: {u}")
        if SITE_HOST and SITE_HOST in u and "utm_source=moltbook" not in u:
            failures.append(f"{SITE_HOST} link without ?utm_source=moltbook&utm_medium={a.kind}: {u}")
        if a.kind == "comment" and repo_url and repo_url in u and not a.allow_repo_link:
            failures.append(f"repo link in a comment (default is no link; --allow-repo-link only when someone asked): {u}")
    for pattern, why in load_known_false():
        m = re.search(pattern, text, re.I)
        if m:
            failures.append(f"known-false claim ({why}): \"{m.group(0)[:100]}\"")
    evidence = []
    for e in a.evidence or []:
        if "=>" not in e:
            failures.append(f"--evidence must be \"phrase=>path\": {e}")
            continue
        phrase, path = (x.strip() for x in e.split("=>", 1))
        rp = _ref_path(path)
        ok = on_ref(rp) if rp is not None else Path(path).expanduser().exists()
        if not ok:
            failures.append(f"evidence path does not exist: {path}" + (" (CAMPAIGN_REPO_DIR is not set)" if rp is not None and not REPO else ""))
        evidence.append((phrase.casefold(), path, ok))
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]
    claims = [s for s in sentences if FIRST_PERSON_RE.search(s) and not OPINION_RE.search(s)]
    uncovered = [s for s in claims if not any(p and p in s.casefold() and ok for p, _, ok in evidence)]
    for s in uncovered:
        failures.append(f"first-person claim with no --evidence: \"{s[:110]}\"")
    # An existing file is not a receipt: it must also talk about what the sentence claims.
    links = []
    for s in claims:
        for phrase, path, ok in evidence:
            if not (ok and phrase and phrase in s.casefold()):
                continue
            body = _evidence_text(path).casefold()
            words = {w for w in re.findall(r"[a-z][a-z-]{5,}", s.casefold()) if w not in EVIDENCE_STOPWORDS}
            shared = sorted(w for w in words if w in body)
            links.append({"claim": s[:80], "evidence": path, "shared_words": shared[:8]})
            if len(shared) < 2:
                failures.append(f"evidence does not mention the claim (shared words: {shared}): {path} ← \"{s[:90]}\"")
    # A path that exists is not a path that says it. On 2026-09-14 a comment passed with "for a month"
    # although its evidence file never gave a duration. Numbers and durations must appear in the cited text.
    for s in claims:
        paths = [path for p, path, ok in evidence if p and p in s.casefold() and ok]
        if not paths:
            continue
        corpus = " ".join(_evidence_text(path) for path in paths).casefold()
        for detail in _details(s):
            if not any(form in corpus for form in _detail_forms(detail)):
                failures.append(f"detail \"{detail}\" is not in the cited evidence ({', '.join(paths)}): \"{s[:90]}\"")
    verdict = "PREFLIGHT PASS" if not failures else f"PREFLIGHT FAIL ({len(failures)})"
    print(json.dumps({"verdict": verdict, "kind": a.kind, "chars": len(text), "urls": urls,
                      "first_person_claims": len(claims), "covered": len(claims) - len(uncovered),
                      "failures": failures}, indent=1, ensure_ascii=False))
    sys.exit(0 if not failures else 1)


# ---------------------------------------------------------------- links
def cmd_links(a):
    items, cursor = [], None
    for _ in range(5):
        d = api("GET", "/agents/me/comments", {"limit": 100, "cursor": cursor} if cursor else {"limit": 100})
        items += d.get("comments", [])
        cursor = d.get("next_cursor")
        if not d.get("has_more") or not cursor:
            break
    cache, broken, checked = {}, {}, 0
    for c in items:
        if not extract_urls(c.get("content")):
            continue
        post = c.get("post") or {}
        served = find_in_thread(post.get("id") if isinstance(post, dict) else post, c["id"])
        for u in extract_urls((served or c).get("content")):
            checked += 1
            st = url_status(u, cache)
            if st != 200:
                broken.setdefault(u, {"status": st, "items": []})["items"].append(f"comment:{c['id'][:8]}")
    name_me = me()
    for p in (api("GET", "/agents/profile", {"name": name_me}).get("recentPosts") or []) if name_me else []:
        pd = api("GET", f"/posts/{p['id']}")
        pd = pd.get("post", pd)
        if pd.get("is_deleted"):
            continue
        for u in extract_urls(pd.get("content")):
            checked += 1
            st = url_status(u, cache)
            if st != 200:
                broken.setdefault(u, {"status": st, "items": []})["items"].append(f"post:{p['id'][:8]}")
    report = {"as_of": now_iso(), "comments_scanned": len(items), "urls_checked": checked,
              "distinct_urls": len(cache), "broken": broken}
    if API_ERRORS:
        report.update({"incomplete": True, "api_errors": API_ERRORS[:10], "blocked_hint": blocked_hint()})
    print(json.dumps(report, indent=1, ensure_ascii=False))
    sys.exit(2 if API_ERRORS else 0)


def main():
    p = argparse.ArgumentParser(prog="campaign_check", description=__doc__.splitlines()[0])
    s = p.add_subparsers(dest="cmd", required=True)
    m = s.add_parser("measure")
    m.add_argument("--write-state", action="store_true")
    m.set_defaults(fn=cmd_measure)
    f = s.add_parser("preflight")
    f.add_argument("--kind", choices=["comment", "post"], required=True)
    f.add_argument("--text-file", required=True)
    f.add_argument("--evidence", action="append", help=f'"phrase from the sentence=>local path or {REPO_REF}:<path>"')
    f.add_argument("--allow-repo-link", action="store_true")
    f.set_defaults(fn=cmd_preflight)
    s.add_parser("links").set_defaults(fn=cmd_links)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
