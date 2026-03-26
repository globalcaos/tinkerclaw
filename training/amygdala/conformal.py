"""
AMYGDALA Conformal Prediction Calibration (P0.5.2)
====================================================
Implements conformal prediction for all 5 Prudence networks.

Algorithm (inductive conformal prediction, §4.9):
  1. Collect calibration set: (predicted_probs, actual_outcome) pairs
     from a rolling 30-day window stored in conformal_calibration table.
  2. Per network, per outcome class j, compute nonconformity scores:
       α_{i,j} = 1 - p̂(y=j | s_i)
  3. Compute the (1-ε) quantile of calibration nonconformity scores.
  4. At inference: include class j in prediction set if α_{new,j} ≤ q_{1-ε}

Coverage guarantee: P(y ∈ C(x)) ≥ 1-ε under exchangeability.

Calibration quality:
  Networks with avg_prediction_set_size > 2.0 are flagged as miscalibrated.
  They are excluded from the conformal union during inference.
  Their meta-learner weights are reduced proportionally.
"""

import json
import sqlite3
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import numpy as np

# ─────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────

OUTCOMES = ["safe", "needs-review", "dangerous"]       # conformal prediction classes
OUTCOME_IDX = {o: i for i, o in enumerate(OUTCOMES)}

# Prudence gate_decision → conformal class mapping
GATE_TO_CONFORMAL = {
    "allow":      "safe",
    "soft_block": "needs-review",
    "hard_block": "dangerous",
}


