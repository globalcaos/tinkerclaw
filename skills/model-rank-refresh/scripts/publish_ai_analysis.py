#!/usr/bin/env python3
"""
publish_ai_analysis.py — push the exported panels to thetinkerzone.com and
rewrite ONLY the machine-owned regions of the AI-analysis page.

FORK 2026-09-04 (the architect): "only one copy, no duplicates, no maintenance hell."
The website holds the sole copy of the chart + dossier; this republishes it.

Contract with the page:
  * The post is found by SLUG (default 'ai-analysis'), never by a hardcoded id.
  * Only the text between <!-- AI-ANALYSIS:X:START --> and :END --> is touched.
    Everything else is the architect's prose and is never rewritten. If a marker pair is
    missing the run FAILS rather than guessing where to write.
  * Fails CLOSED: any upload error aborts before the post is edited, so a bad
    run leaves yesterday's good page standing.

WP transport must be curl_cffi (Chrome impersonation) — thetinkerzone is behind
Cloudflare, which 403s plain requests/curl on the TLS fingerprint.
"""
import json, os, re, sys, time, datetime

try:
    from curl_cffi import requests
except ImportError:
    sys.exit("FAIL curl_cffi is required (Cloudflare blocks plain requests)")

SLUG = os.environ.get("AI_ANALYSIS_SLUG", "ai-analysis")
KEEP = int(os.environ.get("AI_ANALYSIS_KEEP", "2"))   # generations of artifacts to retain
OUT  = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.openclaw/workspace/artifacts/ai-analysis")
DRY  = "--dry-run" in sys.argv

ENV = os.path.expanduser("~/.openclaw/workspace/skills/wordpress-ultimate/.env")
cfg = {}
for line in open(ENV):
    line = line.rstrip("\n")
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    cfg[k.strip()] = v
BASE = cfg["WP_URL"].rstrip("/")
AUTH = (cfg["WP_USER"], cfg["WP_APP_PASSWORD"].replace(" ", ""))

# FORK 2026-09-05 (the architect found the page 404ing; this script was ALSO failing to reach
# it). Cloudflare rate-limits the burst this script makes and answers with an interstitial
# — sometimes as 403, sometimes as a 200 whose body is "Just a moment..." HTML. The old
# code made a fresh connection per call and parsed every response as JSON, so a challenge
# surfaced either as `FAIL lookup 403` or, worse, as an orjson.JSONDecodeError traceback
# with no hint that the site had simply asked us to wait. Both happened within one minute
# on 2026-09-05, while the identical request by hand succeeded.
#
# Two changes: one SESSION so the clearance cookie is kept instead of thrown away after
# every call, and a bounded retry that recognises a challenge by its BODY as well as its
# status. Still fails closed — after the last attempt the caller sees the real response.
#
# The impersonation target is "chrome" and MUST STAY GENERIC. Pinning it to a version —
# "chrome124", which is the right answer for amazon.es — makes thetinkerzone's WAF reject
# the 3.2 MB post body with "Just a moment" on every attempt, while every GET still
# passes. That asymmetry (reads fine, one big write blocked) reads exactly like a
# body-size rule and is not one; it is the TLS fingerprint. Cost 20 minutes on 2026-09-05.
SESSION = requests.Session(impersonate="chrome")
RETRIES = 7  # 3+6+12+24+48+96s ~= 3 min of patience; CF sustained rate-limiting outlasts a 30s ceiling


def _is_challenge(r) -> bool:
    head = r.text[:500] if r.content else ""
    if "Just a moment" in head or "cf-browser-verification" in head:
        return True
    return r.status_code in (403, 429, 503) and head.lstrip().startswith("<")


def api(method, path, want_json: bool = False, **kw):
    """One WP REST call, retried past a Cloudflare interstitial.

    `want_json=True` also retries a 2xx whose body will not parse — a challenge served
    with a 200 is indistinguishable from success until you try to read it.
    """
    url = f"{BASE}/wp-json/wp/v2/{path}"
    r = None
    for attempt in range(RETRIES):
        r = SESSION.request(method, url, auth=AUTH, **kw)
        blocked = _is_challenge(r)
        if not blocked and want_json and r.status_code < 300:
            try:
                r.json()
            except Exception:
                blocked = True
        if not blocked:
            return r
        if attempt == RETRIES - 1:
            break
        wait = 3 * (2**attempt)
        print(f"[ai-analysis] cloudflare challenge on {method} {path} "
              f"(http={r.status_code}) — retry {attempt + 1}/{RETRIES - 1} in {wait}s",
              file=sys.stderr)
        time.sleep(wait)
    return r


