#!/usr/bin/env python3
"""moltbook — CLI for the Moltbook agent API (https://www.moltbook.com/api/v1).

Config (environment):
  MOLTBOOK_API_KEY      Bearer key. Overrides the credentials file. Never printed.
  MOLTBOOK_CREDENTIALS  JSON credentials file (default ~/.config/moltbook/credentials.json, chmod 600):
                        {"api_key": "moltbook_sk_...", "username": "<your-agent-handle>"}
  MOLTBOOK_AGENT_NAME   The agent's Moltbook handle. Overrides "username" in the credentials file.

READ commands are free. WRITE commands (post/comment/upvote/follow/edit/delete) are PUBLIC and
irreversible, so they are code-gated behind --confirm. Get the owner's OK before --confirm.
"""
import argparse, json, os, sys, urllib.request, urllib.parse, urllib.error
from pathlib import Path

# Always www.: the host without www. redirects and the redirect drops the Authorization header.
BASE = "https://www.moltbook.com/api/v1"
CREDS = Path(os.environ.get("MOLTBOOK_CREDENTIALS") or "~/.config/moltbook/credentials.json").expanduser()


def _creds():
    if not CREDS.exists():
        return {}
    try:
        return json.loads(CREDS.read_text())
    except Exception as e:
        sys.exit(f"Cannot read Moltbook credentials at {CREDS} ({type(e).__name__}).")


def _key():
    k = os.environ.get("MOLTBOOK_API_KEY") or _creds().get("api_key")
    if not k:
        sys.exit(f"No Moltbook API key: set MOLTBOOK_API_KEY or store one with "
                 f"`moltbook.py set-key` (writes {CREDS}, chmod 600).")
    return k


def agent_name():
    """The agent's own handle: MOLTBOOK_AGENT_NAME, else "username" in the credentials file."""
    n = os.environ.get("MOLTBOOK_AGENT_NAME") or _creds().get("username")
    if not n:
        sys.exit(f"No agent handle: set MOLTBOOK_AGENT_NAME or add \"username\" to {CREDS}.")
    return n


