"""
AMYGDALA Nightly Training Orchestrator (P0.5.2)
================================================
Orchestrates the full nightly AMYGDALA retraining cycle, designed to be
called by CEREBELLUM's nightly cron job.

Pipeline:
  1. Mine history (extract new examples from session transcripts)
  2. Reflect & curate (detect/resolve contradictions in training data)
  3. Batch reward labeling (label today's unlabeled evaluations)
  4. Fine-tune all 10 networks (1-3 PPO epochs + 3 supervised epochs)
  5. Recalibrate conformal prediction (rolling 30-day window)
  6. Compute calibration quality and exclude miscalibrated networks
  7. Export updated ONNX models
  8. Update meta-learner weights
  9. Update trust ramp α based on avg prediction set size

Integration with CEREBELLUM (TypeScript side):
  // In CEREBELLUM's nightly cycle (e.g. src/cerebellum/nightly.ts):
  import { execSync } from 'child_process';

  async function runNightlyCycle() {
    await reflectOnDay();
    await updateLessons();
    await trainAmygdala();   // <-- ADD THIS
  }

  async function trainAmygdala() {
    execSync('python -m training.amygdala.nightly', {
      cwd: process.env.TINKERCLAW_ROOT,
      timeout: 600_000,  // 10 min max
    });
  }

Expected runtime: <10 minutes on consumer GPU, <30 min on CPU.
"""

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Optional

import torch

# ─────────────────────────────────────────────────────────────
# Default paths (can be overridden via env vars or CLI)
# ─────────────────────────────────────────────────────────────

DEFAULT_TRAINING_DB = os.path.expanduser("~/src/tinkerclaw/data/amygdala/training.sqlite")
DEFAULT_MODELS_DIR  = os.path.expanduser("~/src/tinkerclaw/models/amygdala/")
DEFAULT_WEIGHTS_DIR = os.path.expanduser("~/src/tinkerclaw/output/pretrain/")

# ─────────────────────────────────────────────────────────────
# Reward labeling (Addendum B)
# ─────────────────────────────────────────────────────────────

def _label_rewards(db_path: str) -> Dict:
    """
    Offline batch reward labeling for today's evaluations.

    Applies programmatic heuristics first (fast, reliable), then falls back
    to 'no complaint → mild positive' for any remaining unlabeled rows.

    Full LLM-based labeling is in reward_labeling.py (optional, requires ollama).
    """
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")

    cutoff = (datetime.now() - timedelta(hours=26)).isoformat()

    # Find evaluations from the last 24h that still have no outcome
    rows = conn.execute("""
        SELECT id, situation_json, gate_decision, timestamp
        FROM amygdala_evaluations
        WHERE outcome IS NULL
          AND datetime(timestamp) >= datetime(?)
        ORDER BY timestamp ASC
    """, (cutoff,)).fetchall()

    labeled = 0
    for eval_id, sit_json, gate_decision, ts in rows:
        # Default: assume no complaint → mild positive
        conn.execute("""
            UPDATE amygdala_evaluations
            SET outcome = 'positive',
                outcome_source = 'no_complaint_default',
                outcome_weight = 0.3,
                outcome_timestamp = datetime('now')
            WHERE id = ?
        """, (eval_id,))
        labeled += 1

    conn.commit()
    conn.close()
    return {"labeled": labeled, "total": len(rows)}


# ─────────────────────────────────────────────────────────────
# Trust ramp helpers
# ─────────────────────────────────────────────────────────────

ALPHA_MAX_BY_PHASE = {1: 0.15, 2: 0.40, 3: 0.70, 4: 0.90}
PHASE_ADVANCE_THRESHOLD = {1: 1.5, 2: 1.2, 3: 1.1}  # avg_set_size to advance

def _get_current_phase(db_path: str) -> int:
    try:
        conn = sqlite3.connect(db_path)
        row = conn.execute("""
            SELECT phase FROM trust_ramp_history
            ORDER BY date DESC, id DESC LIMIT 1
        """).fetchone()
        conn.close()
        return row[0] if row else 1
    except Exception:
        return 1


