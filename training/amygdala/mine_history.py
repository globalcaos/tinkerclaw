#!/usr/bin/env python3
"""
mine_history.py — P0.5.3 Historical Data Mining
================================================
Parse deployment history (JSONL session transcripts) to extract labeled
training examples for the AMYGDALA Prudence and Personality networks.

Target: 2,000–5,000 labeled examples from ~4 months of history.

Usage:
    python mine_history.py [--sessions DIR] [--db PATH] [--dry-run]

Output schema (training.sqlite, table: mined_examples):
    id              INTEGER PRIMARY KEY
    session_id      TEXT
    action_id       TEXT
    timestamp       TEXT (ISO-8601)
    action_type     TEXT  (write|message|exec|git|read|other)
    tool_name       TEXT
    situation_json  TEXT  (reconstructed situation template as JSON)
    embedding       BLOB  (float32 array, 512-dim)
    outcome_label   REAL  (-1.0 | 0.0 | 0.5 | 0.8 | 1.0)
    label_source    TEXT  (programmatic|heuristic)
    notes           TEXT
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
import sqlite3
import struct
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Tuple

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────

SESSIONS_DIR = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
DEFAULT_DB = Path.home() / "src" / "tinkerclaw" / "data" / "amygdala" / "training.sqlite"

# Action-taking tool names → canonical action type
ACTION_TOOL_MAP: Dict[str, str] = {
    "write": "write",
    "edit": "write",
    "Read": "read",
    "read": "read",
    "exec": "exec",
    "message": "message",
    "tts": "message",
    "browser": "exec",
    "web_fetch": "read",
    "web_search": "read",
    "image": "read",
    "pdf": "read",
    "canvas": "exec",
    "process": "exec",
}

ACTION_TYPES = {"write", "exec", "message", "git"}

# Correction signal phrases (programmatic detection)
CORRECTION_PHRASES = [
    "don't do that", "never do that", "stop doing", "that was wrong",
    "you shouldn't have", "revert", "undo", "fix that", "that's not right",
    "incorrect", "mistake", "wrong", "bad idea", "please don't",
    "restore the file", "you broke", "roll back",
]

POSITIVE_PHRASES = [
    "well done", "good job", "perfect", "exactly right", "great", "thank you",
    "that's correct", "nice", "exactly what i wanted", "approved", "👍", "✅",
]


# ─────────────────────────────────────────────────────────────
# JSONL parsing
# ─────────────────────────────────────────────────────────────

def iter_session_events(path: Path) -> Generator[Dict[str, Any], None, None]:
    """Yield parsed JSON objects from a JSONL session transcript, skipping malformed lines."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                log.debug("Skipping malformed line %d in %s: %s", lineno, path.name, exc)