class ConformalCalibrator:
    """
    Per-network conformal prediction calibration.

    Usage:
        cal = ConformalCalibrator(epsilon=0.05, window_days=30)
        results = cal.calibrate_all(db_path)
        pred_set = cal.predict("a", probs=[0.7, 0.2, 0.1])
    """

    def __init__(self, epsilon: float = 0.05, window_days: int = 30):
        """
        Args:
            epsilon:     Significance level (0.05 → 95% coverage target)
            window_days: Rolling calibration window
        """
        self.epsilon     = epsilon
        self.window_days = window_days

        # Per-network calibration data (set by calibrate_*)
        # quantiles[key][j] = (1-ε) quantile of nonconformity scores for class j
        self.quantiles: Dict[str, List[float]] = {}

        # Calibration quality score per network ∈ [0, 1]
        # 1.0 = perfect (avg set size ≈ 1)
        # 0.0 = miscalibrated (avg set size ≈ 3)
        self.quality: Dict[str, float] = {}

    # ─────────────────────────────────────────────────────────
    # Calibration from database
    # ─────────────────────────────────────────────────────────

    def calibrate_from_db(self, db_path: str, network_key: str) -> Dict:
        """
        Calibrate a single network from conformal_calibration table.

        The table stores per-evaluation predicted probabilities and the
        actual observed outcome. This function computes the per-class
        nonconformity quantiles.

        Returns:
            dict with quantiles, empirical coverage, quality score, n_samples
        """
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")

        cutoff = (datetime.now() - timedelta(days=self.window_days)).isoformat()

        try:
            rows = conn.execute("""
                SELECT
                    prob_safe,
                    prob_needs_review,
                    prob_dangerous,
                    actual_outcome,
                    nonconformity_safe,
                    nonconformity_needs_review,
                    nonconformity_dangerous
                FROM conformal_calibration
                WHERE network_key = ?
                  AND datetime(timestamp) >= datetime(?)
                ORDER BY timestamp ASC
            """, (network_key, cutoff)).fetchall()
        except sqlite3.OperationalError:
            rows = []
        conn.close()

        if len(rows) < 10:
            # Insufficient calibration data — use conservative defaults
            # (include all classes = prediction set of size 3)
            self.quantiles[network_key] = [0.95, 0.95, 0.95]
            self.quality[network_key]   = 0.5    # uncertain
            return {
                "network_key": network_key,
                "warning":     "insufficient_data",
                "n_samples":   len(rows),
                "quantiles":   self.quantiles[network_key],
                "quality":     0.5,
            }

        # ── Per-class nonconformity scores ──
        # For calibration, we collect α_{i,j} = 1 - p̂(y=j | s_i)
        # where y_i is the ACTUAL class.
        scores_by_class: List[List[float]] = [[], [], []]

        for row in rows:
            prob_safe, prob_nr, prob_dan, actual_outcome, nc_safe, nc_nr, nc_dan = row
            actual_idx = OUTCOME_IDX.get(actual_outcome, 1)
            nc_scores  = [nc_safe, nc_nr, nc_dan]
            scores_by_class[actual_idx].append(nc_scores[actual_idx])

        # ── Quantile computation ──
        quantiles: List[float] = []
        for j in range(3):
            if len(scores_by_class[j]) >= 5:
                q = float(np.quantile(scores_by_class[j], 1 - self.epsilon))
                quantiles.append(min(q, 1.0))    # clamp to [0,1]
            else:
                quantiles.append(0.95)           # conservative default

        self.quantiles[network_key] = quantiles

        # ── Empirical coverage ──
        correct = 0
        for row in rows:
            _, _, _, actual_outcome, nc_safe, nc_nr, nc_dan = row
            actual_idx = OUTCOME_IDX.get(actual_outcome, 1)
            nc         = [nc_safe, nc_nr, nc_dan][actual_idx]
            if nc <= quantiles[actual_idx]:
                correct += 1
        coverage = correct / len(rows)

        # ── Calibration quality score ──
        # Compute avg prediction set size on calibration data
        set_sizes = []
        for row in rows:
            prob_safe, prob_nr, prob_dan, _, nc_safe, nc_nr, nc_dan = row
            ps = sum(
                1 for j, nc in enumerate([nc_safe, nc_nr, nc_dan])
                if nc <= quantiles[j]
            )
            set_sizes.append(max(ps, 1))  # at least 1 (always include something)
        avg_size = float(np.mean(set_sizes))

        # quality ∈ [0, 1]: 1.0 when avg_size=1.0, 0.0 when avg_size=3.0
        quality = max(0.0, 1.0 - (avg_size - 1.0) / 2.0)
        self.quality[network_key] = quality

        return {
            "network_key":   network_key,
            "quantiles":     quantiles,
            "coverage":      coverage,
            "target":        1.0 - self.epsilon,
            "coverage_ok":   abs(coverage - (1.0 - self.epsilon)) < 0.03,
            "avg_set_size":  avg_size,
            "quality":       quality,
            "miscalibrated": quality < 0.5,
            "n_samples":     len(rows),
        }

    def calibrate_all(self, db_path: str) -> Dict[str, Dict]:
        """Calibrate all 5 Prudence networks and return per-network results."""
        results = {}
        for key in "abcde":
            results[key] = self.calibrate_from_db(db_path, key)
            q    = results[key]
            flag = " [MISCALIBRATED]" if results[key].get("miscalibrated") else ""
            cov = results[key].get('coverage')
            asz = results[key].get('avg_set_size')
            qual = results[key].get('quality')
            cov_s = f"{cov:.3f}" if isinstance(cov, (int, float)) else "N/A"
            asz_s = f"{asz:.2f}" if isinstance(asz, (int, float)) else "N/A"
            qual_s = f"{qual:.2f}" if isinstance(qual, (int, float)) else "N/A"
            print(
                f"[conformal] {key.upper()}: "
                f"coverage={cov_s} "
                f"avg_set_size={asz_s} "
                f"quality={qual_s}{flag}"
            )
        return results

    # ─────────────────────────────────────────────────────────
    # Inference
    # ─────────────────────────────────────────────────────────

    def predict(
        self,
        network_key: str,
        probs: List[float],
    ) -> List[str]:
        """
        Produce conformal prediction set for a single network.

        Args:
            network_key: "a" | "b" | "c" | "d" | "e"
            probs:       [p_safe, p_needs_review, p_dangerous]
                         (aligned with OUTCOMES order)

        Returns:
            Prediction set, e.g. ["safe"] or ["safe", "needs-review"]
        """
        quantiles = self.quantiles.get(network_key, [0.95, 0.95, 0.95])
        prediction_set: List[str] = []

        for j, outcome in enumerate(OUTCOMES):
            nonconformity = 1.0 - probs[j]
            if nonconformity <= quantiles[j]:
                prediction_set.append(outcome)

        # Ensure at least one outcome is always included
        return prediction_set if prediction_set else ["needs-review"]

    def predict_ensemble(
        self,
        probs_by_arch: Dict[str, List[float]],
        min_quality: float = 0.5,
    ) -> List[str]:
        """
        Produce a combined conformal prediction set across all networks.

        Uses the UNION of per-network prediction sets (conservative).
        Networks with quality < min_quality are excluded (miscalibrated).

        Args:
            probs_by_arch: {"a": [p_safe, p_nr, p_dan], "b": ..., ...}
            min_quality:   Quality threshold for including a network

        Returns:
            Combined prediction set (union, deduplicated, ordered)
        """
        combined: set = set()
        n_included = 0

        for key, probs in probs_by_arch.items():
            q = self.quality.get(key, 1.0)
            if q < min_quality:
                print(f"[conformal] Excluding network {key.upper()} (quality={q:.2f} < {min_quality})")
                continue
            ps = self.predict(key, probs)
            combined.update(ps)
            n_included += 1

        if n_included == 0:
            # All networks miscalibrated — conservative fallback
            return list(OUTCOMES)

        # Return in canonical order
        return [o for o in OUTCOMES if o in combined]

    # ─────────────────────────────────────────────────────────
    # Quality scoring for meta-learner
    # ─────────────────────────────────────────────────────────

    def get_quality_scores(self) -> Dict[str, float]:
        """Return calibration quality scores for all calibrated networks."""
        return dict(self.quality)

    def get_meta_learner_weight_adjustments(
        self,
        base_weights: List[float],
    ) -> List[float]:
        """
        Adjust meta-learner weights proportionally to calibration quality.

        Miscalibrated networks (quality < 0.5) have their weight reduced
        proportionally. Well-calibrated networks get their weights renormalized
        upward to compensate.

        Args:
            base_weights: [w_a, w_b, w_c, w_d, w_e] — current meta-learner weights

        Returns:
            Adjusted weights (normalized to sum=1)
        """
        keys = "abcde"
        adjusted = [
            base_weights[i] * self.quality.get(k, 1.0)
            for i, k in enumerate(keys)
        ]
        total = sum(adjusted)
        if total > 0:
            return [w / total for w in adjusted]
        return [0.2] * 5   # fallback: equal weights

    # ─────────────────────────────────────────────────────────
    # Calibration metrics for trust ramp
    # ─────────────────────────────────────────────────────────

    def get_avg_prediction_set_size(self, db_path: str) -> float:
        """
        Compute average prediction set size on recent evaluations.

        Used by nightly.py for trust ramp phase advancement:
          - Phase 1 → 2: avg_size < 1.5
          - Phase 2 → 3: avg_size < 1.2
          - Phase 3 → 4: avg_size < 1.1

        Returns:
            Average number of outcomes in the prediction set (1.0–3.0)
        """
        conn = sqlite3.connect(db_path)
        cutoff = (datetime.now() - timedelta(days=self.window_days)).isoformat()

        try:
            rows = conn.execute("""
                SELECT prediction_set
                FROM amygdala_evaluations
                WHERE datetime(timestamp) >= datetime(?)
                  AND prediction_set IS NOT NULL
                  AND prediction_set != '[]'
            """, (cutoff,)).fetchall()
        except sqlite3.OperationalError:
            rows = []
        conn.close()

        if not rows:
            return 3.0   # Default: uncertain / no data

        sizes = []
        for (ps_json,) in rows:
            try:
                ps = json.loads(ps_json)
                sizes.append(max(len(ps), 1))
            except Exception:
                sizes.append(3)

        return float(np.mean(sizes))

    # ─────────────────────────────────────────────────────────
    # Persist calibration to DB
    # ─────────────────────────────────────────────────────────

    def save_calibration_to_db(self, db_path: str) -> None:
        """
        Persist current quantiles and quality scores to a calibration metadata
        table for use by the TypeScript runtime (which reads them for conformal
        inference without re-running Python).
        """
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS conformal_metadata (
                network_key  TEXT PRIMARY KEY,
                quantile_safe         REAL NOT NULL,
                quantile_needs_review REAL NOT NULL,
                quantile_dangerous    REAL NOT NULL,
                quality               REAL NOT NULL,
                epsilon               REAL NOT NULL,
                updated_at            TEXT NOT NULL
            )
        """)

        now = datetime.now().isoformat()
        for key in "abcde":
            q = self.quantiles.get(key, [0.95, 0.95, 0.95])
            qual = self.quality.get(key, 0.5)
            conn.execute("""
                INSERT OR REPLACE INTO conformal_metadata
                    (network_key, quantile_safe, quantile_needs_review,
                     quantile_dangerous, quality, epsilon, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (key, q[0], q[1], q[2], qual, self.epsilon, now))

        conn.commit()
        conn.close()
        print(f"[conformal] Calibration metadata saved to {db_path}")


