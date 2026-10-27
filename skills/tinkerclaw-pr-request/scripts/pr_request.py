#!/usr/bin/env python3
"""Ask the TinkerClaw maintainers for a change: a bug report or an improvement, filed as a pull request.

The upstream repo takes requests as pull requests (issues are off). A request-only PR adds one file,
docs/requests/<date>-<slug>.md, whose text is also the PR description. A PR that carries a fix pushes
the caller's own branch and uses the request as its description.

  pr_request.py template --kind bug|improvement --title "..." --out FILE   skeleton, environment filled in
  pr_request.py check FILE                                                  required sections + privacy scan
  pr_request.py similar "words"                                             open/closed PRs that may match
  pr_request.py submit FILE --yes [--branch BRANCH --repo-dir DIR]          file it (only after the human said yes)

Without a GitHub login (`gh auth status` fails), submit prints a github.com link that opens the request
as a new file; GitHub forks the repo and proposes the PR when the person clicks it. Python stdlib + gh.
"""

import argparse
import base64
import datetime as dt
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.parse

UPSTREAM = os.environ.get("TINKERCLAW_UPSTREAM", "globalcaos/tinkerclaw")
REQUEST_DIR = "docs/requests"

SECTIONS = {
    "bug": ["What happened", "What I expected", "Steps to reproduce", "Evidence", "Environment", "Done when"],
    "improvement": ["What I want", "Why it matters", "What happens today", "Proposed change", "Environment", "Done when"],
}
HINTS = {
    "What happened": "The exact symptom, in one or two sentences. Name the command, page or message.",
    "What I expected": "What should have happened instead.",
    "Steps to reproduce": "1. ...\n2. ...\n3. ... (from a fresh start; say how often it happens)",
    "Evidence": "The exact error text or log lines (trimmed, private data removed). Paths relative to the repo.",
    "What I want": "The capability, in one or two sentences.",
    "Why it matters": "Who it helps and how often the need comes up.",
    "What happens today": "The current behaviour or the workaround in use.",
    "Proposed change": "Where in the code or docs, if known. Say 'unknown' rather than guess.",
    "Done when": "A check anyone can run that proves the request is met.",
}
PLACEHOLDER = "TODO:"

# Private data that must never reach a public PR. Each: (label, regex).
PRIVATE = [
    ("email address", r"[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    ("phone number", r"(?<![\w.])\+\d{1,3}[ \d]{7,14}\d\b"),
    ("private IP address", r"\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b"),
    ("home path with a user name", r"(?:/home/|/Users/|C:\\Users\\)[A-Za-z0-9._-]+"),
    ("API key or token", r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})"),
    ("bearer or JWT token", r"(?:[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)"),
    ("secret-looking assignment", r"(?i)\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}"),
]


def run(cmd, check=True, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if check and r.returncode != 0:
        raise SystemExit(f"failed: {' '.join(cmd[:4])}...\n{r.stderr.strip() or r.stdout.strip()}")
    return r


def gh_ready():
    return shutil.which("gh") is not None and run(["gh", "auth", "status"], check=False).returncode == 0


def environment(repo_dir):
    rows = []
    if repo_dir and os.path.isdir(os.path.join(repo_dir, ".git")):
        sha = run(["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"], check=False).stdout.strip()
        branch = run(["git", "-C", repo_dir, "rev-parse", "--abbrev-ref", "HEAD"], check=False).stdout.strip()
        dirty = run(["git", "-C", repo_dir, "status", "--porcelain"], check=False).stdout.strip()
        rows.append(f"- TinkerClaw commit: {sha} on {branch}{' (local changes)' if dirty else ''}")
    if shutil.which("openclaw"):
        v = run(["openclaw", "--version"], check=False).stdout.strip().splitlines()
        if v:
            rows.append(f"- openclaw --version: {v[-1]}")
    rows.append(f"- OS: {platform.system()} {platform.release()} ({platform.machine()})")
    if shutil.which("node"):
        rows.append(f"- Node: {run(['node', '-v'], check=False).stdout.strip()}")
    rows.append("- Channel / model involved: TODO: e.g. Tinker web chat, WhatsApp; the model id if it matters")
    return "\n".join(rows)


def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:50].rstrip("-") or "request"


def cmd_template(a):
    if os.path.exists(a.out):
        raise SystemExit(f"{a.out} exists; pick another path")
    lines = [f"# [{a.kind}] {a.title}", "", f"Kind: {a.kind}", ""]
    for sec in SECTIONS[a.kind]:
        body = environment(a.repo_dir) if sec == "Environment" else f"{PLACEHOLDER} {HINTS[sec]}"
        lines += [f"## {sec}", "", body, ""]
    with open(a.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"wrote {a.out}: fill every {PLACEHOLDER} line, then run: check {a.out}")


def parse(text):
    m = re.match(r"#\s*\[(bug|improvement)\]\s*(.+)", text)
    if not m:
        return None, None, {}
    secs, cur = {}, None
    for line in text.splitlines():
        h = re.match(r"##\s+(.+?)\s*$", line)
        if h:
            cur = h.group(1)
            secs[cur] = []
        elif cur:
            secs[cur].append(line)
    return m.group(1), m.group(2).strip(), {k: "\n".join(v).strip() for k, v in secs.items()}