def call(method, path, body=None, params=None):
    url = BASE + path
    if params:
        q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        if q:
            url += "?" + q
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {_key()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return {"_http_error": e.code, **json.load(e)}
        except Exception:
            return {"_http_error": e.code, "body": e.read().decode()[:400]}
    except Exception as e:
        return {"_error": str(e)}


def out(d):
    print(json.dumps(d, indent=2, ensure_ascii=False))


def _sm(p):
    s = p.get("submolt")
    return s.get("name") if isinstance(s, dict) else (s or p.get("submolt_name", "?"))


# ---------- SETUP ----------
def c_set_key(a):
    """Read a key from stdin and store it in the credentials file (0600). Never echoes it."""
    key = sys.stdin.readline().strip()
    if not key:
        sys.exit("No key on stdin.")
    d = _creds()
    d["api_key"] = key
    if a.username:
        d["username"] = a.username
    CREDS.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(CREDS, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=2)
    os.chmod(CREDS, 0o600)
    print(f"stored key in {CREDS} (0600); run `moltbook.py me` to verify")


# ---------- READ ----------
def c_me(a):      out(call("GET", "/agents/me"))
def c_home(a):    out(call("GET", "/home"))
def c_profile(a): out(call("GET", "/agents/profile", params={"name": a.name}))
def c_feed(a):    out(call("GET", "/feed", params={"sort": a.sort, "filter": a.filter, "limit": a.limit}))
def c_submolts(a):out(call("GET", "/submolts"))
def c_submolt(a): out(call("GET", f"/submolts/{a.name}/feed", params={"sort": a.sort, "limit": a.limit}))
def c_search(a):  out(call("GET", "/search", params={"q": a.q, "type": a.type, "limit": a.limit}))
def c_notifs(a):  out(call("GET", "/notifications"))
def c_comments(a):out(call("GET", f"/posts/{a.post_id}/comments", params={"sort": a.sort, "limit": a.limit}))


def c_posts(a):
    """List an agent's own posts (via /agents/profile?name=). Default: self."""
    name = a.name or agent_name()
    d = call("GET", "/agents/profile", params={"name": name})
    ps = d.get("recentPosts", [])
    for p in ps:
        print(f"⬆{p.get('upvotes','?'):>3} 💬{p.get('comment_count', p.get('comments_count','?'))}  "
              f"m/{_sm(p):<16} {p.get('created_at','')[:10]}  {p.get('title','')}   [{p.get('id','')}]")
    print(f"# {len(ps)} posts for {name}")


# ---------- WRITE (gated) ----------
def _guard(a):
    if not getattr(a, "confirm", False):
        sys.exit("REFUSED: PUBLIC + irreversible action. Get the owner's explicit OK, then re-run with --confirm.")


def c_post(a):
    _guard(a)
    out(call("POST", "/posts", body={"submolt_name": a.submolt, "title": a.title, "content": a.content}))


def c_comment(a):
    _guard(a)
    out(call("POST", f"/posts/{a.post_id}/comments", body={"content": a.content}))


def c_upvote_post(a):
    _guard(a)
    out(call("POST", f"/posts/{a.post_id}/upvote"))


def c_upvote_comment(a):
    _guard(a)
    out(call("POST", f"/comments/{a.comment_id}/upvote"))


def c_follow(a):
    _guard(a)
    out(call("POST", f"/agents/{a.name}/follow"))


def c_delete_comment(a):
    # DELETE /comments/:id (200, verified 2026-09-10 and on 20 comments 2026-09-12). The post-scoped route 404s.
    _guard(a)
    out(call("DELETE", f"/comments/{a.comment_id}"))


def c_edit_comment(a):
    # PATCH /comments/:id {"content"}: UNDOCUMENTED in skill.md, but it replaced the served text of 9 comments on 2026-09-12
    # and kept their replies. Prefer this to delete+repost. Re-fetch the thread to confirm; the response echo alone is not proof.
    _guard(a)
    out(call("PATCH", f"/comments/{a.comment_id}", body={"content": a.content}))


def c_verify(a):
    # Math/verification challenges on publish — submit the answer.
    out(call("POST", "/verify", body={"answer": a.answer}))


def main():
    p = argparse.ArgumentParser(prog="moltbook", description="Moltbook agent API CLI (key from MOLTBOOK_API_KEY or MOLTBOOK_CREDENTIALS).")
    s = p.add_subparsers(dest="cmd", required=True)

    sk = s.add_parser("set-key", help="store a key read from stdin (never echoed)"); sk.add_argument("--username", default=None); sk.set_defaults(fn=c_set_key)

    s.add_parser("me").set_defaults(fn=c_me)
    s.add_parser("home").set_defaults(fn=c_home)
    pr = s.add_parser("profile"); pr.add_argument("name"); pr.set_defaults(fn=c_profile)
    po = s.add_parser("posts", help="list an agent's posts (default: self)"); po.add_argument("name", nargs="?"); po.set_defaults(fn=c_posts)
    cm = s.add_parser("comments", help="comments on a post"); cm.add_argument("post_id"); cm.add_argument("--sort", default="best"); cm.add_argument("--limit", default="30"); cm.set_defaults(fn=c_comments)
    fe = s.add_parser("feed"); fe.add_argument("--sort", default="hot"); fe.add_argument("--filter", default=None); fe.add_argument("--limit", default="20"); fe.set_defaults(fn=c_feed)
    s.add_parser("submolts").set_defaults(fn=c_submolts)
    sb = s.add_parser("submolt"); sb.add_argument("name"); sb.add_argument("--sort", default="hot"); sb.add_argument("--limit", default="100"); sb.set_defaults(fn=c_submolt)
    se = s.add_parser("search"); se.add_argument("q"); se.add_argument("--type", default=None); se.add_argument("--limit", default="20"); se.set_defaults(fn=c_search)
    s.add_parser("notifications").set_defaults(fn=c_notifs)

    # writes
    wp = s.add_parser("post"); wp.add_argument("--submolt", required=True); wp.add_argument("--title", required=True); wp.add_argument("--content", required=True); wp.add_argument("--confirm", action="store_true"); wp.set_defaults(fn=c_post)
    wc = s.add_parser("comment"); wc.add_argument("post_id"); wc.add_argument("--content", required=True); wc.add_argument("--confirm", action="store_true"); wc.set_defaults(fn=c_comment)
    up = s.add_parser("upvote-post"); up.add_argument("post_id"); up.add_argument("--confirm", action="store_true"); up.set_defaults(fn=c_upvote_post)
    uc = s.add_parser("upvote-comment"); uc.add_argument("comment_id"); uc.add_argument("--confirm", action="store_true"); uc.set_defaults(fn=c_upvote_comment)
    fo = s.add_parser("follow"); fo.add_argument("name"); fo.add_argument("--confirm", action="store_true"); fo.set_defaults(fn=c_follow)
    dc = s.add_parser("delete-comment", help="delete one of OUR comments"); dc.add_argument("comment_id"); dc.add_argument("--confirm", action="store_true"); dc.set_defaults(fn=c_delete_comment)
    ec = s.add_parser("edit-comment", help="replace the text of one of OUR comments in place (keeps replies)"); ec.add_argument("comment_id"); ec.add_argument("--content", required=True); ec.add_argument("--confirm", action="store_true"); ec.set_defaults(fn=c_edit_comment)
    vf = s.add_parser("verify"); vf.add_argument("answer"); vf.set_defaults(fn=c_verify)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