# ─────────────────────────────────────────────────────────────
# Calibration data ingestion
# ─────────────────────────────────────────────────────────────

def ingest_evaluation_to_calibration(
    db_path: str,
    evaluation_id: int,
    network_key: str,
    probs: List[float],    # [p_safe, p_needs_review, p_dangerous]
    actual_outcome: str,   # "safe" | "needs-review" | "dangerous"
    timestamp: Optional[str] = None,
) -> None:
    """
    Insert a single calibration data point.

    Called by the runtime after an evaluation's actual outcome is known.
    Computes and stores nonconformity scores.

    Args:
        db_path:        Path to training.sqlite
        evaluation_id:  ID from amygdala_evaluations
        network_key:    "a" | "b" | "c" | "d" | "e"
        probs:          [p_safe, p_needs_review, p_dangerous]
        actual_outcome: Observed outcome (one of OUTCOMES)
        timestamp:      ISO 8601 timestamp (defaults to now)
    """
    if actual_outcome not in OUTCOME_IDX:
        actual_outcome = "needs-review"

    nc_safe = 1.0 - probs[0]
    nc_nr   = 1.0 - probs[1]
    nc_dan  = 1.0 - probs[2]
    ts = timestamp or datetime.now().isoformat()

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")

    try:
        conn.execute("""
            INSERT INTO conformal_calibration
                (network_key, timestamp,
                 prob_safe, prob_needs_review, prob_dangerous,
                 actual_outcome,
                 nonconformity_safe, nonconformity_needs_review, nonconformity_dangerous)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (network_key, ts,
              probs[0], probs[1], probs[2],
              actual_outcome,
              nc_safe, nc_nr, nc_dan))
        conn.commit()
    except sqlite3.OperationalError as e:
        # Table may not exist yet — create and retry
        conn.execute("""
            CREATE TABLE IF NOT EXISTS conformal_calibration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_key TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                prob_safe REAL NOT NULL,
                prob_needs_review REAL NOT NULL,
                prob_dangerous REAL NOT NULL,
                actual_outcome TEXT NOT NULL,
                nonconformity_safe REAL NOT NULL,
                nonconformity_needs_review REAL NOT NULL,
                nonconformity_dangerous REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            INSERT INTO conformal_calibration
                (network_key, timestamp,
                 prob_safe, prob_needs_review, prob_dangerous,
                 actual_outcome,
                 nonconformity_safe, nonconformity_needs_review, nonconformity_dangerous)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (network_key, ts,
              probs[0], probs[1], probs[2],
              actual_outcome,
              nc_safe, nc_nr, nc_dan))
        conn.commit()
    finally:
        conn.close()
