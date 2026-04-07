"""
Tests for training.amygdala.reflect_and_curate
"""

import json
import sqlite3
import struct
import tempfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

EMBEDDING_DIM = 512
PERSONALITY_DIM = 96


def _make_embedding(seed: int = 0, dim: int = EMBEDDING_DIM) -> bytes:
    """Create a deterministic normalized embedding vector as raw bytes."""
    rng = np.random.RandomState(seed)
    vec = rng.randn(dim).astype(np.float32)
    vec /= np.linalg.norm(vec)
    return vec.tobytes()


def _make_similar_embedding(base_seed: int = 0, noise: float = 0.01) -> bytes:
    """Create an embedding very similar to the base (cosine > 0.95)."""
    rng_base = np.random.RandomState(base_seed)
    base = rng_base.randn(EMBEDDING_DIM).astype(np.float32)
    base /= np.linalg.norm(base)
    rng_noise = np.random.RandomState(base_seed + 1000)
    perturbation = rng_noise.randn(EMBEDDING_DIM).astype(np.float32) * noise
    similar = base + perturbation
    similar /= np.linalg.norm(similar)
    return similar.astype(np.float32).tobytes()


def _make_personality() -> bytes:
    return struct.pack(f"{PERSONALITY_DIM}f", *([0.0] * PERSONALITY_DIM))


def _init_test_db(path: str) -> sqlite3.Connection:
    """Create both mined_examples and amygdala_evaluations tables."""
    conn = sqlite3.connect(path)
    conn.executescript("""
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
        );

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
        );
    """)
    conn.commit()
    return conn


# ─────────────────────────────────────────────────────────────
# Test: mining converts mined_examples → amygdala_evaluations
# ─────────────────────────────────────────────────────────────

