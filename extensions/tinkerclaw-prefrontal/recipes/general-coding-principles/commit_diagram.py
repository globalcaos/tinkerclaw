#!/usr/bin/env python3
"""Draw a feature branch as plan blocks grouped into their commits.

Each plan block that has commits becomes a box holding its commits in order;
a block with no commits yet is a grey "to do" box. Hovering a commit shows its
full message (a side panel, plus the native SVG tooltip). The page also says
whether the branch tip is on the Git remote, because a branch nobody else can
see is the most common way reviewed work goes missing.

    commit_diagram.py --repo ~/src/<project> --range main..feat/<feature> \\
        --map ~/Documents/<project>/<feature>-commit-map.json \\
        --out ~/Documents/<project>/<feature>-commits.html [--png out.png]
        (--png also writes out-chat.png at 1/--chat-factor of the size: that is the chat copy)

The map (JSON): {"title": str, "lanes": {lane_id: title},
                 "blocks": [{"id", "title", "lane"?, "commits": [sha, ...]?}],
                 "edges": [[block_id, block_id], ...]}
Every commit in --range must appear in exactly one block, or the script stops.
Needs `mmdc` (Mermaid CLI) on PATH, or its path in --mmdc / $MMDC.
--png also needs Pillow (python3 -m pip install pillow).
"""

import argparse
import html
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path


def git(repo, *args, timeout=60):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, text=True,
                          capture_output=True, timeout=timeout).stdout


def load_commits(repo, rev_range):
    out = git(repo, "log", "--reverse", "--format=%H%x00%h%x00%ci%x00%B%x1e", rev_range)
    commits = []
    for record in out.split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        full, short, date, message = record.split("\x00", 3)
        commits.append({"sha": full, "short": short, "date": date[:16],
                        "message": message.strip()})
    return commits


def remote_state(repo, rev_range, remote):
    branch = rev_range.split("..")[-1]
    tip = git(repo, "rev-parse", branch).strip()
    try:
        line = git(repo, "ls-remote", remote, f"refs/heads/{branch}", timeout=30).split()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        return f"remote {remote} not checked ({exc.__class__.__name__})"
    if not line:
        return f"NOT on {remote}: nobody else can see {branch}"
    if line[0] == tip:
        return f"on {remote} and up to date ({tip[:8]})"
    return f"on {remote} but behind: remote {line[0][:8]}, local {tip[:8]}"


def resolve(commits, prefix):
    hits = [c for c in commits if c["sha"].startswith(prefix)]
    if len(hits) != 1:
        sys.exit(f"map commit {prefix!r} matches {len(hits)} commits in the range")
    return hits[0]


def mermaid_source(plan, commits):
    order = {c["sha"]: i for i, c in enumerate(commits)}
    mapped, lines = {}, ["flowchart LR"]
    blocks = {b["id"]: b for b in plan["blocks"]}

    def block_lines(block, indent):
        pad = " " * indent
        shas = sorted((resolve(commits, p)["sha"] for p in block.get("commits", [])),
                      key=order.get)
        if not shas:
            return [f'{pad}{block["id"]}["{block["title"]}"]:::todo']
        out = [f'{pad}subgraph {block["id"]}["{block["title"]}"]', f"{pad}  direction TB"]
        for sha in shas:
            if sha in mapped:
                sys.exit(f"commit {sha[:8]} is mapped to both {mapped[sha]} and {block['id']}")
            mapped[sha] = block["id"]
            commit = commits[order[sha]]
            subject = commit["message"].splitlines()[0].replace('"', "'")
            out.append(f'{pad}  c_{sha[:8]}["<b>{sha[:8]}</b><br/>{subject}"]:::done')
        for a, b in zip(shas, shas[1:]):
            out.append(f"{pad}  c_{a[:8]} --> c_{b[:8]}")
        out.append(f"{pad}end")
        return out

    lanes = plan.get("lanes", {})
    for lane_id, lane_title in lanes.items():
        lines.append(f'  subgraph {lane_id}["{lane_title}"]')
        for block in plan["blocks"]:
            if block.get("lane") == lane_id:
                lines += block_lines(block, 4)
        lines.append("  end")
    for block in plan["blocks"]:
        if block.get("lane") not in lanes:
            lines += block_lines(block, 2)
    for a, b in plan.get("edges", []):
        if a not in blocks or b not in blocks:
            sys.exit(f"edge {a} -> {b} names an unknown block")
        lines.append(f"  {a} --> {b}")
    lines += ["  classDef done fill:#2e7d32,stroke:#1b5e20,color:#ffffff",
              "  classDef todo fill:#eceff1,stroke:#90a4ae,color:#455a64"]
    missing = [c for c in commits if c["sha"] not in mapped]
    if missing:
        sys.exit("unmapped commits (add them to a block): "
                 + ", ".join(f'{c["short"]} {c["message"].splitlines()[0]}' for c in missing))
    return "\n".join(lines) + "\n"


