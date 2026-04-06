#!/usr/bin/env python3
"""
kd_pretrain.py — Knowledge Distillation Pre-training (Addendum A)
=================================================================
Cold-start Personality networks using Knowledge Distillation (KD).

Strategy:
  1. For each historical situation (from mined_examples in training.sqlite):
     - Ask local LLM (Ollama llama3:8b) what personality modulation a
       heavily-prompted operator-persona agent would produce
     - Teacher label = continuous vector in [-1, +1]^5 for 5 personality dims:
         [verbosity, formality, hedging, emoji_rate, assertiveness]
  2. Pre-train Personality networks (A–E) via MSE regression on teacher labels
  3. Save KD-initialized weights as checkpoint before PPO begins

Usage:
    python kd_pretrain.py [--db PATH] [--models-dir DIR] [--epochs N] [--no-llm]

Output: ~/src/tinkerclaw/models/amygdala/personality-{a-e}-kd.pt (PyTorch checkpoints)
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import struct
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DEFAULT_DB = Path.home() / "src" / "tinkerclaw" / "data" / "amygdala" / "training.sqlite"
MODELS_DIR = Path.home() / "src" / "tinkerclaw" / "models" / "amygdala"
OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "llama3:8b"

# Personality dimension names (5-dim teacher label)
PERSONALITY_DIMS = ["verbosity", "formality", "hedging", "emoji_rate", "assertiveness"]


# ─────────────────────────────────────────────────────────────
# Teacher label generation (Ollama)
# ─────────────────────────────────────────────────────────────

_ollama_available: Optional[bool] = None


def check_ollama() -> bool:
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
    if not _ollama_available:
        log.warning("Ollama not available. KD teacher labels will use heuristic fallback.")
    return _ollama_available  # type: ignore


def query_teacher_label(
    situation_json: str,
    preceding_text: str,
) -> Optional[List[float]]:
    """
    Ask the LLM what personality vector a heavily-prompted operator agent would use.
    Returns 5-dim list in [-1, +1] or None on failure.
    """
    if not check_ollama():
        return None

    prompt = f"""You are helping train an AI personality system called AMYGDALA.

Given the following situation (what an AI assistant is about to do), predict what personality
adjustments a well-calibrated operator-style assistant would make. The target operator is technical, direct,
uses dry humor, dislikes over-politeness and emoji spam.

Score each dimension from -1.0 (minimum) to +1.0 (maximum):
- verbosity: -1=very terse, +1=very verbose
- formality: -1=very casual, +1=very formal  
- hedging: -1=very assertive/direct, +1=very hedging/uncertain
- emoji_rate: -1=no emoji, +1=frequent emoji
- assertiveness: -1=passive/deferential, +1=confident/direct

Situation: {situation_json[:400]}
User context: {preceding_text[:300]}

Reply ONLY with JSON: {{"verbosity": X, "formality": X, "hedging": X, "emoji_rate": X, "assertiveness": X}}
All values must be floats in [-1.0, 1.0].
"""

    try:
        import urllib.request
        payload = json.dumps({
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.2, "num_predict": 100},
        }).encode()
        req = urllib.request.Request(
            OLLAMA_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())
        raw = resp.get("response", "").strip()
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            parsed = json.loads(raw[start:end])
            label = [
                float(parsed.get("verbosity", 0.0)),
                float(parsed.get("formality", 0.0)),
                float(parsed.get("hedging", -0.3)),   # operator default: less hedging
                float(parsed.get("emoji_rate", -0.5)),  # operator default: low emoji
                float(parsed.get("assertiveness", 0.4)),  # operator default: assertive
            ]
            # Clamp to [-1, 1]
            return [max(-1.0, min(1.0, x)) for x in label]
    except Exception as exc:
        log.debug("Teacher label query failed: %s", exc)
    return None


def heuristic_teacher_label(action_type: str, outcome_label: float) -> List[float]:
    """
    Fallback teacher label when Ollama is unavailable.
    Uses action type and outcome to approximate the operator's personality adjustment.
    """
    # Base: operator personality defaults
    base = [
        -0.2,  # verbosity: somewhat terse
        -0.3,  # formality: casual-leaning
        -0.4,  # hedging: direct
        -0.6,  # emoji_rate: minimal emoji
        +0.4,  # assertiveness: confident
    ]

    # Modulate based on action type
    if action_type == "message":
        base[0] += 0.1   # slightly more verbose for messages
        base[1] += 0.1   # slightly more formal
    elif action_type == "exec":
        base[0] -= 0.1   # terser for exec
        base[4] += 0.1   # more assertive
    elif action_type == "write":
        base[0] += 0.2   # more verbose for writes (code docs)

    # Modulate based on outcome (reward signal)
    if outcome_label < -0.5:
        base[2] += 0.2   # more hedging after errors
        base[4] -= 0.2   # less assertive after errors
    elif outcome_label > 0.5:
        base[4] += 0.1   # slightly more assertive when things go well

    return [max(-1.0, min(1.0, x)) for x in base]


# ─────────────────────────────────────────────────────────────
# Dataset
# ─────────────────────────────────────────────────────────────

def load_situations(db_path: Path, limit: int = 5000) -> List[Dict[str, Any]]:
    """Load mined examples from training DB."""
    if not db_path.exists():
        log.error("Training DB not found: %s — run mine_history.py first", db_path)
        return []
    conn = sqlite3.connect(str(db_path))
    rows = conn.execute("""
        SELECT id, session_id, action_type, situation_json, embedding, outcome_label
        FROM mined_examples
        ORDER BY RANDOM()
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [
        {
            "id": r[0],
            "session_id": r[1],
            "action_type": r[2],
            "situation_json": r[3],
            "embedding_bytes": r[4],
            "outcome_label": r[5],
        }
        for r in rows
    ]