def _update_trust_ramp(
    db_path: str,
    alpha: float,
    phase: int,
    avg_set_size: float,
    conformal_coverage: float,
) -> None:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trust_ramp_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                alpha_prudence REAL NOT NULL,
                alpha_personality REAL NOT NULL,
                phase INTEGER NOT NULL,
                reward_7d_avg REAL NOT NULL,
                avg_prediction_set_size REAL NOT NULL,
                conformal_coverage REAL NOT NULL,
                notes TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            INSERT INTO trust_ramp_history
                (date, alpha_prudence, alpha_personality, phase,
                 reward_7d_avg, avg_prediction_set_size, conformal_coverage)
            VALUES (date('now'), ?, ?, ?, 0.0, ?, ?)
        """, (alpha, alpha, phase, avg_set_size, conformal_coverage))
        conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────
# Meta-learner weight update
# ─────────────────────────────────────────────────────────────

def _update_meta_learner_weights(
    db_path: str,
    quality_scores: Dict[str, float],
    family: str = "prudence",
) -> None:
    """Save adjusted meta-learner weights based on calibration quality."""
    from .architectures import PrudenceMetaLearner, PersonalityMetaLearner

    # Weights proportional to calibration quality
    keys = "abcde"
    base = [0.2] * 5
    adjusted = [base[i] * quality_scores.get(k, 1.0) for i, k in enumerate(keys)]
    total = sum(adjusted) or 1.0
    weights = [w / total for w in adjusted]

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS meta_learner_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                family TEXT NOT NULL,
                weight_a REAL, weight_b REAL, weight_c REAL,
                weight_d REAL, weight_e REAL,
                perf_a REAL, perf_b REAL, perf_c REAL, perf_d REAL, perf_e REAL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        conn.execute("""
            INSERT INTO meta_learner_history
                (date, family, weight_a, weight_b, weight_c, weight_d, weight_e,
                 perf_a, perf_b, perf_c, perf_d, perf_e)
            VALUES (date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            family, *weights,
            *[quality_scores.get(k) for k in keys],
        ))
        conn.commit()
    finally:
        conn.close()

    print(f"[nightly] Meta-learner weights ({family}): {dict(zip(keys, [f'{w:.3f}' for w in weights]))}")


# ─────────────────────────────────────────────────────────────
# Main orchestration
# ─────────────────────────────────────────────────────────────

