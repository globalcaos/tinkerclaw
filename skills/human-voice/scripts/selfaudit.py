#!/usr/bin/env python3
"""selfaudit.py — how Claude-ish the agent's own replies are, against a human baseline.

Built 2026-09-25 after the second research wave named "Claudespeak" as a dialect people spot on
sight. Counts the claudeisms-list patterns per million words in the agent's assistant text from the
last N days of session transcripts (reflection blocks excluded), and the same patterns in a human
baseline: the owner's own messages, if you point it at them. Re-run after every model upgrade and
update references/claudeisms.md.

  python3 selfaudit.py [--days 7] [--sessions GLOB] [--baseline FILE | --baseline-db PATH]
                       [--agent-name NAME] [--strip-after MARKER]

  --sessions     transcript glob (JSONL, one event per line with message.role/content)
                 default $HUMAN_VOICE_SESSIONS or ~/.openclaw/agents/main/sessions/*.jsonl
  --baseline     plain text file, one human message per line (e.g. the owner's own sent messages)
                 default $HUMAN_VOICE_BASELINE when it does not end in .db
  --baseline-db  SQLite message archive with a table messages(chat_jid, from_me, message_type,
                 text_content); sent text messages (from_me=1) are read, read-only
                 default $HUMAN_VOICE_BASELINE when it ends in .db
  --agent-name   lines starting with this name are prompts to the agent, not messages to people
                 default $HUMAN_VOICE_AGENT_NAME or "jarvis"
  --strip-after  drop everything after this marker in each reply (a reflection or footer block)
                 default $HUMAN_VOICE_STRIP_MARKER or "🌿 FRACTAL"

Without a baseline it prints the agent's rates only. Everything is read locally; nothing is sent.
"""
import glob
import json
import os
import re
import sqlite3
import sys
import time


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


if "-h" in sys.argv or "--help" in sys.argv:
    print(__doc__)
    sys.exit(0)

DAYS = int(arg("--days", 7))
SESSIONS = arg("--sessions", os.environ.get("HUMAN_VOICE_SESSIONS", "~/.openclaw/agents/main/sessions/*.jsonl"))
_env_base = os.environ.get("HUMAN_VOICE_BASELINE", "")
BASELINE = arg("--baseline", "" if _env_base.endswith(".db") else _env_base)
BASELINE_DB = arg("--baseline-db", _env_base if _env_base.endswith(".db") else "")
AGENT = arg("--agent-name", os.environ.get("HUMAN_VOICE_AGENT_NAME", "jarvis")).lower()
STRIP = arg("--strip-after", os.environ.get("HUMAN_VOICE_STRIP_MARKER", "🌿 FRACTAL"))

PATS = {
    "em dash": r"—", "rather than": r"\brather than\b", "verified": r"\bverified\b",
    "honest/honestly": r"\bhonest(ly)?\b", "stale": r"\bstale\b", "genuinely": r"\bgenuinely\b",
    "landed": r"\blanded\b", "silently": r"\bsilently\b", "surface(d)": r"\bsurfaced?\b",
    "wired": r"\bwired\b", "canonical": r"\bcanonical\b", "quietly": r"\bquietly\b",
    "plainly": r"\bplainly\b", "drift": r"\bdrift(s|ed)?\b", "seam": r"\bseams?\b",
    "load-bearing": r"\bload[- ]bearing\b", "you're absolutely right": r"you'?re absolutely right",
    "great catch": r"\bgreat catch\b", "want to be careful": r"\bwant to be careful\b",
    "doing a lot of work": r"doing a lot of (the )?work",
}
EN = re.compile(r"\b(the|and|is|you|that|with|have|this|for)\b", re.I)


def rates(text):
    words = max(1, len(text.split()))
    low = text.lower()
    return words, {k: len(re.findall(p, low)) for k, p in PATS.items()}


def mine():
    cut = time.time() - DAYS * 86400
    parts = []
    for f in glob.glob(os.path.expanduser(SESSIONS)):
        if f.endswith("trajectory.jsonl") or os.path.getmtime(f) < cut:
            continue
        for line in open(f, errors="ignore"):
            if '"assistant"' not in line:
                continue
            try:
                m = json.loads(line).get("message") or {}
            except ValueError:
                continue
            if m.get("role") != "assistant":
                continue
            c = m.get("content")
            t = c if isinstance(c, str) else "".join(
                b.get("text", "") for b in (c or []) if isinstance(b, dict) and b.get("type") == "text")
            parts.append(t.split(STRIP)[0] if STRIP else t)
    return " ".join(parts)


def agentish(t):
    """Text the agent drafted and sent from the owner's account, or a prompt to the agent."""
    return (t.startswith(("🤖", "[openclaw]", "/", "{")) or (AGENT and t.lower().startswith(AGENT))
            or "**" in t or "`" in t or "\n- " in t or "\n1." in t or t.count("\n") >= 3)


def baseline():
    """The human's own English messages, agent-drafted lines removed. Returns '' when none is set."""
    if BASELINE:
        lines = open(os.path.expanduser(BASELINE), encoding="utf-8", errors="ignore").read().splitlines()
        return " ".join(t for t in lines if t.strip() and not agentish(t) and len(EN.findall(t)) >= 2)
    if not BASELINE_DB:
        return ""
    db = os.path.expanduser(BASELINE_DB)
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    # self/assistant chats = chats where only the owner (and their agent) ever write
    solo = {j for j, n, sent in c.execute(
        "select chat_jid, count(*), sum(from_me) from messages group by chat_jid") if n > 30 and sent == n}
    rows = c.execute("select chat_jid, coalesce(text_content,'') from messages "
                     "where from_me=1 and message_type='text'").fetchall()
    keep = [t for j, t in rows if j not in solo and not agentish(t) and len(EN.findall(t)) >= 2]
    return " ".join(keep)


if __name__ == "__main__":
    wm, rm = rates(mine())
    base = baseline()
    if not base:
        print(f"agent: last {DAYS} days, {wm:,} words   |   no human baseline (see --help)")
        print(f"{'pattern':26s} {'agent /M':>9s}")
        for k in sorted(PATS, key=lambda k: -rm[k]):
            print(f"{k:26s} {rm[k] * 1e6 / wm:9.0f}")
        sys.exit(0)
    wo, ro = rates(base)
    print(f"agent: last {DAYS} days, {wm:,} words   |   human baseline: {wo:,} English words")
    print(f"{'pattern':26s} {'agent /M':>9s} {'human /M':>9s}")
    for k in sorted(PATS, key=lambda k: -rm[k]):
        print(f"{k:26s} {rm[k] * 1e6 / wm:9.0f} {ro[k] * 1e6 / wo:9.0f}")