def extract_tool_calls(event: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract toolCall content blocks from a message event."""
    msg = event.get("message", {})
    content = msg.get("content") or []
    return [c for c in content if isinstance(c, dict) and c.get("type") == "toolCall"]


def classify_action(tool_name: str, args: Dict[str, Any]) -> str:
    """Map tool name + args to a canonical action type."""
    base = ACTION_TOOL_MAP.get(tool_name, "other")
    if base == "exec":
        cmd = args.get("command", "")
        if isinstance(cmd, str) and any(k in cmd for k in ("git commit", "git push", "git add")):
            return "git"
    return base


# ─────────────────────────────────────────────────────────────
# Situation template reconstruction
# ─────────────────────────────────────────────────────────────

def reconstruct_situation(
    session_id: str,
    event: Dict[str, Any],
    tool_call: Dict[str, Any],
    preceding_user_text: str,
) -> Dict[str, Any]:
    """
    Build a situation template dict from logged metadata.
    Mirrors the TypeScript SituationTemplate interface in types.ts.
    """
    ts = event.get("timestamp", "")
    args = tool_call.get("arguments", {})
    tool_name = tool_call.get("name", "unknown")
    action_type = classify_action(tool_name, args)

    # Extract a short description of the action
    if action_type == "write":
        target = args.get("file_path") or args.get("path") or ""
        description = f"Write/edit file: {target}"
    elif action_type == "message":
        target = args.get("target") or args.get("channel") or ""
        description = f"Send message to: {target}"
    elif action_type == "exec":
        cmd = str(args.get("command", ""))[:120]
        description = f"Execute: {cmd}"
    elif action_type == "git":
        cmd = str(args.get("command", ""))[:120]
        description = f"Git operation: {cmd}"
    else:
        description = f"Tool call: {tool_name}"

    return {
        "session_id": session_id,
        "action_id": tool_call.get("id", ""),
        "timestamp": ts,
        "action_type": action_type,
        "tool_name": tool_name,
        "description": description,
        "preceding_user_text": preceding_user_text[:500],
        "tool_args_summary": json.dumps(args)[:300],
    }


# ─────────────────────────────────────────────────────────────
# Outcome determination
# ─────────────────────────────────────────────────────────────

def detect_text_signal(text: str, phrases: List[str]) -> bool:
    low = text.lower()
    return any(p in low for p in phrases)


def determine_outcome(
    situation_ts: str,
    subsequent_events: List[Dict[str, Any]],
) -> Tuple[float, str]:
    """
    Determine outcome label from events following the action.

    Rules (in priority order):
      1. Explicit correction within 24h  → -1.0  (programmatic)
      2. File restoration within 24h     → -1.0  (programmatic)
      3. Explicit positive feedback       → +1.0  (programmatic)
      4. No complaint / correction 72h   → +0.5  (heuristic)
      5. Default                         → 0.0   (unknown)

    Returns (label, source).
    """
    try:
        base_ts = datetime.fromisoformat(situation_ts.replace("Z", "+00:00"))
    except Exception:
        return 0.0, "unknown"

    window_24h = base_ts + timedelta(hours=24)
    window_72h = base_ts + timedelta(hours=72)

    latest_event_ts: Optional[datetime] = None
    found_correction = False
    found_positive = False
    found_restore = False

    for ev in subsequent_events:
        ev_ts_str = ev.get("timestamp", "")
        try:
            ev_ts = datetime.fromisoformat(ev_ts_str.replace("Z", "+00:00"))
        except Exception:
            continue

        if latest_event_ts is None or ev_ts > latest_event_ts:
            latest_event_ts = ev_ts

        msg = ev.get("message", {})
        role = msg.get("role", "")
        if role != "user":
            continue

        content = msg.get("content") or []
        text = " ".join(
            c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"
        )

        if ev_ts <= window_24h:
            if detect_text_signal(text, CORRECTION_PHRASES):
                found_correction = True
            # Heuristic: user mentions "restore" or "git restore" as a direct follow-up
            if "restore" in text.lower() or "revert" in text.lower():
                found_restore = True

        if detect_text_signal(text, POSITIVE_PHRASES):
            found_positive = True

    # Priority ordering
    if found_correction or found_restore:
        return -1.0, "programmatic"
    if found_positive:
        return 1.0, "programmatic"
    # If we have events up to 72h after and no complaint
    if latest_event_ts and latest_event_ts >= window_72h:
        return 0.5, "heuristic"

    return 0.0, "unknown"


# ─────────────────────────────────────────────────────────────
# Embedding (optional — requires sentence-transformers or onnxruntime)
# ─────────────────────────────────────────────────────────────

_encoder = None


def _load_encoder():
    global _encoder
    if _encoder is not None:
        return _encoder

    # Try sentence-transformers first
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
        model = SentenceTransformer("all-MiniLM-L6-v2")
        _encoder = ("st", model)
        log.info("Encoder: sentence-transformers all-MiniLM-L6-v2")
        return _encoder
    except ImportError:
        pass

    # Try ONNX Runtime with pre-exported encoder
    onnx_path = Path.home() / "src" / "tinkerclaw" / "models" / "amygdala" / "encoder.onnx"
    if onnx_path.exists():
        try:
            import onnxruntime as ort  # type: ignore
            import numpy as np  # type: ignore
            sess = ort.InferenceSession(str(onnx_path))
            _encoder = ("onnx", sess)
            log.info("Encoder: ONNX %s", onnx_path)
            return _encoder
        except ImportError:
            pass

    log.warning("No encoder available — embeddings will be zero vectors")
    _encoder = ("none", None)
    return _encoder


def embed_situation(situation: Dict[str, Any]) -> bytes:
    """Embed situation template into a 512-dim float32 vector, returned as raw bytes."""
    text = f"{situation.get('description', '')} {situation.get('preceding_user_text', '')}".strip()

    kind, model = _load_encoder()

    if kind == "st":
        import numpy as np  # type: ignore
        vec = model.encode([text], normalize_embeddings=True)[0]
        # Pad/truncate to 512
        if len(vec) < 512:
            vec = np.pad(vec, (0, 512 - len(vec)))
        else:
            vec = vec[:512]
        return vec.astype("float32").tobytes()

    if kind == "onnx":
        # Minimal tokenization fallback (bag-of-words mean hash)
        pass  # fall through to zero

    # Zero vector fallback
    import struct
    return struct.pack("512f", *([0.0] * 512))


# ─────────────────────────────────────────────────────────────
# SQLite output
# ─────────────────────────────────────────────────────────────

def init_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS mined_examples (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT NOT NULL,
            action_id       TEXT,
            timestamp       TEXT,
            action_type     TEXT,
            tool_name       TEXT,
            situation_json  TEXT,
            embedding       BLOB,
            outcome_label   REAL,
            label_source    TEXT,
            notes           TEXT,
            created_at      TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_session ON mined_examples(session_id)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_outcome ON mined_examples(outcome_label)
    """)
    conn.commit()
    return conn


