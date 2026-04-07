"""
reflect_and_curate.py — AMYGDALA Reflection & Curation (P0.5.4)
================================================================
Bridges mine_history.py → amygdala_evaluations, then detects and resolves
contradictions where the user's evolved preferences conflict with older data.

Pipeline phases:
  Phase 0 (MINE):    Extract new examples from session transcripts, convert
                     mined_examples rows into amygdala_evaluations schema.
  Phase 1 (REFLECT): Cosine-similarity scan for contradicting examples;
                     demote stale ones (outcome_weight → 0.1).

Entry point: reflect_and_curate(db_path, sessions_dir)
"""

from __future__ import annotations

import json
import logging
import sqlite3
import struct
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .mine_history import SESSIONS_DIR as DEFAULT_SESSIONS_DIR
from .mine_history import mine_all

log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────

DEFAULT_DB = Path.home() / "src" / "tinkerclaw" / "data" / "amygdala" / "training.sqlite"
EMBEDDING_DIM = 512
PERSONALITY_DIM = 96
CONTRADICTION_THRESHOLD = 0.85

# Map mine_history outcome_label (float) → amygdala_evaluations outcome (text)
OUTCOME_LABEL_MAP: Dict[float, str] = {
    -1.0: "negative",
    0.0:  "neutral",
    0.5:  "positive",
    0.8:  "positive",
    1.0:  "positive",
}


# ─────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────

def _ensure_tracking_table(conn: sqlite3.Connection) -> None:
    """Create a table to track when reflect_and_curate last ran."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS reflect_curate_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at TEXT NOT NULL,
            examples_mined INTEGER DEFAULT 0,
            contradictions_found INTEGER DEFAULT 0,
            examples_demoted INTEGER DEFAULT 0,
            examples_added INTEGER DEFAULT 0
        )
    """)
    conn.commit()


def _get_last_run(conn: sqlite3.Connection) -> Optional[str]:
    """Return ISO timestamp of last successful run, or None."""
    try:
        row = conn.execute(
            "SELECT run_at FROM reflect_curate_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return row[0] if row else None
    except sqlite3.OperationalError:
        return None


def _ensure_amygdala_evaluations(conn: sqlite3.Connection) -> None:
    """Create amygdala_evaluations if it doesn't exist yet."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS amygdala_evaluations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            embedding BLOB NOT NULL,
            situation_json TEXT NOT NULL,
            outcome TEXT,
            outcome_weight REAL DEFAULT 1.0,
            outcome_source TEXT,
            personality_combined BLOB,
            user_override BOOLEAN DEFAULT FALSE,
            gate_decision TEXT DEFAULT 'allow',
            prudence_combined TEXT DEFAULT '{}',
            prudence_per_arch TEXT DEFAULT '{}',
            prediction_set TEXT DEFAULT '[]',
            ensemble_disagreement REAL DEFAULT 0.0,
            latency_ms REAL DEFAULT 0.0,
            alpha_prudence REAL DEFAULT 0.0,
            alpha_personality REAL DEFAULT 0.0,
            phase INTEGER DEFAULT 1,
            serialized TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()


def _zero_personality() -> bytes:
    """Return a zeroed 96-dim float32 blob."""
    return struct.pack(f"{PERSONALITY_DIM}f", *([0.0] * PERSONALITY_DIM))


# ─────────────────────────────────────────────────────────────
# Phase 0: MINE — extract and convert
# ─────────────────────────────────────────────────────────────

def _mine_new_examples(db_path: str, sessions_dir: Optional[str] = None) -> int:
    """
    Run mine_history to extract new examples, then convert unprocessed
    mined_examples rows into amygdala_evaluations.

    Returns the number of new amygdala_evaluations rows inserted.
    """
    db = Path(db_path)
    sess = Path(sessions_dir) if sessions_dir else DEFAULT_SESSIONS_DIR

    # Run the miner
    log.info("Mining session transcripts from %s", sess)
    mine_stats = mine_all(sessions_dir=sess, db_path=db, dry_run=False)
    log.info("Mining result: %s", mine_stats)

    # Now convert mined_examples → amygdala_evaluations
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")

    _ensure_amygdala_evaluations(conn)
    _ensure_tracking_table(conn)

    # Find mined_examples not yet converted (by checking action_id not already present)
    # Use a left join to avoid duplicates
    unconverted = conn.execute("""
        SELECT m.id, m.session_id, m.action_id, m.timestamp, m.action_type,
               m.tool_name, m.situation_json, m.embedding, m.outcome_label,
               m.label_source
        FROM mined_examples m
        LEFT JOIN amygdala_evaluations ae
            ON ae.situation_json LIKE '%' || m.action_id || '%'
            AND ae.outcome_source = 'mined'
        WHERE ae.id IS NULL
    """).fetchall()

    inserted = 0
    zero_pers = _zero_personality()

    for row in unconverted:
        (mid, session_id, action_id, ts, action_type, tool_name,
         sit_json, embedding, outcome_label, label_source) = row

        outcome_text = OUTCOME_LABEL_MAP.get(outcome_label, "neutral")

        # Ensure embedding is the right size (512 floats = 2048 bytes)
        if embedding is None or len(embedding) != EMBEDDING_DIM * 4:
            embedding = struct.pack(f"{EMBEDDING_DIM}f", *([0.0] * EMBEDDING_DIM))

        conn.execute("""
            INSERT INTO amygdala_evaluations
                (timestamp, embedding, situation_json, outcome, outcome_source,
                 outcome_weight, personality_combined, gate_decision, serialized)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            ts or datetime.now().isoformat(),
            embedding,
            sit_json or "{}",
            outcome_text,
            "mined",
            1.0,
            zero_pers,
            "allow",
            "",
        ))
        inserted += 1

    conn.commit()
    conn.close()
    log.info("Converted %d mined examples → amygdala_evaluations", inserted)
    return inserted