def render(mmdc, mmd, out_path, background, extra=()):
    subprocess.run([mmdc, "-i", str(mmd), "-o", str(out_path), "-b", background, *extra],
                   check=True, capture_output=True, timeout=180)


def add_titles(svg, commits):
    by_short = {c["sha"][:8]: c for c in commits}

    def tag(match):
        head, short = match.group(0), match.group(1)
        commit = by_short.get(short)
        if not commit:
            return head
        title = f'{commit["short"]} · {commit["date"]}\n\n{commit["message"]}'
        return (head[:-1] + f' data-sha="{short}">'
                + f"<title>{html.escape(title)}</title>")

    return re.sub(r'<g [^>]*id="[^"]*flowchart-c_([0-9a-f]{8})-\d+"[^>]*>', tag, svg)


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>{title}</title><style>
body{{font-family:DejaVu Sans,system-ui,sans-serif;background:{background};color:#2b2118;margin:18px}}
h1{{font-size:20px;margin:0 0 4px}} .meta{{font-size:13px;color:#6b5a45;margin-bottom:10px}}
.remote{{font-weight:bold;color:{remote_colour}}}
#wrap{{display:flex;gap:16px;align-items:flex-start}} #chart{{flex:1;overflow:auto}}
#chart svg{{max-width:none!important;height:auto}}
g[data-sha]{{cursor:pointer}} g[data-sha]:hover rect{{stroke:#f9a825!important;stroke-width:4px!important}}
#panel{{width:380px;position:sticky;top:12px;background:#2b2118;color:#f3e9d8;border-radius:8px;
padding:12px 14px;font-size:13px;white-space:pre-wrap;min-height:120px}}
#panel b{{color:#d9b27c}}
</style></head><body>
<h1>{title}</h1>
<div class="meta">{range} · {count} commits · generated {generated} ·
<span class="remote">{remote}</span><br>
Green = committed, grey = still to do. Hover a commit to read its message.</div>
<div id="wrap"><div id="chart">{svg}</div><div id="panel">Hover a commit.</div></div>
<script>
const messages = {messages};
document.querySelectorAll("g[data-sha]").forEach(g => g.addEventListener("mouseenter", () => {{
  const c = messages[g.dataset.sha]; const p = document.getElementById("panel");
  p.innerHTML = "<b>" + c.short + " · " + c.date + "</b>\\n\\n";
  p.append(c.message.replace(/([^\\n])\\n(?!\\n)/g, "$1 "));
}}));
</script></body></html>
"""


def shrink(src, dst, factor):
    """Chat clients draw images at their full pixel size, so the inline copy is
    1/factor of the full PNG (the owner, 2026-09-25: "way too big ... show it at 1/3")."""
    try:
        from PIL import Image
    except ImportError:
        sys.exit("--png needs Pillow for the chat copy: python3 -m pip install pillow")
    with Image.open(src) as im:
        im.resize((max(1, im.width // factor), max(1, im.height // factor)),
                  Image.LANCZOS).save(dst)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--range", required=True, dest="rev_range")
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--png", type=Path)
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--chat-factor", type=int, default=3,
                        help="the -chat.png copy is 1/N of the full PNG (default 3)")
    parser.add_argument("--background", default="#fbf8f2", help="page and image background")
    parser.add_argument("--mmdc", default=os.environ.get("MMDC", "mmdc"),
                        help="Mermaid CLI binary (default $MMDC or mmdc)")
    args = parser.parse_args(argv)

    plan = json.loads(args.map.expanduser().read_text())
    repo = args.repo.expanduser()
    out = args.out.expanduser()
    png = args.png.expanduser() if args.png else None
    commits = load_commits(repo, args.rev_range)
    source = mermaid_source(plan, commits)
    remote = remote_state(repo, args.rev_range, args.remote)
    with tempfile.TemporaryDirectory() as folder:
        mmd = Path(folder) / "diagram.mmd"
        mmd.write_text(source)
        svg_path = Path(folder) / "diagram.svg"
        render(args.mmdc, mmd, svg_path, args.background)
        svg = add_titles(svg_path.read_text(), commits)
        if png:
            render(args.mmdc, mmd, png, args.background, ("-w", "1800", "-s", "2"))
            if args.chat_factor > 1:
                shrink(png, png.with_name(png.stem + "-chat.png"), args.chat_factor)
    messages = {c["sha"][:8]: {"short": c["short"], "date": c["date"], "message": c["message"]}
                for c in commits}
    generated = datetime.now().strftime("%Y-%m-%d %H:%M")
    out.write_text(PAGE.format(
        title=html.escape(plan["title"]), range=html.escape(args.rev_range), count=len(commits),
        generated=generated, remote=html.escape(remote), background=args.background,
        remote_colour="#b71c1c" if remote.startswith("NOT") else "#2e7d32",
        svg=svg, messages=json.dumps(messages).replace("</", "<\\/")))
    print(f"{out}  ({len(commits)} commits, all mapped; {remote})")


if __name__ == "__main__":
    main()
