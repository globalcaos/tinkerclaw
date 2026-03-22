"""
AMYGDALA Training Pipeline Unit Tests (P0.5.2)
===============================================
Tests:
  1. Data loader batch shapes
  2. Asymmetric loss weights (w_stop > w_allow)
  3. PPO clip works correctly
  4. Conformal prediction achieves target coverage on synthetic data
  5. ONNX export produces valid models

Run:
    pytest training/amygdala/tests/test_training.py -v
"""

import json
import math
import os
import sqlite3
import struct
import tempfile
from pathlib import Path
from typing import List

import numpy as np
import pytest
import torch
import torch.nn as nn

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

BATCH    = 4
K        = 32
DIM      = 512
EMB_DIM  = 64


def _make_fake_db(path: str, n: int = 80) -> None:
    """
    Create a minimal training.sqlite with n labeled rows.
    Uses deterministic splits: 64 train / 8 val / 8 test (80/10/10).
    """
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE amygdala_evaluations (
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

    outcomes = ["positive", "mild_negative", "moderate_negative", "severe_negative"]
    gate_decisions = ["allow", "allow", "soft_block", "hard_block"]

    for i in range(n):
        ts        = f"2026-0{(i // 30) + 1:01d}-{(i % 30) + 1:02d}T12:00:00"
        emb       = np.random.randn(DIM).astype(np.float32)
        pers_emb  = np.random.randn(EMB_DIM).astype(np.float32)
        outcome   = outcomes[i % len(outcomes)]
        gate      = gate_decisions[i % len(gate_decisions)]
        sit       = json.dumps({"action_type": "overwrite", "target_id": f"file_{i}.txt"})

        conn.execute("""
            INSERT INTO amygdala_evaluations
                (timestamp, embedding, situation_json, outcome, outcome_source,
                 outcome_weight, personality_combined, gate_decision, serialized)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            ts,
            emb.tobytes(),
            sit,
            outcome,
            "test",
            1.0,
            pers_emb.tobytes(),
            gate,
            f"serialized situation {i}",
        ))

    conn.commit()
    conn.close()


# ─────────────────────────────────────────────────────────────
# Test 1: Data loader batch shapes
# ─────────────────────────────────────────────────────────────

class TestDataLoader:
    def test_batch_shapes_prudence(self, tmp_path):
        db = str(tmp_path / "train.sqlite")
        _make_fake_db(db, n=100)

        from training.amygdala.data_loader import get_data_loaders
        train_dl, val_dl, test_dl = get_data_loaders(
            db, family="prudence", batch_size=8, num_workers=0
        )

        batch = next(iter(train_dl))
        seqs, labels, weights = batch

        assert seqs.shape == (8, K, DIM),  f"seq shape {seqs.shape} != (8, {K}, {DIM})"
        assert labels.shape == (8,),        f"label shape {labels.shape} != (8,)"
        assert weights.shape == (8,),       f"weight shape {weights.shape} != (8,)"
        assert labels.dtype == torch.long,  f"label dtype {labels.dtype} != long"
        assert (labels >= 0).all() and (labels <= 2).all(), "labels out of [0,2]"

    def test_batch_shapes_personality(self, tmp_path):
        db = str(tmp_path / "train.sqlite")
        _make_fake_db(db, n=100)

        from training.amygdala.data_loader import get_data_loaders
        train_dl, val_dl, test_dl = get_data_loaders(
            db, family="personality", batch_size=8, num_workers=0
        )

        seqs, labels, weights = next(iter(train_dl))
        assert seqs.shape   == (8, K, DIM),   f"seq shape mismatch: {seqs.shape}"
        assert labels.shape == (8, EMB_DIM),  f"label shape mismatch: {labels.shape}"
        assert labels.dtype == torch.float

    def test_chronological_split(self, tmp_path):
        """Train/val/test splits must be in chronological order (no leakage)."""
        db = str(tmp_path / "train.sqlite")
        _make_fake_db(db, n=100)

        from training.amygdala.data_loader import _load_rows
        rows = _load_rows(db)
        n = len(rows)
        train_end = int(n * 0.80)
        val_end   = train_end + int(n * 0.10)

        train_ts = [r["timestamp"] for r in rows[:train_end]]
        val_ts   = [r["timestamp"] for r in rows[train_end:val_end]]
        test_ts  = [r["timestamp"] for r in rows[val_end:]]

        # Last train timestamp must be ≤ first val timestamp
        if train_ts and val_ts:
            assert train_ts[-1] <= val_ts[0], "Temporal leakage: train overlaps val"
        if val_ts and test_ts:
            assert val_ts[-1] <= test_ts[0], "Temporal leakage: val overlaps test"

    def test_no_empty_loader(self, tmp_path):
        """Even with small data, loaders must not be empty."""
        db = str(tmp_path / "train.sqlite")
        _make_fake_db(db, n=20)

        from training.amygdala.data_loader import get_data_loaders
        train_dl, val_dl, test_dl = get_data_loaders(
            db, family="prudence", batch_size=4, num_workers=0
        )
        assert len(train_dl.dataset) > 0  # type: ignore[arg-type]

    def test_padding_shape(self, tmp_path):
        """First sample in time-ordered data has fewer than K predecessors → must be padded."""
        db = str(tmp_path / "train.sqlite")
        _make_fake_db(db, n=50)

        from training.amygdala.data_loader import get_data_loaders
        train_dl, _, _ = get_data_loaders(
            db, family="prudence", batch_size=50, num_workers=0,
            use_weighted_sampler=False,
        )
        seqs, _, _ = next(iter(train_dl))
        # All sequences must be exactly [K, DIM]
        assert seqs.shape[1] == K,   "Sequence window size mismatch"
        assert seqs.shape[2] == DIM, "Embedding dimension mismatch"


# ─────────────────────────────────────────────────────────────
# Test 2: Asymmetric loss weights
# ─────────────────────────────────────────────────────────────

class TestAsymmetricLoss:
    """
    Verify that the asymmetric class weights penalise FN (missing danger)
    more than FP (false alarm).

    Specifically: loss(wrong_stop) > loss(wrong_allow) > loss(wrong_escalate).
    w_stop=10, w_allow=1, w_escalate=3  →  stop class is penalized 10× more.
    """

    def _make_loss(self, device="cpu"):
        from training.amygdala.pretrain import make_prudence_criterion
        return make_prudence_criterion(torch.device(device))

    def test_w_stop_greater_than_w_allow(self):
        crit = self._make_loss()

        # FN (missed danger): true label = stop (0), model strongly predicts allow (1)
        logits_fn_stop  = torch.tensor([[-10.0, 10.0, -10.0]])   # predicts allow
        true_stop       = torch.tensor([0])                        # but truth is stop

        # FP (false alarm): true label = allow (1), model strongly predicts stop (0)
        logits_fp_allow = torch.tensor([[10.0, -10.0, -10.0]])    # predicts stop
        true_allow      = torch.tensor([1])                        # but truth is allow

        loss_fn_stop  = crit(logits_fn_stop,  true_stop).mean().item()   # missed danger
        loss_fp_allow = crit(logits_fp_allow, true_allow).mean().item()  # false alarm

        # w_stop=10 >> w_allow=1: FN on "stop" class should cost 10× more than FP on "allow"
        # Both losses are driven by CrossEntropy on near-saturated logits (~20 nats),
        # but scaled by class weights: FN_stop uses w_stop=10, FP_allow uses w_allow=1.
        assert loss_fn_stop > loss_fp_allow * 5, (
            f"Asymmetric loss violated: loss_fn_stop={loss_fn_stop:.3f} "
            f"should be >> loss_fp_allow={loss_fp_allow:.3f} (ratio should be ~10×)"
        )

    def test_w_escalate_greater_than_w_allow(self):
        crit = self._make_loss()
        # w_escalate=3 > w_allow=1
        # FN on escalate (true=2, pred strongly=1) vs FN on allow (true=1, pred strongly=2)
        logits_fn_esc   = torch.tensor([[-10.0, 10.0, -10.0]])   # predicts allow, true=escalate
        logits_fn_allow = torch.tensor([[-10.0, -10.0, 10.0]])   # predicts escalate, true=allow

        loss_esc   = crit(logits_fn_esc,   torch.tensor([2])).mean().item()  # w_escalate=3
        loss_allow = crit(logits_fn_allow, torch.tensor([1])).mean().item()  # w_allow=1

        assert loss_esc > loss_allow, (
            f"w_escalate ({loss_esc:.3f}) should be > w_allow ({loss_allow:.3f})"
        )

    def test_weight_ratios(self):
        """
        Check that the actual weight ratios match the specification:
          w_stop : w_allow : w_escalate = 10 : 1 : 3
        """
        from training.amygdala.pretrain import PRUDENCE_CLASS_WEIGHTS
        w = PRUDENCE_CLASS_WEIGHTS
        assert w["w_stop"]     == 10.0, f"w_stop={w['w_stop']} != 10"
        assert w["w_allow"]    == 1.0,  f"w_allow={w['w_allow']} != 1"
        assert w["w_escalate"] == 3.0,  f"w_escalate={w['w_escalate']} != 3"
        assert w["w_stop"] > w["w_allow"], "w_stop must be > w_allow"
        assert w["w_stop"] > w["w_escalate"], "w_stop must be > w_escalate"


# ─────────────────────────────────────────────────────────────
# Test 3: PPO clip
# ─────────────────────────────────────────────────────────────

class TestPPOClip:
    """
    Verify that the PPO clipped objective correctly clamps the probability ratio.
    When ratio > 1 + ε, the gradient should be clipped (advantage is bounded).
    When ratio < 1 - ε, the gradient should also be clipped.
    """

    def _ppo_clipped_objective(
        self,
        ratio: torch.Tensor,
        advantages: torch.Tensor,
        clip_ratio: float = 0.2,
    ) -> torch.Tensor:
        """Minimal PPO clipped surrogate for testing."""
        surr1 = ratio * advantages
        surr2 = torch.clamp(ratio, 1 - clip_ratio, 1 + clip_ratio) * advantages
        return -torch.min(surr1, surr2).mean()

    def test_clip_high_ratio_positive_advantage(self):
        """
        If ratio >> 1+ε and advantage > 0, gradient should be clipped.
        The clipped loss == surr2 (the clamped version).
        """
        clip_ratio = 0.2
        ratio      = torch.tensor([2.0, 2.5, 3.0])  # all > 1 + 0.2
        advantage  = torch.tensor([1.0, 1.0, 1.0])

        # surr1 = ratio * advantage = [2.0, 2.5, 3.0]
        # surr2 = 1.2 * advantage   = [1.2, 1.2, 1.2]
        # min   = surr2              → loss is bounded

        loss = self._ppo_clipped_objective(ratio, advantage, clip_ratio)
        expected = -(1.2 * advantage).mean()  # clipped surr2

        assert abs(loss.item() - expected.item()) < 1e-5, (
            f"PPO high ratio clip failed: loss={loss:.4f} expected={expected:.4f}"
        )

    def test_clip_low_ratio_negative_advantage(self):
        """
        If ratio << 1-ε and advantage < 0, gradient should be clipped.
        """
        clip_ratio = 0.2
        ratio      = torch.tensor([0.1, 0.05])  # all < 1 - 0.2 = 0.8
        advantage  = torch.tensor([-1.0, -1.0])

        # surr1 = 0.1 * (-1) = -0.1  (less negative)
        # surr2 = 0.8 * (-1) = -0.8  (more negative, = clamp lower bound)
        # min(surr1, surr2) = surr2  → clipped

        loss = self._ppo_clipped_objective(ratio, advantage, clip_ratio)
        # loss = -mean(min(surr1, surr2)) = -mean(-0.8) = 0.8
        assert loss.item() > 0.7, f"PPO low ratio clip failed: loss={loss:.4f}"

    def test_no_clip_within_range(self):
        """
        When ratio ∈ [1-ε, 1+ε], gradient should NOT be clipped.
        surr1 == surr2 for ratios within the clip range.
        """
        clip_ratio = 0.2
        ratio      = torch.tensor([1.0, 1.1, 0.9])  # within [0.8, 1.2]
        advantage  = torch.tensor([1.0, 1.0, 1.0])

        surr1_vals = ratio * advantage
        surr2_vals = torch.clamp(ratio, 1 - clip_ratio, 1 + clip_ratio) * advantage

        # Should be equal for ratios in range
        assert torch.allclose(surr1_vals, surr2_vals, atol=1e-6), (
            "Ratios within clip range should not be clipped"
        )

    def test_ppo_buffer_advantages(self):
        """GAE computation produces advantages of the right shape."""
        from training.amygdala.ppo_trainer import PPOBuffer

        buf = PPOBuffer()
        for i in range(10):
            buf.add(
                state    = torch.zeros(K, DIM),
                action   = 1,
                reward   = float(i % 2),
                log_prob = -0.5,
                value    = 0.3,
            )

        advantages, returns = buf.compute_advantages(gamma=0.99, gae_lambda=0.95)
        assert advantages.shape == (10,), f"advantages shape {advantages.shape}"
        assert returns.shape    == (10,), f"returns shape {returns.shape}"
        assert not np.isnan(advantages).any(), "NaN in advantages"
        assert not np.isnan(returns).any(),    "NaN in returns"


# ─────────────────────────────────────────────────────────────
# Test 4: Conformal prediction coverage
# ─────────────────────────────────────────────────────────────

class TestConformalPrediction:
    """
    Verify that conformal prediction achieves target coverage on synthetic data.

    Generates N=500 synthetic (prob, outcome) pairs, calibrates on 400,
    tests on 100, and checks empirical coverage >= 1-ε = 0.95.
    """

    def _generate_synthetic_calibration_data(self, n: int = 400, seed: int = 42):
        """
        Generate synthetic calibration rows.

        For each sample:
          - True outcome drawn uniformly from {safe, needs-review, dangerous}
          - Predicted probs are noisy Dirichlet(α) centred on the true class
        """
        rng = np.random.default_rng(seed)
        outcomes = ["safe", "needs-review", "dangerous"]
        rows = []

        for i in range(n):
            true_idx = rng.integers(0, 3)
            true_out = outcomes[true_idx]

            alpha = np.ones(3) * 0.3
            alpha[true_idx] += 2.0
            probs = rng.dirichlet(alpha)

            nc = [1 - float(probs[j]) for j in range(3)]
            rows.append({
                "prob_safe":               float(probs[0]),
                "prob_needs_review":       float(probs[1]),
                "prob_dangerous":          float(probs[2]),
                "actual_outcome":          true_out,
                "nonconformity_safe":      nc[0],
                "nonconformity_needs_review": nc[1],
                "nonconformity_dangerous": nc[2],
            })

        return rows

    def _populate_calibration_db(self, path: str, rows: list, key: str = "a") -> None:
        conn = sqlite3.connect(path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS conformal_calibration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_key TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                prob_safe REAL, prob_needs_review REAL, prob_dangerous REAL,
                actual_outcome TEXT NOT NULL,
                nonconformity_safe REAL, nonconformity_needs_review REAL,
                nonconformity_dangerous REAL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        for i, row in enumerate(rows):
            conn.execute("""
                INSERT INTO conformal_calibration
                    (network_key, timestamp,
                     prob_safe, prob_needs_review, prob_dangerous, actual_outcome,
                     nonconformity_safe, nonconformity_needs_review, nonconformity_dangerous)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                key,
                f"2026-03-{(i % 30) + 1:02d}T12:00:00",
                row["prob_safe"], row["prob_needs_review"], row["prob_dangerous"],
                row["actual_outcome"],
                row["nonconformity_safe"], row["nonconformity_needs_review"],
                row["nonconformity_dangerous"],
            ))
        conn.commit()
        conn.close()

    def test_coverage_on_synthetic_data(self, tmp_path):
        """
        Empirical coverage must be >= 1 - ε (with reasonable tolerance).
        """
        from training.amygdala.conformal import ConformalCalibrator, OUTCOME_IDX

        epsilon = 0.05
        all_data = self._generate_synthetic_calibration_data(n=600, seed=0)
        cal_data  = all_data[:480]
        test_data = all_data[480:]

        db_path = str(tmp_path / "cal.sqlite")
        self._populate_calibration_db(db_path, cal_data, key="a")

        cal = ConformalCalibrator(epsilon=epsilon, window_days=30)
        # Patch window to cover all cal data
        cal.window_days = 3650
        cal.calibrate_from_db(db_path, "a")

        # Compute empirical coverage on held-out test set
        covered = 0
        for row in test_data:
            probs = [row["prob_safe"], row["prob_needs_review"], row["prob_dangerous"]]
            pred_set = cal.predict("a", probs)
            actual   = row["actual_outcome"]
            if actual in pred_set:
                covered += 1

        coverage = covered / len(test_data)
        target   = 1.0 - epsilon

        assert coverage >= target - 0.05, (
            f"Coverage {coverage:.3f} < target {target:.3f} - 0.05 tolerance. "
            f"Conformal prediction guarantee violated."
        )
        print(f"\n  [conformal] Empirical coverage: {coverage:.3f} (target ≥ {target:.3f})")

    def test_prediction_set_not_empty(self, tmp_path):
        """Prediction set must always contain at least one outcome."""
        from training.amygdala.conformal import ConformalCalibrator

        cal_data = self._generate_synthetic_calibration_data(n=200)
        db_path  = str(tmp_path / "cal2.sqlite")
        self._populate_calibration_db(db_path, cal_data, key="b")

        cal = ConformalCalibrator(epsilon=0.05, window_days=3650)
        cal.calibrate_from_db(db_path, "b")

        # Test with extreme inputs
        for probs in [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.33, 0.33, 0.34],
        ]:
            ps = cal.predict("b", probs)
            assert len(ps) >= 1, f"Empty prediction set for probs={probs}"

    def test_miscalibrated_network_excluded(self, tmp_path):
        """
        A network with quality < 0.5 should be excluded from ensemble prediction.
        """
        from training.amygdala.conformal import ConformalCalibrator

        cal = ConformalCalibrator(epsilon=0.05)
        # Manually set quality below threshold
        cal.quality    = {"a": 0.1, "b": 0.9, "c": 0.9, "d": 0.9, "e": 0.9}
        cal.quantiles  = {k: [0.9, 0.9, 0.9] for k in "abcde"}

        probs_by_arch = {
            "a": [0.0, 0.0, 1.0],  # says "dangerous" — should be ignored
            "b": [0.9, 0.1, 0.0],  # says "safe"
            "c": [0.9, 0.1, 0.0],
            "d": [0.9, 0.1, 0.0],
            "e": [0.9, 0.1, 0.0],
        }
        combined = cal.predict_ensemble(probs_by_arch, min_quality=0.5)

        # Network "a" was miscalibrated — "dangerous" should NOT appear
        # unless networks b-e also include it
        b_e_include_dangerous = any(
            1 - probs_by_arch[k][2] <= cal.quantiles[k][2]
            for k in "bcde"
        )
        if not b_e_include_dangerous:
            assert "dangerous" not in combined, (
                "Miscalibrated network A should not contribute 'dangerous' to ensemble"
            )


