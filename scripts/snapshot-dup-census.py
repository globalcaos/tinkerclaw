#!/usr/bin/env python3
"""snapshot-dup-census — one row per per-session Tinker UI snapshot on disk, counting the
assistant bubbles that were painted more than once.

INCIDENT 2026-09-08: the architect's long-lived tabs painted the same assistant answer two and
three times while the transcript held exactly one copy, and the per-session snapshots under
~/.openclaw/data (tinker-ui-snapshot.<slug>.html + .json — the app's own mirror of #messages on
every render) are the only durable record of what each of those tabs ACTUALLY showed. This census
turns that record into one number per snapshot: zeros on every build after the fix are the proof,
and the old snapshots keep reporting their duplicates, because a census that hid them would prove
nothing.

usage: snapshot-dup-census.py [--build <sha-prefix>] [--since <ISO-8601>] [--verbose]

  --build   keep only snapshots whose build stamp starts with the prefix. The stamp is the
            sidecar's `build` field, else #messages[data-ui-build] in the html; a snapshot with
            neither prints `none` and is OUT of scope under --build (it cannot be attributed).
  --since   keep only snapshots whose sidecar `ts` is >= the given instant (Z or an offset).
  --verbose after the table, list every duplicate group as kind / sha1[:10] / length / count.
            Never the text: the transcript stays off the terminal.

A bubble is any element carrying both the `msg` and `assistant` classes under #messages;
`msg-thinking` splits thinking from answer. Its body is the whitespace-normalised text of the
subtree; its identity is `data-oc-id` + `data-oc-part` when renderMsg stamped one (a server-backed
row; one row paints several parts, which are not copies of each other). A PAIR of bubbles is a
duplicate when both carry the same identity+part (the same row painted twice, whatever the text),
or when their bodies are equal (>= 40 characters; a legitimately repeated "Done." is not the bug)
and NOT both distinct stamped rows — one side is a client-written bubble that the server's copy
then joined, the class that doubled the tabs. Equal bodies on two DISTINCT server rows are the
transcript repeating itself (a rate-limit note hours apart); they are counted as `legit`, shown,
never red. Snapshots from builds before the stamp existed carry no identities, so there every
equal pair counts — old rows keep their duplicates on purpose. The html is walked tag by tag
(html.parser) — never one regex over the file: a bubble can quote markup, and one snapshot on disk
already carries the app's own template source as visible text.

Exit 1 if any snapshot in scope has dup pairs > 0. Reads only; writes nothing but stdout.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser

SNAP_DIR = os.path.expanduser("~/.openclaw/data")
STEM = "tinker-ui-snapshot"
MIN_LEN = 40
VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}
WS = re.compile(r"\s+")


class BubbleWalker(HTMLParser):
    """Tag walk of one snapshot: finds #messages, collects every .msg.assistant body inside it."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.msg_depth: int | None = None
        self.done = False
        self.skip = 0  # > 0 while inside <script>/<style>: not text a reader sees
        self.open: list[list] = []  # [depth, is_thinking, parts, identity]
        self.thinking: list[tuple[str, str]] = []  # (body, identity-or-"")
        self.answer: list[tuple[str, str]] = []
        self.build = ""

    def handle_starttag(self, tag: str, attrs) -> None:
        if self.done or tag in VOID:
            return
        self.stack.append(tag)
        a = dict(attrs)
        if self.msg_depth is None:
            if a.get("id") == "messages":
                self.msg_depth = len(self.stack)
                self.build = (a.get("data-ui-build") or "").strip()
            return
        classes = set((a.get("class") or "").split())
        if "msg" in classes and "assistant" in classes:
            oc_id = (a.get("data-oc-id") or "").strip()
            ident = f"{oc_id}|{(a.get('data-oc-part') or '').strip()}" if oc_id else ""
            self.open.append([len(self.stack), "msg-thinking" in classes, [], ident])
        if tag in ("script", "style"):
            self.skip += 1

    def handle_startendtag(self, tag: str, attrs) -> None:
        if tag in VOID:
            return
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if self.done or tag in VOID or tag not in self.stack:
            return
        while self.stack:
            t = self.stack.pop()
            depth = len(self.stack) + 1
            if t in ("script", "style") and self.skip:
                self.skip -= 1
            while self.open and self.open[-1][0] == depth:
                _, is_thinking, parts, ident = self.open.pop()
                body = WS.sub(" ", "".join(parts)).strip()
                (self.thinking if is_thinking else self.answer).append((body, ident))
            if self.msg_depth is not None and depth == self.msg_depth:
                self.done = True
                self.stack.clear()
                return
            if t == tag:
                return

    def handle_data(self, data: str) -> None:
        if self.done or self.msg_depth is None or self.skip or not self.open:
            return
        for bubble in self.open:
            bubble[2].append(data)


def walk(html_path: str) -> BubbleWalker:
    w = BubbleWalker()
    with open(html_path, encoding="utf-8", errors="replace") as f:
        w.feed(f.read())
    w.close()
    return w


def load_sidecar(html_path: str) -> dict | None:
    p = html_path[: -len(".html")] + ".json"
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {"_corrupt": True}
    except (OSError, ValueError):
        return {"_corrupt": True}


