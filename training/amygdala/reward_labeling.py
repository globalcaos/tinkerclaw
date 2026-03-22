#!/usr/bin/env python3
"""
reward_labeling.py — Offline Reward Labeling for PPO (Addendum B)
==================================================================
Batch-process session transcripts and label each action event with
one of 8 reward signals from the AMYGDALA taxonomy.

Two-tier strategy:
  1. Programmatic signals (fast, regex/keyword)  — no LLM needed
  2. LLM signals (Ollama llama3:8b) for subjective / ambiguous cases

Reward Signal Taxonomy:
  0  EXPLICIT_CORRECTION     "you shouldn't have done that"     → -1.0
  1  FILE_RESTORATION        file was restored/reverted         → -1.0
  2  NEVER_DO_THAT_AGAIN     "never do that again"              → -0.9
  3  MILD_CORRECTION         "next time, try…"                  → -0.4
  4  NO_COMPLAINT            silence / neutral 72h              → +0.5
  5  EXPLICIT_APPROVAL       "well done", "perfect", 👍         → +1.0
  6  USER_OVERRIDES_BLOCK    user said "just do it" after block → +0.6
  7  USER_AGREES_WITH_BLOCK  user confirmed agent was right     → +0.9

Usage:
    python reward_labeling.py [--db PATH] [--sessions DIR] [--no-llm]

Output: table `reward_labels` in the training SQLite database.
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import IntEnum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

SESSIONS_DIR = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
DEFAULT_DB = Path.home() / "src" / "tinkerclaw" / "data" / "amygdala" / "training.sqlite"

OLLAMA_MODEL = "llama3:8b"
OLLAMA_URL = "http://localhost:11434/api/generate"


# ─────────────────────────────────────────────────────────────
# Reward Signal Taxonomy
# ─────────────────────────────────────────────────────────────

class RewardSignal(IntEnum):
    EXPLICIT_CORRECTION   = 0
    FILE_RESTORATION      = 1
    NEVER_DO_THAT_AGAIN   = 2
    MILD_CORRECTION       = 3
    NO_COMPLAINT          = 4
    EXPLICIT_APPROVAL     = 5
    USER_OVERRIDES_BLOCK  = 6
    USER_AGREES_WITH_BLOCK = 7


SIGNAL_VALUES: Dict[RewardSignal, float] = {
    RewardSignal.EXPLICIT_CORRECTION:    -1.0,
    RewardSignal.FILE_RESTORATION:       -1.0,
    RewardSignal.NEVER_DO_THAT_AGAIN:    -0.9,
    RewardSignal.MILD_CORRECTION:        -0.4,
    RewardSignal.NO_COMPLAINT:           +0.5,
    RewardSignal.EXPLICIT_APPROVAL:      +1.0,
    RewardSignal.USER_OVERRIDES_BLOCK:   +0.6,
    RewardSignal.USER_AGREES_WITH_BLOCK: +0.9,
}

SIGNAL_NAMES = {s: s.name for s in RewardSignal}


@dataclass
class LabelResult:
    signal: RewardSignal
    reward: float
    source: str  # "programmatic" | "llm" | "heuristic"
    confidence: float = 1.0
    notes: str = ""


# ─────────────────────────────────────────────────────────────
# Programmatic signal detection
# ─────────────────────────────────────────────────────────────

_EXPLICIT_CORRECTION = [
    "that was wrong", "you shouldn't have", "don't do that again",
    "that's incorrect", "you made a mistake", "undo what you did",
    "revert that", "you broke", "roll back", "fix that", "wrong approach",
    "that's not what i wanted", "bad decision",
]

_NEVER_AGAIN = [
    "never do that again", "never ever", "absolutely not", "do not ever",
    "that must never happen", "forbidden", "under no circumstances",
]

_MILD_CORRECTION = [
    "next time", "better to", "prefer to", "could have", "would have been better",
    "slight issue", "minor problem", "almost right",
]

_FILE_RESTORE_TOOLS = {"write", "edit"}  # If these are called on same file within 24h after action

_EXPLICIT_APPROVAL = [
    "well done", "great job", "perfect", "exactly right", "that's exactly",
    "thank you", "brilliant", "excellent", "nice work", "👍", "✅", "🎉",
    "approved", "correct", "that worked", "exactly what i needed",
]

_USER_OVERRIDES_BLOCK = [
    "just do it", "do it anyway", "i know the risk", "proceed anyway",
    "override", "bypass", "ignore the warning", "i allow", "go ahead",
]

_USER_AGREES_WITH_BLOCK = [
    "you were right", "good call", "yes, don't do that", "correct to stop",
    "you're right to block", "that was the right call",
]


def detect_programmatic(
    action_ts: str,
    action_tool: str,
    action_args: Dict[str, Any],
    subsequent_user_messages: List[Tuple[str, datetime]],  # (text, ts)
    subsequent_tool_calls: List[Tuple[str, Dict[str, Any], datetime]],  # (tool, args, ts)
) -> Optional[LabelResult]:
    """
    Tier 1: fast programmatic signal detection.
    Returns a LabelResult if a signal is found, else None.
    """
    try:
        base_ts = datetime.fromisoformat(action_ts.replace("Z", "+00:00"))
    except Exception:
        base_ts = datetime.now()

    window_24h = base_ts + timedelta(hours=24)
    window_72h = base_ts + timedelta(hours=72)

    # Check NEVER_DO_THAT_AGAIN (strongest negative — check first)
    for text, ts in subsequent_user_messages:
        if ts <= window_24h:
            low = text.lower()
            if any(p in low for p in _NEVER_AGAIN):
                return LabelResult(RewardSignal.NEVER_DO_THAT_AGAIN, -0.9, "programmatic",
                                   notes="matched never-again phrase")

    # Check EXPLICIT_CORRECTION
    for text, ts in subsequent_user_messages:
        if ts <= window_24h:
            low = text.lower()
            if any(p in low for p in _EXPLICIT_CORRECTION):
                return LabelResult(RewardSignal.EXPLICIT_CORRECTION, -1.0, "programmatic",
                                   notes="matched correction phrase")

    # Check FILE_RESTORATION (write/edit same file within 24h)
    if action_tool in _FILE_RESTORE_TOOLS:
        original_file = action_args.get("file_path") or action_args.get("path") or ""
        if original_file:
            for tool, args, ts in subsequent_tool_calls:
                if ts <= window_24h and tool in _FILE_RESTORE_TOOLS:
                    restored_file = args.get("file_path") or args.get("path") or ""
                    if restored_file == original_file:
                        return LabelResult(RewardSignal.FILE_RESTORATION, -1.0, "programmatic",
                                           notes=f"file re-written: {original_file}")

    # Check EXPLICIT_APPROVAL
    for text, ts in subsequent_user_messages:
        low = text.lower()
        if any(p in low for p in _EXPLICIT_APPROVAL):
            return LabelResult(RewardSignal.EXPLICIT_APPROVAL, +1.0, "programmatic",
                               notes="matched approval phrase")

    # Check USER_OVERRIDES_BLOCK (user follow-up after blocked action)
    for text, ts in subsequent_user_messages:
        if ts <= window_24h:
            low = text.lower()
            if any(p in low for p in _USER_OVERRIDES_BLOCK):
                return LabelResult(RewardSignal.USER_OVERRIDES_BLOCK, +0.6, "programmatic",
                                   notes="user overrode safety block")

    # Check USER_AGREES_WITH_BLOCK
    for text, ts in subsequent_user_messages:
        low = text.lower()
        if any(p in low for p in _USER_AGREES_WITH_BLOCK):
            return LabelResult(RewardSignal.USER_AGREES_WITH_BLOCK, +0.9, "programmatic",
                               notes="user agreed with block")

    # Check MILD_CORRECTION
    for text, ts in subsequent_user_messages:
        if ts <= window_24h:
            low = text.lower()
            if any(p in low for p in _MILD_CORRECTION):
                return LabelResult(RewardSignal.MILD_CORRECTION, -0.4, "programmatic",
                                   notes="matched mild-correction phrase")

    # NO_COMPLAINT heuristic: no negative signal within 72h
    latest_ts = max((ts for _, ts in subsequent_user_messages), default=None)
    if latest_ts and latest_ts >= window_72h:
        return LabelResult(RewardSignal.NO_COMPLAINT, +0.5, "heuristic",
                           notes="no complaint in 72h window")

    return None  # Ambiguous — escalate to LLM


# ─────────────────────────────────────────────────────────────
# LLM-based labeling (Ollama — optional)
# ─────────────────────────────────────────────────────────────

_ollama_available: Optional[bool] = None


def _check_ollama() -> bool:
    global _ollama_available
    if _ollama_available is not None:
        return _ollama_available
    try:
        import urllib.request
        req = urllib.request.Request("http://localhost:11434/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=3) as r:
            _ollama_available = r.status == 200
    except Exception:
        _ollama_available = False
    if _ollama_available:
        log.info("Ollama is available at localhost:11434")
    else:
        log.warning("Ollama not available — LLM labeling disabled. Install: curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3:8b")
    return _ollama_available  # type: ignore


def llm_label(
    action_description: str,
    preceding_context: str,
    subsequent_user_text: str,
) -> Optional[LabelResult]:
    """
    Tier 2: Ask local LLM to classify the reward signal.
    Falls back gracefully if Ollama is unavailable.
    """
    if not _check_ollama():
        return None

    prompt = f"""You are a reward labeler for an AI agent training system. 