def problems(text):
    out = []
    kind, title, secs = parse(text)
    if not kind:
        return ["first line must be '# [bug] <title>' or '# [improvement] <title>'"]
    if len(title) < 10:
        out.append("title is too short to say what is wrong")
    for sec in SECTIONS[kind]:
        body = secs.get(sec, "")
        if not body:
            out.append(f"section '## {sec}' is missing or empty")
        elif PLACEHOLDER in body:
            out.append(f"section '## {sec}' still has a {PLACEHOLDER} line")
        elif sec != "Environment" and len(body) < 15:
            out.append(f"section '## {sec}' is too thin to act on")
    for n, line in enumerate(text.splitlines(), 1):
        for label, rx in PRIVATE:
            if re.search(rx, line):
                out.append(f"line {n}: looks like private data ({label}); remove or generalise it")
    return out


def cmd_check(a):
    text = open(a.file, encoding="utf-8").read()
    p = problems(text)
    for x in p:
        print("FIX:", x)
    if p:
        sys.exit(1)
    print("OK: specific enough and no private data found. Show it to your human before submit.")


def cmd_similar(a):
    if not gh_ready():
        q = urllib.parse.quote(f"is:pr {a.words}")
        print(f"no GitHub login; search by hand: https://github.com/{UPSTREAM}/pulls?q={q}")
        return
    r = run(["gh", "pr", "list", "-R", UPSTREAM, "--state", "all", "--search", a.words, "--limit", "10",
             "--json", "number,title,state,url"])
    rows = json.loads(r.stdout or "[]")
    for x in rows:
        print(f"#{x['number']} [{x['state']}] {x['title']}  {x['url']}")
    if not rows:
        print("no matching PRs")


def gh_json(args):
    return json.loads(run(["gh", "api", *args]).stdout or "null")


def cmd_submit(a):
    if not a.yes:
        raise SystemExit("refused: pass --yes only after your human has read the request and said to file it")
    text = open(a.file, encoding="utf-8").read()
    p = problems(text)
    if p:
        for x in p:
            print("FIX:", x)
        raise SystemExit("refused: run check until it passes")
    kind, title, _ = parse(text)
    name = f"{dt.date.today().isoformat()}-{slugify(title)}.md"
    pr_title = f"[{kind}] {title}"
    body = text.split("\n", 1)[1].strip() + "\n\n---\nFiled by a TinkerClaw agent with the `tinkerclaw-pr-request` skill.\n"

    if not gh_ready():
        if a.branch:
            raise SystemExit("a fix branch needs a GitHub login (gh auth login); without one, file the request alone")
        url = (f"https://github.com/{UPSTREAM}/new/main?filename={urllib.parse.quote(REQUEST_DIR + '/' + name)}"
               f"&value={urllib.parse.quote(text)}")
        print("No GitHub login here. Give your human this link; it opens the request on GitHub, and"
              " 'Propose changes' then 'Create pull request' files it from their own account:")
        print(url)
        if len(url) > 8000:
            print(f"(the link is {len(url)} characters; if the browser cuts it, open it without &value=... and paste {a.file})")
        return

    up_owner, up_name = UPSTREAM.split("/")
    me = run(["gh", "api", "user", "-q", ".login"]).stdout.strip()
    repo = gh_json([f"repos/{UPSTREAM}"])
    base = repo["default_branch"]
    direct = bool((repo.get("permissions") or {}).get("push"))
    target = UPSTREAM if direct else f"{me}/{up_name}"
    if not direct:
        run(["gh", "repo", "fork", UPSTREAM, "--clone=false", "--remote=false"], check=False)
        run(["gh", "api", "-X", "POST", f"repos/{target}/merge-upstream", "-f", f"branch={base}"], check=False)
    head = (lambda br: br if direct else f"{me}:{br}")

    if a.branch:
        if not a.repo_dir:
            raise SystemExit("--branch needs --repo-dir (the local clone holding the fix)")
        helper = "!gh auth git-credential"
        run(["git", "-C", a.repo_dir, "-c", "credential.helper=", "-c", f"credential.helper={helper}",
             "push", f"https://github.com/{target}.git", f"{a.branch}:{a.branch}"])
        branch = a.branch
    else:
        branch = f"request/{name[:-3]}"
        sha = gh_json([f"repos/{UPSTREAM}/git/ref/heads/{base}"])["object"]["sha"]
        for attempt in range(6):  # a brand-new fork takes a few seconds to exist
            r = run(["gh", "api", "-X", "POST", f"repos/{target}/git/refs", "-f", f"ref=refs/heads/{branch}",
                     "-f", f"sha={sha}"], check=False)
            if r.returncode == 0 or "Reference already exists" in r.stdout + r.stderr:
                break
            time.sleep(3)
        else:
            raise SystemExit(f"could not create branch {branch} on {target}: {r.stderr.strip() or r.stdout.strip()}")
        run(["gh", "api", "-X", "PUT", f"repos/{target}/contents/{REQUEST_DIR}/{name}",
             "-f", f"message=request: {pr_title}", "-f", f"branch={branch}",
             "-f", "content=" + base64.b64encode(text.encode()).decode()])

    r = run(["gh", "pr", "create", "-R", UPSTREAM, "--base", base, "--head", head(branch),
             "--title", pr_title, "--body", body])
    print("filed:", r.stdout.strip())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("template")
    t.add_argument("--kind", choices=SECTIONS, required=True)
    t.add_argument("--title", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--repo-dir", default=os.path.expanduser("~/src/tinkerclaw"))
    c = sub.add_parser("check")
    c.add_argument("file")
    s = sub.add_parser("similar")
    s.add_argument("words")
    u = sub.add_parser("submit")
    u.add_argument("file")
    u.add_argument("--yes", action="store_true")
    u.add_argument("--branch")
    u.add_argument("--repo-dir")
    a = ap.parse_args()
    {"template": cmd_template, "check": cmd_check, "similar": cmd_similar, "submit": cmd_submit}[a.cmd](a)


if __name__ == "__main__":
    main()