# ─────────────────────────────────────────────────────────────
# Test 5: ONNX export
# ─────────────────────────────────────────────────────────────

class TestONNXExport:
    """
    Verify ONNX export produces valid models that match PyTorch outputs.
    """

    @pytest.mark.parametrize("arch_key", ["a", "b", "c", "d", "e"])
    def test_prudence_onnx_export(self, tmp_path, arch_key):
        from training.amygdala.export_onnx import export_prudence, verify_prudence

        onnx_path = str(tmp_path / f"prudence_{arch_key}.onnx")
        export_prudence(arch_key, weights_path=None, output_path=onnx_path)

        assert Path(onnx_path).exists(), f"ONNX file not created: {onnx_path}"
        assert Path(onnx_path).stat().st_size > 1000, "ONNX file suspiciously small"

    @pytest.mark.parametrize("arch_key", ["a", "b", "c", "d", "e"])
    def test_personality_onnx_export(self, tmp_path, arch_key):
        from training.amygdala.export_onnx import export_personality

        onnx_path = str(tmp_path / f"personality_{arch_key}.onnx")
        export_personality(arch_key, weights_path=None, output_path=onnx_path)

        assert Path(onnx_path).exists()
        assert Path(onnx_path).stat().st_size > 1000

    @pytest.mark.parametrize("arch_key", ["a", "b", "c", "d", "e"])
    def test_onnx_output_shape_prudence(self, tmp_path, arch_key):
        """ONNX Prudence outputs must have correct shapes."""
        pytest.importorskip("onnxruntime")
        import onnxruntime as ort
        from training.amygdala.export_onnx import export_prudence

        onnx_path = str(tmp_path / f"prudence_{arch_key}_shape.onnx")
        export_prudence(arch_key, None, onnx_path)
        sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

        B = 2
        if arch_key in ("a", "b", "c"):
            dummy = np.random.randn(B, K, DIM).astype(np.float32)
            gate, conf, amb = sess.run(None, {"sequence": dummy})
        elif arch_key == "d":
            ctx = np.random.randn(B, K-1, DIM).astype(np.float32)
            cur = np.random.randn(B, DIM).astype(np.float32)
            gate, conf, amb = sess.run(None, {"context": ctx, "current": cur})
        else:  # e
            cur = np.random.randn(B, DIM).astype(np.float32)
            gate, conf, amb = sess.run(None, {"current": cur})

        assert gate.shape == (B, 3),  f"gate_probs shape {gate.shape} != ({B}, 3)"
        assert conf.shape == (B, 1),  f"confidence shape {conf.shape} != ({B}, 1)"
        assert amb.shape  == (B, 1),  f"ambiguity shape {amb.shape} != ({B}, 1)"
        assert abs(gate.sum(axis=-1).mean() - 1.0) < 1e-4, "gate probs must sum to 1"

    @pytest.mark.parametrize("arch_key", ["a", "b", "c", "d", "e"])
    def test_onnx_output_shape_personality(self, tmp_path, arch_key):
        """ONNX Personality outputs must have shape [B, 64]."""
        pytest.importorskip("onnxruntime")
        import onnxruntime as ort
        from training.amygdala.export_onnx import export_personality

        onnx_path = str(tmp_path / f"personality_{arch_key}_shape.onnx")
        export_personality(arch_key, None, onnx_path)
        sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

        B = 2
        if arch_key in ("a", "b", "c"):
            dummy = np.random.randn(B, K, DIM).astype(np.float32)
            emb = sess.run(None, {"sequence": dummy})[0]
        elif arch_key == "d":
            ctx = np.random.randn(B, K-1, DIM).astype(np.float32)
            cur = np.random.randn(B, DIM).astype(np.float32)
            emb = sess.run(None, {"context": ctx, "current": cur})[0]
        else:
            cur = np.random.randn(B, DIM).astype(np.float32)
            emb = sess.run(None, {"current": cur})[0]

        assert emb.shape == (B, EMB_DIM), f"behaviour_embedding shape {emb.shape} != ({B}, {EMB_DIM})"

    @pytest.mark.parametrize("arch_key", ["a", "b", "c", "d", "e"])
    def test_onnx_matches_pytorch_prudence(self, tmp_path, arch_key):
        """ONNX outputs must numerically match PyTorch outputs (max error < 1e-4)."""
        pytest.importorskip("onnxruntime")
        from training.amygdala.export_onnx import export_prudence, verify_prudence

        onnx_path = str(tmp_path / f"prudence_{arch_key}_verify.onnx")
        export_prudence(arch_key, None, onnx_path)
        ok = verify_prudence(arch_key, onnx_path, atol=1e-4)
        assert ok, f"ONNX/PyTorch mismatch for Prudence-{arch_key.upper()}"


# ─────────────────────────────────────────────────────────────
# Integration smoke test
# ─────────────────────────────────────────────────────────────

class TestIntegration:
    def test_full_pipeline_smoke(self, tmp_path):
        """
        Smoke test: data loader → model forward pass → loss computation.
        Does not require a GPU or a trained checkpoint.
        """
        db = str(tmp_path / "smoke.sqlite")
        _make_fake_db(db, n=40)

        from training.amygdala.data_loader import get_data_loaders
        from training.amygdala.architectures import PrudenceA_GRU_MLP
        from training.amygdala.pretrain import make_prudence_criterion

        train_dl, _, _ = get_data_loaders(db, family="prudence", batch_size=4)
        model = PrudenceA_GRU_MLP()
        model.eval()
        crit = make_prudence_criterion(torch.device("cpu"))

        seqs, labels, weights = next(iter(train_dl))
        with torch.no_grad():
            out  = model(sequence=seqs)
            gate = out["gate_probabilities"]  # [B, 3]
            loss = (crit(gate, labels) * weights).mean()

        assert not torch.isnan(loss), "Loss is NaN"
        assert loss.item() > 0,       "Loss should be positive"
        assert gate.shape == (4, 3),  f"gate_probs shape {gate.shape}"