def bytes_to_tensor(blob: Optional[bytes], dim: int = 512):
    """Convert raw float32 bytes to a PyTorch tensor."""
    try:
        import torch  # type: ignore
        if blob and len(blob) >= dim * 4:
            arr = struct.unpack(f"{dim}f", blob[:dim * 4])
            return torch.tensor(arr, dtype=torch.float32)
        return torch.zeros(dim)
    except ImportError:
        return None


def generate_teacher_labels(
    situations: List[Dict[str, Any]],
    use_llm: bool = True,
    batch_log_interval: int = 50,
) -> List[Tuple[Dict[str, Any], List[float]]]:
    """
    Generate (situation, teacher_label) pairs.
    Uses LLM where available, heuristic fallback otherwise.
    """
    results = []
    llm_count = 0
    heuristic_count = 0

    for i, sit in enumerate(situations):
        sit_json = sit.get("situation_json", "{}")
        try:
            sit_dict = json.loads(sit_json)
        except Exception:
            sit_dict = {}

        preceding = sit_dict.get("preceding_user_text", "")
        action_type = sit.get("action_type", "other")
        outcome = sit.get("outcome_label", 0.0)

        label = None
        if use_llm:
            label = query_teacher_label(sit_json, preceding)

        if label is None:
            label = heuristic_teacher_label(action_type, outcome)
            heuristic_count += 1
        else:
            llm_count += 1

        results.append((sit, label))

        if (i + 1) % batch_log_interval == 0:
            log.info("Teacher labels: %d/%d (llm=%d, heuristic=%d)",
                     i + 1, len(situations), llm_count, heuristic_count)

    log.info("Teacher labeling done: %d total (llm=%d, heuristic=%d)",
             len(results), llm_count, heuristic_count)
    return results


# ─────────────────────────────────────────────────────────────
# Training
# ─────────────────────────────────────────────────────────────