# ---- SSH + WP-CLI transport (FORK 2026-09-23) --------------------------------------
# the architect 2026-09-23: "I know you had trouble connecting to the ssh or updating the page
# through wordpress, but try again". The REST path lost two mornings running: 09-23
# Cloudflare challenged every lookup for 3 minutes, 09-22 WordPress served a blank. SSH
# goes to the HostGator IP directly — Cloudflare never sees it — and the host ships
# WP-CLI, so read, write AND server-side render all work without the WAF. REST stays as
# the fallback for the day the host key rotates again (it did on 2026-09-09).
# The key comes from TZ_SSH_KEY (environment, else the same .env as the WP creds). Unset =
# no -i: ssh falls back to its own ~/.ssh/config / agent, and a failed probe drops to REST.
SSH_KEY  = os.path.expanduser(os.environ.get("TZ_SSH_KEY") or cfg.get("TZ_SSH_KEY", "").strip())
SSH_DEST = os.environ.get("TZ_SSH_DEST", "msgqrrte@108.167.183.48")
SSH_PORT = os.environ.get("TZ_SSH_PORT", "2222")
WP_ROOT  = os.environ.get("TZ_WP_ROOT", "~/public_html/website_b3f2b1a0")
TRANSPORT = os.environ.get("AI_ANALYSIS_TRANSPORT", "auto")  # auto | ssh | rest

import subprocess, shlex

def ssh(cmd: str, stdin: bytes | None = None, timeout: int = 300) -> str:
    # ONE multiplexed connection for the whole run: HostGator drops a burst of fresh
    # handshakes at kex ("Connection closed by remote host", seen 2026-09-23 on the 2nd
    # call of a dry run). rc 255 = transport, not the remote command — retry that only.
    for attempt in range(5):
        r = subprocess.run(
            ["ssh", *(["-i", SSH_KEY, "-o", "IdentitiesOnly=yes"] if SSH_KEY else []),
             "-p", SSH_PORT, "-o", "BatchMode=yes",
             "-o", "ConnectTimeout=20", "-o", "ControlMaster=auto",
             "-o", "ControlPath=/tmp/tz-ssh-%C", "-o", "ControlPersist=300",
             SSH_DEST, f"cd {WP_ROOT} && {cmd}"],
            input=stdin, capture_output=True, timeout=timeout)
        if r.returncode != 255:
            break
        time.sleep(10 * (attempt + 1))
    if r.returncode != 0:
        raise RuntimeError(f"ssh rc={r.returncode}: {r.stderr.decode(errors='replace')[-300:]}")
    return r.stdout.decode("utf-8", errors="replace")

def ssh_ok() -> bool:
    try:
        return ssh("wp core version").strip() != ""
    except Exception as exc:
        print(f"[ai-analysis] ssh transport unavailable ({exc}) — falling back to REST", file=sys.stderr)
        return False

USE_SSH = TRANSPORT == "ssh" or (TRANSPORT == "auto" and ssh_ok())
print(f"[ai-analysis] transport: {'ssh+wp-cli' if USE_SSH else 'rest'}", file=sys.stderr)

def wp_find(slug):
    if USE_SSH:
        rows = json.loads(ssh(f"wp post list --post_type=post --name={shlex.quote(slug)} "
                              "--post_status=publish,draft,pending,private --fields=ID,post_status --format=json"))
        if not rows:
            sys.exit(f"FAIL no post with slug '{slug}'")
        pid = int(rows[0]["ID"])
        return pid, rows[0]["post_status"], ssh(f"wp post url {pid}").strip() or f"{BASE}/{slug}/"
    r = api("GET", f"posts?slug={slug}&status=publish,draft,pending,private&_fields=id,slug,status,link", want_json=True)
    if r.status_code != 200:
        sys.exit(f"FAIL lookup {r.status_code}: {r.text[:200]}")
    hits = r.json()
    if not hits:
        sys.exit(f"FAIL no post with slug '{slug}'")
    return hits[0]["id"], hits[0]["status"], hits[0]["link"]

