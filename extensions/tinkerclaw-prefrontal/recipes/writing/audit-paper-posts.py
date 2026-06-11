#!/usr/bin/env python3
"""
audit-paper-posts — detect NEW papers (no post) and STALE posts (paper revised
past the version the post serves) for the thetinkerzone.com "Building Jarvis"
series.

Read-only. Prints four buckets: current / stale / new / orphan, plus the
follow-up recipe to run for each actionable item. No writes, no publishing.

Usage:  python3 audit-paper-posts.py
Env:    reads WP_APP_PASSWORD from skills/wordpress-ultimate/.env
"""
import os, re, json, glob, subprocess, sys

PAPERS = os.path.expanduser("~/Documents/AI_reports/Papers")
ENV = os.path.expanduser("~/.openclaw/workspace/skills/wordpress-ultimate/.env")
WP = "https://thetinkerzone.com"
CAT = 29  # Building Jarvis

# Codename (in the paper filename) -> published-title stem (in the post's PDF
# name) for the cases where they diverge. Substring matching handles the rest
# (e.g. "myelin" ⊂ "myelin-budget-prompting"); only true renames need an entry.
ALIASES = {"cortex": "identity-persistence"}

# md files that are NOT the paper itself
SKIP_MD = re.compile(r"(improvement|review|critique|references|sota-expansion|diagram-suggestions|notes)", re.I)


def ver_tuple(v):
    return tuple(int(x) for x in v.split("."))


def parse_version(stem):
    m = re.search(r"-v(\d+(?:\.\d+)*)$", stem)
    return m.group(1) if m else None


def topic_of(stem):
    s = re.sub(r"\.(md|pdf)$", "", stem)
    s = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", s)        # drop date prefix
    s = re.sub(r"-v\d+(?:\.\d+)*$", "", s)           # drop version suffix
    return s


def folder_latest(folder):
    """Highest-versioned paper .md in a folder -> (topic, version_str, filename)."""
    best = None
    for p in glob.glob(os.path.join(folder, "*.md")):
        base = os.path.basename(p)
        if SKIP_MD.search(base):
            continue
        stem = re.sub(r"\.md$", "", base)
        v = parse_version(stem)
        if not v:
            continue
        if best is None or ver_tuple(v) > ver_tuple(best[1]):
            best = (topic_of(base), v, base)
    return best


def has_pdf(folder, version):
    return bool(glob.glob(os.path.join(folder, f"*-v{version}.pdf"))) or \
           bool(glob.glob(os.path.join(folder, f"*{version}.pdf")))


def topics_match(folder_topic, post_topic):
    if folder_topic == post_topic:
        return True
    if ALIASES.get(folder_topic) == post_topic:
        return True
    return folder_topic in post_topic or post_topic in folder_topic


def get_posts():
    pw = ""
    with open(ENV) as f:
        for line in f:
            if line.startswith("WP_APP_PASSWORD="):
                pw = line.split("=", 1)[1].strip()
    url = (f"{WP}/wp-json/wp/v2/posts?categories={CAT}&per_page=50"
           "&status=publish,draft&context=edit&_fields=id,status,slug,content,modified")
    out = subprocess.run(
        ["curl", "-s", "-u", f"oserra:{pw}", url],
        capture_output=True, text=True).stdout
    posts = json.loads(out)
    res = []
    for p in posts:
        c = p["content"].get("raw") or p["content"].get("rendered", "")
        pdfs = re.findall(r"/uploads/20\d\d/\d\d/([0-9A-Za-z._-]+\.pdf)", c)
        for pdf in set(pdfs):
            stem = re.sub(r"\.pdf$", "", pdf)
            res.append({
                "id": p["id"], "status": p["status"], "slug": p["slug"],
                "pdf": pdf, "topic": topic_of(pdf), "version": parse_version(stem),
            })
    return res


def main():
    folders = sorted(d for d in glob.glob(os.path.join(PAPERS, "J*"))
                     if os.path.isdir(d))
    papers = []
    for fp in folders:
        latest = folder_latest(fp)
        if latest:
            t, v, fn = latest
            papers.append({"folder": os.path.basename(fp), "path": fp,
                           "topic": t, "version": v, "file": fn,
                           "pdf_built": has_pdf(fp, v)})
    posts = get_posts()

    current, stale, new = [], [], []
    matched_posts = set()
    for pap in papers:
        post = next((p for p in posts if topics_match(pap["topic"], p["topic"])), None)
        if not post:
            new.append(pap)
            continue
        matched_posts.add(post["id"])
        pv = post["version"] and ver_tuple(post["version"])
        fv = ver_tuple(pap["version"])
        if pv and fv > pv:
            stale.append({**pap, "post": post})
        else:
            current.append({**pap, "post": post})
    orphan = [p for p in posts if p["id"] not in matched_posts]

    def line(p):
        return f"  {p['folder']:<30} latest v{p['version']:<8} ({p['file']})"

    print("=" * 78)
    print(f"PAPER↔POST STALENESS AUDIT — {len(papers)} papers, {len(posts)} posts")
    print("=" * 78)
    print(f"\n✅ CURRENT ({len(current)}) — post serves the latest paper version")
    for p in sorted(current, key=lambda x: x["folder"]):
        print(line(p) + f"  → post {p['post']['id']} v{p['post']['version']}")
    print(f"\n⚠️  STALE ({len(stale)}) — paper revised past the post's version")
    for p in stale:
        pdf = "PDF built" if p["pdf_built"] else "NO PDF for latest — recompile first"
        print(line(p) + f"\n      post {p['post']['id']} serves v{p['post']['version']}"
              f"  ·  {pdf}")
    print(f"\n🆕 NEW ({len(new)}) — paper folder with no post")
    for p in sorted(new, key=lambda x: x["folder"]):
        rdy = "ready (PDF built)" if p["pdf_built"] else "NOT ready (no PDF — seed)"
        print(line(p) + f"  → {rdy}")
    if orphan:
        print(f"\n❓ ORPHAN ({len(orphan)}) — post with no matching paper folder")
        for p in orphan:
            print(f"  post {p['id']} [{p['status']}] {p['slug']}  (pdf {p['pdf']})")

    print("\n" + "-" * 78)
    print("NEXT ACTIONS")
    print("-" * 78)
    if stale:
        print("STALE → recompile if needed (revise-publish-batch / compile-paper),")
        print("        re-SFTP the new PDF, then refresh the post body + featured image.")
    ready_new = [p["folder"] for p in new if p["pdf_built"]]
    if ready_new:
        print("NEW (ready) → publish-paper-summary.workflow.js with")
        print(f"        args.folders = {json.dumps(ready_new)}  (creates DRAFTS for review).")
    seed_new = [p["folder"] for p in new if not p["pdf_built"]]
    if seed_new:
        print(f"NEW (seed) → hold; no PDF yet: {', '.join(seed_new)}")
    if not (stale or ready_new):
        print("Nothing actionable — all posts current, no new ready papers.")


if __name__ == "__main__":
    main()