def pretrain_personality(
    arch_name: str,
    model,
    labeled_data: List[Tuple[Dict[str, Any], List[float]]],
    epochs: int = 10,
    lr: float = 1e-3,
    device: str = "cpu",
) -> Dict[str, float]:
    """
    Pre-train a Personality network via MSE on teacher labels.
    Returns training metrics.
    """
    try:
        import torch
        import torch.nn as nn
        import torch.optim as optim
    except ImportError:
        log.error("PyTorch not available — skipping training for %s", arch_name)
        return {"error": "torch_unavailable"}

    model = model.to(device)
    optimizer = optim.Adam(model.parameters(), lr=lr)
    criterion = nn.MSELoss()

    model.train()
    metrics = {"epochs": epochs, "final_loss": float("inf")}

    for epoch in range(epochs):
        total_loss = 0.0
        count = 0

        for sit, teacher_label in labeled_data:
            embedding_bytes = sit.get("embedding_bytes")
            x = bytes_to_tensor(embedding_bytes, 512)
            if x is None:
                continue
            x = x.unsqueeze(0).to(device)  # [1, 512]

            y = torch.tensor([teacher_label], dtype=torch.float32).to(device)  # [1, 5]

            optimizer.zero_grad()
            pred = model(x)

            # Handle models with sequence input (GRU etc.)
            if pred.dim() == 3:
                pred = pred[:, -1, :]  # last timestep
            if pred.shape[-1] != 5:
                # Assume model outputs gate logits — reshape if needed
                pred = pred[..., :5] if pred.shape[-1] >= 5 else pred

            loss = criterion(pred, y)
            loss.backward()
            optimizer.step()

            total_loss += loss.item()
            count += 1

        avg_loss = total_loss / max(count, 1)
        if (epoch + 1) % max(1, epochs // 5) == 0:
            log.info("[%s] Epoch %d/%d — loss: %.4f", arch_name, epoch + 1, epochs, avg_loss)

        metrics["final_loss"] = avg_loss

    return metrics


def load_personality_architectures():
    """Load all Personality architecture classes from the architectures module."""
    try:
        import sys
        training_dir = Path(__file__).parent
        if str(training_dir) not in sys.path:
            sys.path.insert(0, str(training_dir))

        from architectures.personality import (  # type: ignore
            PersonalityNetA, PersonalityNetB, PersonalityNetC,
            PersonalityNetD, PersonalityNetE,
        )
        return {
            "a": PersonalityNetA,
            "b": PersonalityNetB,
            "c": PersonalityNetC,
            "d": PersonalityNetD,
            "e": PersonalityNetE,
        }
    except ImportError as exc:
        log.warning("Could not import personality architectures: %s", exc)
        return {}


def save_kd_checkpoint(model, arch_key: str, models_dir: Path, metrics: Dict[str, Any]) -> Path:
    """Save KD-initialized weights."""
    try:
        import torch
    except ImportError:
        log.error("PyTorch not available")
        return models_dir

    models_dir.mkdir(parents=True, exist_ok=True)
    out_path = models_dir / f"personality-{arch_key}-kd.pt"
    torch.save({
        "model_state_dict": model.state_dict(),
        "kd_metrics": metrics,
        "architecture": arch_key,
    }, str(out_path))
    log.info("Saved KD checkpoint: %s (loss=%.4f)", out_path, metrics.get("final_loss", -1))
    return out_path


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="AMYGDALA KD Pre-training (Addendum A)")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--models-dir", type=Path, default=MODELS_DIR)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--limit", type=int, default=3000,
                        help="Max situations to use for KD training")
    parser.add_argument("--no-llm", action="store_true")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Load situations from DB
    situations = load_situations(args.db, limit=args.limit)
    if not situations:
        log.error("No situations found — run mine_history.py first")
        sys.exit(1)
    log.info("Loaded %d situations from %s", len(situations), args.db)

    # Generate teacher labels
    labeled_data = generate_teacher_labels(situations, use_llm=not args.no_llm)

    # Load architectures
    arch_classes = load_personality_architectures()
    if not arch_classes:
        log.error("No architecture classes found. Check architectures/personality.py")
        sys.exit(1)

    # Pre-train each architecture
    device = "cpu"
    try:
        import torch
        if torch.cuda.is_available():
            device = "cuda"
            log.info("Using GPU: %s", torch.cuda.get_device_name(0))
    except ImportError:
        log.warning("PyTorch not found — skipping actual training, will save dummy checkpoints")

    all_metrics: Dict[str, Any] = {}

    for key, cls in arch_classes.items():
        log.info("Pre-training Personality-%s via KD...", key.upper())
        try:
            model = cls()
            metrics = pretrain_personality(
                arch_name=f"personality-{key}",
                model=model,
                labeled_data=labeled_data,
                epochs=args.epochs,
                lr=args.lr,
                device=device,
            )
            save_kd_checkpoint(model, key, args.models_dir, metrics)
            all_metrics[key] = metrics
        except Exception as exc:
            log.error("Failed to pre-train personality-%s: %s", key, exc)
            all_metrics[key] = {"error": str(exc)}

    print(json.dumps({
        "situations_used": len(labeled_data),
        "architectures_trained": list(all_metrics.keys()),
        "metrics": all_metrics,
    }, indent=2))


if __name__ == "__main__":
    main()