def wp_raw(pid):
    if USE_SSH:
        return ssh(f"wp post get {pid} --field=post_content")
    rc = api("GET", f"posts/{pid}?context=edit&_fields=content", want_json=True)
    if rc.status_code != 200:
        sys.exit(f"FAIL read post {pid} {rc.status_code}: {rc.text[:200]}")
    try:
        return rc.json()["content"]["raw"]
    except Exception as exc:
        sys.exit(f"FAIL read post {pid} returned non-JSON ({exc}): {rc.text[:200]}")

def wp_update(pid, content):
    """Write the post; return what the site now SERVES for it (the_content, all filters)."""
    if USE_SSH:
        tmp = f"/tmp/ai-analysis-{pid}-{int(time.time())}.html"
        ssh(f"cat > {tmp}", stdin=content.encode("utf-8"))
        try:
            ssh(f"wp post update {pid} {tmp}")
        finally:
            ssh(f"rm -f {tmp}")
        return ssh(f"wp eval 'echo apply_filters(\"the_content\", get_post_field(\"post_content\", {pid}));'")
    up = api("POST", f"posts/{pid}", json={"content": content}, timeout=180)
    if up.status_code != 200:
        sys.exit(f"FAIL post update {up.status_code}: {up.text[:200]}")
    return up.json()["content"]["rendered"]


manifest = json.load(open(os.path.join(OUT, "manifest.json")))
fig  = manifest["figures"]
doss = manifest["dossier"]

# ---- 1. locate the page by slug -------------------------------------------
post_id, post_status, post_link = wp_find(SLUG)
raw = wp_raw(post_id)
for key in ("CHART", "DOSSIER", "FIGURES", "NOTES"):
    if f"<!-- AI-ANALYSIS:{key}:START -->" not in raw or f"<!-- AI-ANALYSIS:{key}:END -->" not in raw:
        sys.exit(f"FAIL marker pair AI-ANALYSIS:{key} missing from post {post_id}")

# ---- 2. read the two INLINE FRAGMENTS (fail closed) ------------------------
# FORK 2026-09-04 (the architect: "completely native, completely integrated, with no scrolling
# bars and using the full width of the page").
#
# This used to upload two standalone HTML files to the media library and point an
# <iframe> at each. That was a SECOND COPY of the artifact living beside the post —
# the exact duplication this pipeline exists to end — and every visual complaint
# traced to the iframe itself: a fixed-height box scrolls internally, it cannot exceed
# its column, and it carries its own dark <html>. So there is no upload and no media
# to prune any more: the fragment goes straight into the page.
parts = {}
for key, fname in (("chart", "chart.part.html"), ("dossier", "dossier.part.html")):
    src = os.path.join(OUT, fname)
    if not os.path.exists(src) or os.path.getsize(src) < 50_000:
        sys.exit(f"FAIL {src} missing or implausibly small — refusing to publish")
    body = open(src, encoding="utf-8").read()
    # The fragment is the whole contract: without its scope wrapper the panel CSS
    # would leak into the theme, and without its script it is a dead picture.
    # The scope wrapper is `class="tzai tzai-chart"`, so match the CLASS TOKEN and the
    # element id, not a literal `class="tzai"` — that exact-string check rejected a
    # perfectly good fragment on its first run.
    for needle in (f'id="tzai-{key}"', 'class="tzai ', "<style>", "<script>"):
        if needle not in body:
            sys.exit(f"FAIL {fname} is missing {needle!r} — refusing to publish a broken fragment")
    parts[key] = body
# 2026-09-23: the chart's footnotes are PAGE TEXT now ("The fine print", the architect: "useless
# bottom notes that should instead go in the main website as normal text"). Small by
# nature, so the size floor above does not apply; empty or tag-less is still a failure.
notes_src = os.path.join(OUT, "notes.part.html")
notes = open(notes_src, encoding="utf-8").read() if os.path.exists(notes_src) else ""
if "<li>" not in notes:
    sys.exit(f"FAIL {notes_src} missing or has no footnotes — refusing to publish")