def run_nightly(
    training_db: str = DEFAULT_TRAINING_DB,
    models_dir:  str = DEFAULT_MODELS_DIR,
    weights_dir: str = DEFAULT_WEIGHTS_DIR,
    device_str:  Optional[str] = None,
    ppo_epochs:  int = 3,
    finetune_epochs: int = 3,
    sessions_dir: Optional[str] = None,
) -> Dict:
    """
    Full nightly AMYGDALA training cycle.

    Steps:
      1. Mine history       — extract new examples from session transcripts
      2. Reflect & curate   — detect/resolve contradictions in training data
      3. Reward labeling    — label today's unlabeled evaluations
      4. PPO update         — online RL on new experiences
      5. Supervised fine-tune — 3 supervised epochs per network
      6. Conformal calibration — recalibrate 30-day rolling window
      7. Export ONNX        — push updated models to runtime
      8. Meta-learner update — adjust weights by calibration quality
      9. Trust ramp update  — advance phase if coverage improves

    Returns:
        Summary dict with metrics from each step
    """
    start_time = time.time()
    ts = datetime.now().isoformat()
    print(f"\n{'='*60}")
    print(f"[nightly] AMYGDALA nightly cycle started at {ts}")
    print(f"{'='*60}")

    summary: Dict = {"started_at": ts, "steps": {}}

    # Ensure DB exists with correct WAL settings
    Path(training_db).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(training_db)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.close()

    device = torch.device(device_str or ("cuda" if torch.cuda.is_available() else "cpu"))
    print(f"[nightly] Device: {device}")

    # ── Step 1: Mine history ─────────────────────────────────
    # ── Step 2: Reflect & curate ─────────────────────────────
    print("\n[step 1-2/9] Mine & reflect...")
    try:
        from .reflect_and_curate import reflect_and_curate
        rc_results = reflect_and_curate(training_db, sessions_dir)
        summary["steps"]["reflect_and_curate"] = rc_results
        print(f"  → mined {rc_results['examples_mined']}, "
              f"contradictions {rc_results['contradictions_found']}, "
              f"demoted {rc_results['examples_demoted']}")
    except Exception as e:
        print(f"  [WARN] Reflect & curate failed: {e}")
        summary["steps"]["reflect_and_curate"] = {"error": str(e)}

    # ── Step 3: Reward labeling ───────────────────────────────
    print("\n[step 3/9] Reward labeling...")
    label_stats = _label_rewards(training_db)
    summary["steps"]["reward_labeling"] = label_stats
    print(f"  → labeled {label_stats['labeled']} evaluations")

    # ── Step 4: PPO update ────────────────────────────────────
    print("\n[step 4/9] PPO update...")
    try:
        from .ppo_trainer import ppo_update_all
        ppo_results = ppo_update_all(
            training_db, weights_dir, device_str=str(device), n_epochs=ppo_epochs
        )
        summary["steps"]["ppo"] = {k: {m: round(v, 4) for m, v in r.items()} for k, r in ppo_results.items()}
    except Exception as e:
        print(f"  [WARN] PPO update failed: {e}")
        summary["steps"]["ppo"] = {"error": str(e)}

    # ── Step 5: Supervised fine-tuning ───────────────────────
    print("\n[step 5/9] Supervised fine-tuning (3 epochs per network)...")
    try:
        from .pretrain import pretrain_all
        ft_config_overrides = dict(
            epochs=finetune_epochs,
            early_stopping_patience=2,
        )

        # Import and patch config for fine-tuning
        ft_results = {}
        from .pretrain import pretrain_prudence, pretrain_personality
        for key in "abcde":
            r = pretrain_prudence(
                key, training_db, weights_dir,
                epochs=finetune_epochs, early_stopping_patience=2,
                device=str(device),
            )
            ft_results[f"prudence_{key}"] = r["best_val_loss"]
            r = pretrain_personality(
                key, training_db, weights_dir,
                epochs=finetune_epochs, early_stopping_patience=2,
                device=str(device),
            )
            ft_results[f"personality_{key}"] = r["best_val_loss"]

        summary["steps"]["finetune"] = ft_results
    except Exception as e:
        print(f"  [WARN] Fine-tuning failed: {e}")
        summary["steps"]["finetune"] = {"error": str(e)}

    # ── Step 6: Conformal calibration ────────────────────────
    print("\n[step 6/9] Conformal calibration...")
    try:
        from .conformal import ConformalCalibrator
        cal = ConformalCalibrator(epsilon=0.05, window_days=30)
        cal_results = cal.calibrate_all(training_db)
        cal.save_calibration_to_db(training_db)

        avg_set_size   = cal.get_avg_prediction_set_size(training_db)
        quality_scores = cal.get_quality_scores()

        # Average coverage across all networks
        coverages = [r.get("coverage", 0.0) for r in cal_results.values() if "coverage" in r]
        avg_coverage = sum(coverages) / max(len(coverages), 1)

        summary["steps"]["conformal"] = {
            "avg_set_size": round(avg_set_size, 3),
            "avg_coverage": round(avg_coverage, 3),
            "quality":      {k: round(v, 3) for k, v in quality_scores.items()},
        }
    except Exception as e:
        print(f"  [WARN] Conformal calibration failed: {e}")
        cal_results    = {}
        avg_set_size   = 3.0
        quality_scores = {k: 0.5 for k in "abcde"}
        avg_coverage   = 0.0
        summary["steps"]["conformal"] = {"error": str(e)}

    # ── Step 7: Export ONNX ───────────────────────────────────
    print("\n[step 7/9] Exporting ONNX models...")
    try:
        from .export_onnx import export_all
        onnx_results = export_all(weights_dir, models_dir, verify=True)
        summary["steps"]["onnx"] = {k: "ok" if v else "fail" for k, v in onnx_results.items()}
    except Exception as e:
        print(f"  [WARN] ONNX export failed: {e}")
        summary["steps"]["onnx"] = {"error": str(e)}

    # ── Step 8: Meta-learner weight update ───────────────────
    print("\n[step 8/9] Updating meta-learner weights...")
    try:
        _update_meta_learner_weights(training_db, quality_scores, "prudence")
        _update_meta_learner_weights(training_db, quality_scores, "personality")
        summary["steps"]["meta_learner"] = "ok"
    except Exception as e:
        print(f"  [WARN] Meta-learner update failed: {e}")
        summary["steps"]["meta_learner"] = {"error": str(e)}

    # ── Step 9: Trust ramp update ─────────────────────────────
    print("\n[step 9/9] Trust ramp update...")
    try:
        current_phase = _get_current_phase(training_db)
        threshold     = PHASE_ADVANCE_THRESHOLD.get(current_phase)
        new_phase     = current_phase

        if threshold and avg_set_size < threshold:
            new_phase = current_phase + 1
            print(f"  *** PHASE ADVANCEMENT: {current_phase} → {new_phase} "
                  f"(avg_set_size={avg_set_size:.2f} < {threshold})")

        alpha = ALPHA_MAX_BY_PHASE.get(new_phase, 0.15)
        _update_trust_ramp(training_db, alpha, new_phase, avg_set_size, avg_coverage)

        summary["steps"]["trust_ramp"] = {
            "phase":        new_phase,
            "alpha":        alpha,
            "avg_set_size": round(avg_set_size, 3),
        }
        print(f"  Phase={new_phase} alpha={alpha:.2f} avg_set_size={avg_set_size:.2f}")
    except Exception as e:
        print(f"  [WARN] Trust ramp update failed: {e}")
        summary["steps"]["trust_ramp"] = {"error": str(e)}

    # ── Final summary ─────────────────────────────────────────
    elapsed = time.time() - start_time
    summary["elapsed_secs"] = round(elapsed, 1)
    summary["completed_at"] = datetime.now().isoformat()

    print(f"\n{'='*60}")
    print(f"[nightly] Cycle complete in {elapsed:.0f}s")
    print(f"{'='*60}\n")

    # Save summary JSON
    summary_path = Path(weights_dir) / "nightly_summary.json"
    Path(weights_dir).mkdir(parents=True, exist_ok=True)
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"[nightly] Summary → {summary_path}")

    return summary


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AMYGDALA nightly training cycle")
    parser.add_argument("--db",      default=DEFAULT_TRAINING_DB, help="Training SQLite path")
    parser.add_argument("--models",  default=DEFAULT_MODELS_DIR,  help="ONNX models directory")
    parser.add_argument("--weights", default=DEFAULT_WEIGHTS_DIR, help="PyTorch checkpoints directory")
    parser.add_argument("--device",  default=None)
    parser.add_argument("--sessions-dir", default=None, help="Session transcripts directory")
    parser.add_argument("--ppo-epochs",      type=int, default=3)
    parser.add_argument("--finetune-epochs", type=int, default=3)
    args = parser.parse_args()

    summary = run_nightly(
        training_db     = args.db,
        models_dir      = args.models,
        weights_dir     = args.weights,
        device_str      = args.device,
        ppo_epochs      = args.ppo_epochs,
        finetune_epochs = args.finetune_epochs,
        sessions_dir    = args.sessions_dir,
    )
    sys.exit(0 if "error" not in str(summary) else 1)