Given an action the agent took and what happened afterward, classify it with ONE of these 8 signals:

0 EXPLICIT_CORRECTION   - User clearly said the action was wrong (-1.0)
1 FILE_RESTORATION      - A file the agent wrote was immediately reverted (-1.0)
2 NEVER_DO_THAT_AGAIN   - User demanded this never happen again (-0.9)
3 MILD_CORRECTION       - User gave gentle feedback / mild preference change (-0.4)
4 NO_COMPLAINT          - Nothing happened, no feedback (neutral +0.5)
5 EXPLICIT_APPROVAL     - User said it was good, well done, etc. (+1.0)
6 USER_OVERRIDES_BLOCK  - User told agent to proceed despite a safety block (+0.6)
7 USER_AGREES_WITH_BLOCK - User confirmed agent was right to block (+0.9)

Agent action: {action_description[:300]}
Context before action: {preceding_context[:300]}
User response after: {subsequent_user_text[:400]}

Reply with ONLY a JSON object: {{"signal": <0-7>, "confidence": <0.0-1.0>, "reason": "<one sentence>"}}
"""

    try:
        import urllib.request
        import json as _json
        payload = _json.dumps({
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 80},
        }).encode()
        req = urllib.request.Request(
            OLLAMA_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = _json.loads(r.read())
        raw = resp.get("response", "").strip()
        # Extract JSON from response
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            parsed = _json.loads(raw[start:end])
            signal_id = int(parsed["signal"])
            signal = RewardSignal(signal_id)
            confidence = float(parsed.get("confidence", 0.7))
            reason = parsed.get("reason", "")
            return LabelResult(signal, SIGNAL_VALUES[signal], "llm",
                               confidence=confidence, notes=reason)
    except Exception as exc:
        log.debug("LLM labeling failed: %s", exc)
    return None


# ─────────────────────────────────────────────────────────────
# Session processing
# ─────────────────────────────────────────────────────────────

def iter_events(path: Path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def label_session(
    session_path: Path,
    use_llm: bool = True,
) -> List[Dict[str, Any]]:
    """Label all action events in a session. Returns list of label dicts."""
    events = list(iter_events(session_path))
    if not events:
        return []

    session_id = events[0].get("id", session_path.stem)
    results = []

    for i, event in enumerate(events):
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") != "assistant":
            continue

        content = msg.get("content") or []
        tool_calls_here = [c for c in content if isinstance(c, dict) and c.get("type") == "toolCall"]
        if not tool_calls_here:
            continue

        action_ts = event.get("timestamp", "")

        # Build subsequent events context
        subsequent = events[i + 1:]

        subsequent_user_msgs: List[Tuple[str, datetime]] = []
        subsequent_tool_calls: List[Tuple[str, Dict[str, Any], datetime]] = []
        subsequent_user_text_combined = ""

        for sev in subsequent:
            sev_ts_str = sev.get("timestamp", "")
            try:
                sev_ts = datetime.fromisoformat(sev_ts_str.replace("Z", "+00:00"))
            except Exception:
                continue
            smsg = sev.get("message", {})
            if smsg.get("role") == "user":
                scontent = smsg.get("content") or []
                text = " ".join(c.get("text", "") for c in scontent
                                if isinstance(c, dict) and c.get("type") == "text")
                subsequent_user_msgs.append((text, sev_ts))
                subsequent_user_text_combined += " " + text
            elif smsg.get("role") == "assistant":
                scontent = smsg.get("content") or []
                for sc in scontent:
                    if isinstance(sc, dict) and sc.get("type") == "toolCall":
                        sargs = sc.get("arguments", {}) or {}
                        subsequent_tool_calls.append((sc.get("name", ""), sargs, sev_ts))

        # Find last user message before this action (for context)
        preceding_user_text = ""
        for j in range(i - 1, -1, -1):
            pm = events[j].get("message", {})
            if pm.get("role") == "user":
                pc = pm.get("content") or []
                preceding_user_text = " ".join(c.get("text", "") for c in pc
                                               if isinstance(c, dict) and c.get("type") == "text")[:400]
                break

        for tc in tool_calls_here:
            tool_name = tc.get("name", "")
            tool_args = tc.get("arguments", {}) or {}

            # Skip non-action tools
            from mine_history import classify_action, ACTION_TYPES
            action_type = classify_action(tool_name, tool_args)
            if action_type not in ACTION_TYPES:
                continue

            # Tier 1: programmatic
            result = detect_programmatic(
                action_ts=action_ts,
                action_tool=tool_name,
                action_args=tool_args,
                subsequent_user_messages=subsequent_user_msgs,
                subsequent_tool_calls=subsequent_tool_calls,
            )

            # Tier 2: LLM (if programmatic was inconclusive and LLM enabled)
            if result is None and use_llm:
                action_desc = f"{tool_name}: {json.dumps(tool_args)[:150]}"
                result = llm_label(
                    action_description=action_desc,
                    preceding_context=preceding_user_text,
                    subsequent_user_text=subsequent_user_text_combined[:500],
                )

            # Fallback: unknown / neutral
            if result is None:
                result = LabelResult(RewardSignal.NO_COMPLAINT, 0.0, "unknown",
                                     confidence=0.3, notes="no signal detected")

            results.append({
                "session_id": session_id,
                "action_id": tc.get("id", ""),
                "timestamp": action_ts,
                "tool_name": tool_name,
                "action_type": action_type,
                "signal": int(result.signal),
                "signal_name": result.signal.name,
                "reward": result.reward,
                "source": result.source,
                "confidence": result.confidence,
                "notes": result.notes,
            })

    return results


# ─────────────────────────────────────────────────────────────
# SQLite output
# ─────────────────────────────────────────────────────────────

def init_reward_db(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS reward_labels (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL,
            action_id   TEXT,
            timestamp   TEXT,
            tool_name   TEXT,
            action_type TEXT,
            signal      INTEGER,
            signal_name TEXT,
            reward      REAL,
            source      TEXT,
            confidence  REAL,
            notes       TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rl_session ON reward_labels(session_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rl_signal ON reward_labels(signal)")
    conn.commit()


def insert_labels(conn: sqlite3.Connection, labels: List[Dict[str, Any]]) -> None:
    conn.executemany("""
        INSERT INTO reward_labels
            (session_id, action_id, timestamp, tool_name, action_type,
             signal, signal_name, reward, source, confidence, notes)
        VALUES (:session_id, :action_id, :timestamp, :tool_name, :action_type,
                :signal, :signal_name, :reward, :source, :confidence, :notes)
    """, labels)
    conn.commit()


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="AMYGDALA Offline Reward Labeling (Addendum B)")
    parser.add_argument("--sessions", type=Path, default=SESSIONS_DIR)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--no-llm", action="store_true", help="Skip Ollama LLM tier")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    session_files = sorted(args.sessions.glob("*.jsonl"))
    log.info("Labeling %d sessions", len(session_files))

    if not args.dry_run:
        args.db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(args.db))
        conn.execute("PRAGMA journal_mode=WAL")
        init_reward_db(conn)

    total = 0
    signal_counts = {s.name: 0 for s in RewardSignal}

    for idx, path in enumerate(session_files):
        labels = label_session(path, use_llm=not args.no_llm)
        for lbl in labels:
            signal_counts[lbl["signal_name"]] = signal_counts.get(lbl["signal_name"], 0) + 1

        if not args.dry_run and labels:
            insert_labels(conn, labels)  # type: ignore

        total += len(labels)
        if (idx + 1) % 10 == 0:
            log.info("Progress: %d/%d sessions, %d labels", idx + 1, len(session_files), total)

    if not args.dry_run:
        conn.close()  # type: ignore

    print(json.dumps({
        "sessions": len(session_files),
        "total_labels": total,
        "signal_distribution": signal_counts,
    }, indent=2))


if __name__ == "__main__":
    main()