# ---- 3. rewrite ONLY the marked regions ------------------------------------
blocks = {
    "CHART": parts["chart"],
    "DOSSIER": parts["dossier"],
    "NOTES": notes,
    "FIGURES": (
        '<p style="margin:10px 0 0;color:#8a6a52;font-size:0.95em;line-height:1.6;">'
        f'As of <strong>{datetime.date.today().strftime("%-d %B %Y")}</strong>: '
        f'<strong>{fig["models"]}</strong> models across <strong>{fig["vendors"]}</strong> vendors on the chart, '
        f'<strong>{doss["rows"]}</strong> graded in the dossier across {doss["capCols"]} capability columns'
        + (f'. {fig["discounted"].capitalize()}' if fig.get("discounted") else "")
        + (f', {fig["widestGap"]}' if fig.get("widestGap") else "")
        + ".</p>"
        + (f'<p style="margin:6px 0 0;color:#8a6a52;font-size:0.9em;line-height:1.5;'
           f'font-family:ui-monospace,monospace;">{fig["thalamus"]}</p>' if fig.get("thalamus") else "")
    ),
}

new = raw
for key, block in blocks.items():
    new = re.sub(
        rf"(<!-- AI-ANALYSIS:{key}:START -->)(.*?)(<!-- AI-ANALYSIS:{key}:END -->)",
        lambda m: m.group(1) + "\n" + block + "\n" + m.group(3),
        new, flags=re.S)

if DRY:
    print(json.dumps({"post": post_id, "status": post_status, "dry_run": True,
                      "would_write_bytes": len(new)}, indent=1))
    sys.exit(0)

# FORK 2026-09-23: the WHOLE post rides inside one wp:html block. A post with blocks has
# wpautop switched off (do_blocks unhooks it), which ends all three documented manglings
# of inline JS (blank lines, block-tag literals, `&`) AND the 2026-09-22 blank page: on a
# 2.5 MB classic body wpautop's regexes can hit pcre.backtrack_limit (1,000,000 on this
# host), preg_replace returns null, and the_content comes back empty.
new = new.strip()
if not new.startswith("<!-- wp:html -->"):
    new = "<!-- wp:html -->\n" + new + "\n<!-- /wp:html -->"

served = wp_update(post_id, new)
# A blank or truncated render is the 09-22 failure; judge it by size, not by a 200.
if len(served) < 0.5 * len(new):
    wp_update(post_id, raw)  # put yesterday's page back, fail closed
    sys.exit(f"FAIL the site renders {len(served)} bytes for a {len(new)}-byte body — "
             "restored the previous content")

# ---- 4. verify what the site now SERVES ------------------------------------
# The old check looked for the iframe URLs. The equivalent question for an inline
# fragment is whether the markup survived WordPress at all: wpautop and kses both sit
# between us and the page, and a stripped <script> would leave a handsome dead chart.
missing = [n for n in ('id="tzai-chart"', 'id="tzai-dossier"', "<script") if n not in served]
if missing:
    sys.exit(f"FAIL post updated but the served content lost: {missing}")

# wpautop runs on the way OUT, so what we sent is not what the reader gets. It inserts
# <p> around anything it reads as a block boundary, and a <p> inside <svg> makes the
# HTML parser break out of foreign content — the drawing just stops there. This bit us
# on the first inline publish (an inner <style> inside the SVG was the boundary), so
# the check is permanent rather than a one-off fix.
svg = re.search(r'<svg class="sc-svg[\s\S]*?</svg>', served)
if not svg:
    sys.exit("FAIL the chart SVG is not in the served content")
injected = svg.group(0).count("<p>") + svg.group(0).count("<br")
if injected:
    sys.exit(f"FAIL wpautop injected {injected} block tag(s) INSIDE the chart svg — "
             "the drawing would be cut short; hoist any <style>/blank line out of the markup")
pruned = []

print(json.dumps({
    "post": post_id, "status": post_status, "link": post_link,
    "transport": "ssh+wp-cli" if USE_SSH else "rest", "served_bytes": len(served),
    "chart_bytes": len(parts["chart"]), "dossier_bytes": len(parts["dossier"]),
    "figures": {"models": fig["models"], "dossier_rows": doss["rows"]},
    "pruned": pruned,
}, indent=1))