def insert_example(
    conn: sqlite3.Connection,
    situation: Dict[str, Any],
    embedding: bytes,
    outcome_label: float,
    label_source: str,
    notes: str = "",
) -> None:
    conn.execute("""
        INSERT INTO mined_examples
            (session_id, action_id, timestamp, action_type, tool_name,
             situation_json, embedding, outcome_label, label_source, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        situation["session_id"],
        situation.get("action_id", ""),
        situation.get("timestamp", ""),
        situation.get("action_type", "other"),
        situation.get("tool_name", ""),
        json.dumps(situation),
        embedding,
        outcome_label,
        label_source,
        notes,
    ))


# ─────────────────────────────────────────────────────────────
# Main mining loop
# ─────────────────────────────────────────────────────────────

def mine_session(
    session_path: Path,
    conn: sqlite3.Connection,
    dry_run: bool = False,
) -> int:
    """Mine a single session JSONL for action events. Returns count of inserted examples."""
    events: List[Dict[str, Any]] = []
    try:
        events = list(iter_session_events(session_path))
    except OSError as exc:
        log.warning("Cannot read %s: %s", session_path, exc)
        return 0

    if not events:
        return 0

    # Get session ID from first event
    session_id = events[0].get("id", session_path.stem) if events else session_path.stem

    # Build a flat timeline of (index, event) for look-ahead
    inserted = 0
    last_user_text = ""

    for i, event in enumerate(events):
        # Track last user message text for context
        msg = event.get("message", {})
        if msg.get("role") == "user":
            content = msg.get("content") or []
            texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            last_user_text = " ".join(texts)[:500]

        # Only look at assistant messages with tool calls
        if event.get("type") != "message":
            continue
        if msg.get("role") != "assistant":
            continue

        tool_calls = extract_tool_calls(event)
        for tool_call in tool_calls:
            tool_name = tool_call.get("name", "")
            args = tool_call.get("arguments", {}) or {}
            action_type = classify_action(tool_name, args)

            # Only process action-taking events
            if action_type not in ACTION_TYPES:
                continue

            situation = reconstruct_situation(
                session_id=session_id,
                event=event,
                tool_call=tool_call,
                preceding_user_text=last_user_text,
            )

            # Subsequent events for outcome determination
            subsequent = events[i + 1:]
            outcome_label, label_source = determine_outcome(
                situation_ts=situation["timestamp"],
                subsequent_events=subsequent,
            )

            embedding = embed_situation(situation)

            if not dry_run:
                insert_example(conn, situation, embedding, outcome_label, label_source)

            inserted += 1

    if not dry_run:
        conn.commit()

    return inserted


def mine_all(
    sessions_dir: Path,
    db_path: Path,
    dry_run: bool = False,
) -> Dict[str, int]:
    session_files = sorted(sessions_dir.glob("*.jsonl"))
    log.info("Found %d session files in %s", len(session_files), sessions_dir)

    if not session_files:
        log.warning("No JSONL files found. Check path: %s", sessions_dir)
        return {"sessions": 0, "examples": 0}

    conn = init_db(db_path) if not dry_run else None  # type: ignore

    total = 0
    for idx, path in enumerate(session_files):
        count = mine_session(path, conn, dry_run=dry_run)  # type: ignore
        total += count
        if (idx + 1) % 10 == 0:
            log.info("Progress: %d/%d sessions, %d examples so far", idx + 1, len(session_files), total)

    if not dry_run and conn:
        conn.close()

    log.info("Mining complete: %d sessions → %d action examples", len(session_files), total)
    return {"sessions": len(session_files), "examples": total}


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="AMYGDALA Historical Data Miner (P0.5.3)")
    parser.add_argument("--sessions", type=Path, default=SESSIONS_DIR,
                        help="Directory containing *.jsonl session transcripts")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB,
                        help="Output SQLite database path")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse and count without writing to DB")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    stats = mine_all(args.sessions, args.db, dry_run=args.dry_run)
    print(json.dumps(stats, indent=2))

    if stats["examples"] < 100:
        log.warning("Only %d examples found — check session path and JSONL format", stats["examples"])
    elif stats["examples"] >= 2000:
        log.info("✓ Target met: %d examples (goal: 2,000–5,000)", stats["examples"])
    else:
        log.info("Partial: %d examples (goal: 2,000–5,000)", stats["examples"])


if __name__ == "__main__":
    main()