def parse_iso(s: str | None) -> datetime | None:
    if not s or not isinstance(s, str):
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def dup_groups(bubbles: list[tuple[str, str]]) -> list[tuple[str, int]]:
    """Equal-body groups (for --verbose): (body, count) over bodies >= MIN_LEN."""
    counts = Counter(b for b, _ in bubbles if len(b) >= MIN_LEN)
    return [(b, n) for b, n in counts.items() if n > 1]


def pairs(bubbles: list[tuple[str, str]]) -> tuple[int, int]:
    """(duplicate pairs, legit pairs) — the one definition scripts/ui-dup-proof.mjs measures with.

    Duplicate: same identity+part painted twice, or equal bodies (>= MIN_LEN) where NOT both members
    are distinct stamped rows. Legit: equal bodies on two DISTINCT stamped rows.
    """
    dup = 0
    legit = 0
    n = len(bubbles)
    for i in range(n):
        body_a, id_a = bubbles[i]
        for j in range(i + 1, n):
            body_b, id_b = bubbles[j]
            if id_a and id_a == id_b:
                dup += 1
                continue
            if len(body_a) >= MIN_LEN and body_a == body_b:
                if id_a and id_b:
                    legit += 1
                else:
                    dup += 1
    return dup, legit


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", metavar="SHA-PREFIX", help="only snapshots whose build stamp starts with this")
    ap.add_argument("--since", metavar="ISO", help="only snapshots with sidecar ts >= this instant")
    ap.add_argument("--verbose", action="store_true", help="list duplicate groups (hash/len/count, never text)")
    ap.add_argument("--dir", default=SNAP_DIR, help=argparse.SUPPRESS)
    args = ap.parse_args()

    since = parse_iso(args.since) if args.since else None
    if args.since and since is None:
        print(f"--since: not an ISO-8601 instant: {args.since!r}")
        return 2

    print("snapshot-dup-census — exact-duplicate assistant bubbles per per-session Tinker UI snapshot")
    print("INCIDENT 2026-09-08: long-lived tabs painted the same answer 2-3x while the transcript held")
    print("one copy; these snapshots are the record of what each tab showed. Old rows keep their")
    print(f"duplicates on purpose. bodies >= {MIN_LEN} chars; a pair is a duplicate on the same server")
    print("identity+part, or on equal bodies unless both are distinct stamped rows (those are `legit`,")
    print("the transcript repeating itself). T = thinking, A = answer.")
    print("")

    files = sorted(glob.glob(os.path.join(args.dir, f"{STEM}.*.html")))
    rows = []
    for html_path in files:
        meta = load_sidecar(html_path)
        if meta is None:
            continue  # no sidecar: not an identified snapshot
        slug = os.path.basename(html_path)[len(STEM) + 1 : -len(".html")]
        ts = parse_iso(meta.get("ts"))
        w = walk(html_path)
        build = meta.get("build") or meta.get("uiBuild") or w.build or ""
        build = str(build).strip() or "none"
        rows.append(
            {
                "slug": slug,
                "ts": ts,
                "ts_raw": "corrupt" if meta.get("_corrupt") else (meta.get("ts") or "?"),
                "build": build,
                "bubbles": len(w.thinking) + len(w.answer),
                "stamped": sum(1 for _, ident in w.thinking + w.answer if ident),
                "t_pairs": pairs(w.thinking),
                "a_pairs": pairs(w.answer),
                "t_groups": dup_groups(w.thinking),
                "a_groups": dup_groups(w.answer),
            }
        )

    rows.sort(key=lambda r: (r["ts"] or datetime.min.replace(tzinfo=timezone.utc), r["slug"]))
    in_scope = []
    for r in rows:
        if args.build and (r["build"] == "none" or not r["build"].startswith(args.build)):
            continue
        if since and (r["ts"] is None or r["ts"] < since):
            continue
        in_scope.append(r)

    slug_w = max([len(r["slug"]) for r in in_scope] + [len("slug")])
    build_w = max([len(r["build"]) for r in in_scope] + [len("build")])
    print(
        f"{'slug'.ljust(slug_w)}  {'sidecar ts'.ljust(20)}  {'build'.ljust(build_w)}  "
        "bubbles  stamped  dupT  dupA  legit"
    )
    bad = 0
    for r in in_scope:
        tp, t_legit = r["t_pairs"]
        apairs, a_legit = r["a_pairs"]
        if tp or apairs:
            bad += 1
        ts_txt = r["ts"].astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if r["ts"] else r["ts_raw"][:20]
        print(
            f"{r['slug'].ljust(slug_w)}  {ts_txt.ljust(20)}  {r['build'].ljust(build_w)}  "
            f"{str(r['bubbles']).rjust(7)}  {str(r['stamped']).rjust(7)}  {str(tp).rjust(4)}  "
            f"{str(apairs).rjust(4)}  {str(t_legit + a_legit).rjust(5)}"
        )
        if args.verbose and (tp or apairs):
            for kind, groups in (("thinking", r["t_groups"]), ("answer", r["a_groups"])):
                for body, n in sorted(groups, key=lambda g: -g[1]):
                    h = hashlib.sha1(body.encode("utf-8")).hexdigest()[:10]
                    print(f"    {kind:8s}  sha1={h}  len={len(body):6d}  x{n}")

    print("")
    print(
        f"{len(in_scope)} snapshot(s) in scope of {len(rows)} on disk; "
        f"{bad} with duplicate pairs"
        + (f"; filters: build^={args.build!r}" if args.build else "")
        + (f", since={args.since}" if args.since else "")
    )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