# ─────────────────────────────────────────────────────────────
# Phase 1: REFLECT — detect contradictions
# ─────────────────────────────────────────────────────────────

def _load_embeddings(conn: sqlite3.Connection) -> List[Tuple[int, str, str, np.ndarray]]:
    """Load all (id, timestamp, outcome, embedding_vector) from amygdala_evaluations."""
    rows = conn.execute("""
        SELECT id, timestamp, outcome, embedding
        FROM amygdala_evaluations
        WHERE embedding IS NOT NULL AND outcome IS NOT NULL
        ORDER BY timestamp ASC
    """).fetchall()

    results = []
    for eval_id, ts, outcome, emb_blob in rows:
        if emb_blob is None or len(emb_blob) != EMBEDDING_DIM * 4:
            continue
        vec = np.frombuffer(emb_blob, dtype=np.float32).copy()
        results.append((eval_id, ts, outcome, vec))
    return results


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def _detect_contradictions(db_path: str) -> List[Dict[str, Any]]:
    """
    Find pairs of examples with high embedding similarity but different outcomes.

    A contradiction is: cosine_similarity > 0.85 AND outcomes differ.
    Only the newer example is considered "correct" (evolved preferences).

    Returns list of dicts: {old_id, new_id, similarity, old_outcome, new_outcome}
    """
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 5000")

    entries = _load_embeddings(conn)
    conn.close()

    if len(entries) < 2:
        return []

    contradictions = []
    # Compare each pair; newer entries are later in the list (sorted by timestamp ASC)
    for i in range(len(entries)):
        id_i, ts_i, outcome_i, vec_i = entries[i]
        for j in range(i + 1, len(entries)):
            id_j, ts_j, outcome_j, vec_j = entries[j]

            if outcome_i == outcome_j:
                continue

            sim = _cosine_similarity(vec_i, vec_j)
            if sim > CONTRADICTION_THRESHOLD:
                # j is newer (later timestamp), so j wins
                contradictions.append({
                    "old_id": id_i,
                    "new_id": id_j,
                    "similarity": round(sim, 4),
                    "old_outcome": outcome_i,
                    "new_outcome": outcome_j,
                })

    log.info("Detected %d contradictions", len(contradictions))
    return contradictions


def _resolve_contradictions(db_path: str, contradictions: List[Dict[str, Any]]) -> int:
    """
    Resolve contradictions by demoting the older example (outcome_weight → 0.1).
    Returns number of examples demoted.
    """
    if not contradictions:
        return 0

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")

    demoted = 0
    for c in contradictions:
        old_id = c["old_id"]
        conn.execute("""
            UPDATE amygdala_evaluations
            SET outcome_weight = 0.1
            WHERE id = ? AND outcome_weight > 0.1
        """, (old_id,))
        if conn.total_changes > 0:
            demoted += 1
        log.info(
            "Contradiction: old_id=%d new_id=%d sim=%.4f old=%s new=%s → demoted old",
            c["old_id"], c["new_id"], c["similarity"],
            c["old_outcome"], c["new_outcome"],
        )

    conn.commit()
    conn.close()
    log.info("Demoted %d stale examples", demoted)
    return demoted


# ─────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────

def reflect_and_curate(
    db_path: str,
    sessions_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Full reflect-and-curate cycle:
      Phase 0: Mine new examples from session transcripts
      Phase 1: Detect and resolve contradictions

    Returns summary dict with metrics.
    """
    log.info("reflect_and_curate starting (db=%s)", db_path)

    # Phase 0: Mine
    examples_mined = _mine_new_examples(db_path, sessions_dir)

    # Phase 1: Reflect
    contradictions = _detect_contradictions(db_path)
    examples_demoted = _resolve_contradictions(db_path, contradictions)

    summary = {
        "examples_mined": examples_mined,
        "contradictions_found": len(contradictions),
        "examples_demoted": examples_demoted,
        "examples_added": examples_mined,
    }

    # Record the run
    conn = sqlite3.connect(db_path)
    _ensure_tracking_table(conn)
    conn.execute("""
        INSERT INTO reflect_curate_runs (run_at, examples_mined, contradictions_found,
                                         examples_demoted, examples_added)
        VALUES (datetime('now'), ?, ?, ?, ?)
    """, (examples_mined, len(contradictions), examples_demoted, examples_mined))
    conn.commit()
    conn.close()

    log.info("reflect_and_curate complete: %s", summary)
    return summary