class TestMineConversion:
    def test_mined_examples_convert_to_evaluations(self, tmp_path: Path):
        """Mined examples should be converted to amygdala_evaluations rows."""
        db_path = str(tmp_path / "test.sqlite")
        conn = _init_test_db(db_path)

        # Insert some mined_examples
        emb = _make_embedding(seed=1)
        sit = json.dumps({"action_type": "write", "action_id": "act_001"})
        conn.execute("""
            INSERT INTO mined_examples
                (session_id, action_id, timestamp, action_type, tool_name,
                 situation_json, embedding, outcome_label, label_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("sess_1", "act_001", "2025-01-15T10:00:00", "write", "edit",
              sit, emb, 1.0, "programmatic"))

        sit2 = json.dumps({"action_type": "exec", "action_id": "act_002"})
        emb2 = _make_embedding(seed=2)
        conn.execute("""
            INSERT INTO mined_examples
                (session_id, action_id, timestamp, action_type, tool_name,
                 situation_json, embedding, outcome_label, label_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("sess_1", "act_002", "2025-01-15T10:05:00", "exec", "exec",
              sit2, emb2, -1.0, "programmatic"))
        conn.commit()
        conn.close()

        # Mock mine_all so it doesn't try to read real session files
        with patch("training.amygdala.reflect_and_curate.mine_all", return_value={"sessions": 0, "examples": 0}):
            from training.amygdala.reflect_and_curate import _mine_new_examples
            inserted = _mine_new_examples(db_path)

        # Verify amygdala_evaluations were created
        conn = sqlite3.connect(db_path)
        rows = conn.execute("SELECT * FROM amygdala_evaluations").fetchall()
        conn.close()

        assert len(rows) == 2

        # Check first row
        conn = sqlite3.connect(db_path)
        row = conn.execute(
            "SELECT outcome, outcome_source, outcome_weight FROM amygdala_evaluations WHERE id = 1"
        ).fetchone()
        conn.close()
        assert row[0] == "positive"   # 1.0 → positive
        assert row[1] == "mined"
        assert row[2] == 1.0

    def test_negative_outcome_maps_correctly(self, tmp_path: Path):
        """outcome_label -1.0 should map to 'negative'."""
        db_path = str(tmp_path / "test.sqlite")
        conn = _init_test_db(db_path)

        sit = json.dumps({"action_type": "exec", "action_id": "act_neg"})
        conn.execute("""
            INSERT INTO mined_examples
                (session_id, action_id, timestamp, action_type, tool_name,
                 situation_json, embedding, outcome_label, label_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("sess_1", "act_neg", "2025-01-15T10:00:00", "exec", "exec",
              sit, _make_embedding(seed=5), -1.0, "programmatic"))
        conn.commit()
        conn.close()

        with patch("training.amygdala.reflect_and_curate.mine_all", return_value={"sessions": 0, "examples": 0}):
            from training.amygdala.reflect_and_curate import _mine_new_examples
            _mine_new_examples(db_path)

        conn = sqlite3.connect(db_path)
        outcome = conn.execute(
            "SELECT outcome FROM amygdala_evaluations LIMIT 1"
        ).fetchone()[0]
        conn.close()
        assert outcome == "negative"


# ─────────────────────────────────────────────────────────────
# Test: contradiction detection
# ─────────────────────────────────────────────────────────────

class TestContradictionDetection:
    def test_detects_contradiction_similar_embedding_different_outcome(self, tmp_path: Path):
        """Two examples with similar embeddings but different outcomes = contradiction."""
        db_path = str(tmp_path / "test.sqlite")
        conn = _init_test_db(db_path)

        emb_old = _make_embedding(seed=42)
        emb_new = _make_similar_embedding(base_seed=42)

        # Old example: positive
        conn.execute("""
            INSERT INTO amygdala_evaluations
                (timestamp, embedding, situation_json, outcome, outcome_source,
                 outcome_weight, personality_combined, gate_decision, serialized)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("2025-01-10T10:00:00", emb_old,
              json.dumps({"action_type": "write"}), "positive", "mined",
              1.0, _make_personality(), "allow", ""))

        # New example: negative (evolved preference)
        conn.execute("""
            INSERT INTO amygdala_evaluations
                (timestamp, embedding, situation_json, outcome, outcome_source,
                 outcome_weight, personality_combined, gate_decision, serialized)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("2025-03-15T10:00:00", emb_new,
              json.dumps({"action_type": "write"}), "negative", "mined",
              1.0, _make_personality(), "allow", ""))
        conn.commit()
        conn.close()

        from training.amygdala.reflect_and_curate import _detect_contradictions
        contradictions = _detect_contradictions(db_path)

        assert len(contradictions) == 1
        c = contradictions[0]
        assert c["old_id"] == 1
        assert c["new_id"] == 2
        assert c["old_outcome"] == "positive"
        assert c["new_outcome"] == "negative"
        assert c["similarity"] > 0.85

    def test_no_false_positive_same_outcome(self, tmp_path: Path):
        """Two similar examples with the SAME outcome should NOT be flagged."""
        db_path = str(tmp_path / "test.sqlite")
        conn = _init_test_db(db_path)

        emb_old = _make_embedding(seed=42)
        emb_new = _make_similar_embedding(base_seed=42)

        # Both positive — no contradiction
        for i, (ts, emb) in enumerate([
            ("2025-01-10T10:00:00", emb_old),
            ("2025-03-15T10:00:00", emb_new),
        ]):
            conn.execute("""
                INSERT INTO amygdala_evaluations
                    (timestamp, embedding, situation_json, outcome, outcome_source,
                     outcome_weight, personality_combined, gate_decision, serialized)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (ts, emb, json.dumps({"action_type": "write"}),
                  "positive", "mined", 1.0, _make_personality(), "allow", ""))
        conn.commit()
        conn.close()

        from training.amygdala.reflect_and_curate import _detect_contradictions
        contradictions = _detect_contradictions(db_path)

        assert len(contradictions) == 0

    def test_no_contradiction_dissimilar_embeddings(self, tmp_path: Path):
        """Two examples with very different embeddings should NOT be flagged even with different outcomes."""
        db_path = str(tmp_path / "test.sqlite")
        conn = _init_test_db(db_path)

        emb1 = _make_embedding(seed=1)    # completely different
        emb2 = _make_embedding(seed=999)  # from each other

        conn.execute("""
            INSERT INTO amygdala_evaluations
                (timestamp, embedding, situation_json, outcome, outcome_source,
                 outcome_weight, personality_combined, gate_decision, serialized)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("2025-01-10T10:00:00", emb1,
              json.dumps({"action_type": "write"}), "positive", "mined",
              1.0, _make_personality(), "allow", ""))

        conn.execute("""
            INSERT INTO amygdala_evaluations
                (timestamp, embedding, situation_json, outcome, outcome_source,
                 outcome_weight, personality_combined, gate_decision, serialized)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("2025-03-15T10:00:00", emb2,
              json.dumps({"action_type": "exec"}), "negative", "mined",
              1.0, _make_personality(), "allow", ""))
        conn.commit()
        conn.close()

        from training.amygdala.reflect_and_curate import _detect_contradictions
        contradictions = _detect_contradictions(db_path)

        assert len(contradictions) == 0


# ─────────────────────────────────────────────────────────────
# Test: contradiction resolution
# ─────────────────────────────────────────────────────────────

class TestContradictionResolution:
    def test_resolve_demotes_older_example(self, tmp_path: Path):
        """Resolution should set outcome_weight = 0.1 on the older (stale) example."""
        db_path = str(tmp_path / "test.sqlite")
        conn = _init_test_db(db_path)

        emb_old = _make_embedding(seed=42)
        emb_new = _make_similar_embedding(base_seed=42)

        conn.execute("""
            INSERT INTO amygdala_evaluations
                (timestamp, embedding, situation_json, outcome, outcome_source,
                 outcome_weight, personality_combined, gate_decision, serialized)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("2025-01-10T10:00:00", emb_old,
              json.dumps({"action_type": "write"}), "positive", "mined",
              1.0, _make_personality(), "allow", ""))

        conn.execute("""
            INSERT INTO amygdala_evaluations
                (timestamp, embedding, situation_json, outcome, outcome_source,
                 outcome_weight, personality_combined, gate_decision, serialized)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, ("2025-03-15T10:00:00", emb_new,
              json.dumps({"action_type": "write"}), "negative", "mined",
              1.0, _make_personality(), "allow", ""))
        conn.commit()
        conn.close()

        from training.amygdala.reflect_and_curate import _detect_contradictions, _resolve_contradictions

        contradictions = _detect_contradictions(db_path)
        assert len(contradictions) == 1

        demoted = _resolve_contradictions(db_path, contradictions)
        assert demoted >= 1

        # Verify the old example was demoted
        conn = sqlite3.connect(db_path)
        old_weight = conn.execute(
            "SELECT outcome_weight FROM amygdala_evaluations WHERE id = 1"
        ).fetchone()[0]
        new_weight = conn.execute(
            "SELECT outcome_weight FROM amygdala_evaluations WHERE id = 2"
        ).fetchone()[0]
        conn.close()

        assert old_weight == pytest.approx(0.1)
        assert new_weight == pytest.approx(1.0)  # new one untouched

    def test_resolve_no_contradictions_is_noop(self, tmp_path: Path):
        """Passing empty contradictions list should do nothing."""
        db_path = str(tmp_path / "test.sqlite")
        _init_test_db(db_path)

        from training.amygdala.reflect_and_curate import _resolve_contradictions
        demoted = _resolve_contradictions(db_path, [])
        assert demoted == 0
