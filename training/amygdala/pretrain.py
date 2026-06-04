"""
AMYGDALA Supervised Pre-training (P0.5.2)
==========================================
Pre-trains all 10 networks (5 Prudence + 5 Personality) using supervised
learning from the training log and CFD database.

Key design choices (paper §6.1):
  - Prudence loss: asymmetric weighted CrossEntropy
      w_stop=10, w_allow=1, w_escalate=3
  - Personality loss: MSE + λ*target_vector_pull
  - 50 epochs max, early stopping patience=10
  - Hyperparameter search: LR ∈ {1e-3, 3e-4, 1e-4}, dropout ∈ {0.0, 0.1, 0.2}
  - Best checkpoint saved per architecture

Usage:
    python -m training.amygdala.pretrain --db data/amygdala/training.sqlite \
                                         --out output/pretrain/
"""

import argparse
import json
import os
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader

from .architectures import (
    PrudenceA_GRU_MLP, PrudenceB_TCN, PrudenceC_Transformer,
    PrudenceD_DualEncoder, PrudenceE_EnsembleMLP,
    PersonalityA_GRU_MLP, PersonalityB_TCN, PersonalityC_Transformer,
    PersonalityD_DualEncoder, PersonalityE_EnsembleMLP,
)
from .data_loader import get_data_loaders, PERSONALITY_DIM

# ─────────────────────────────────────────────────────────────
# Architecture registries
# ─────────────────────────────────────────────────────────────

PRUDENCE_ARCHS = {
    "a": PrudenceA_GRU_MLP,
    "b": PrudenceB_TCN,
    "c": PrudenceC_Transformer,
    "d": PrudenceD_DualEncoder,
    "e": PrudenceE_EnsembleMLP,
}

PERSONALITY_ARCHS = {
    "a": PersonalityA_GRU_MLP,
    "b": PersonalityB_TCN,
    "c": PersonalityC_Transformer,
    "d": PersonalityD_DualEncoder,
    "e": PersonalityE_EnsembleMLP,
}

# ─────────────────────────────────────────────────────────────
# Asymmetric loss
# ─────────────────────────────────────────────────────────────

# Class weights for Prudence: stop=10, allow=1, escalate=3
# Rationale: FN (missing a danger) is 10× worse than FP (false alarm).
PRUDENCE_CLASS_WEIGHTS = {
    "w_stop":     10.0,
    "w_allow":    1.0,
    "w_escalate": 3.0,
}


def make_prudence_criterion(device: torch.device) -> nn.CrossEntropyLoss:
    """Weighted CE loss with asymmetric class weights (paper §6.2)."""
    weights = torch.tensor(
        [
            PRUDENCE_CLASS_WEIGHTS["w_stop"],     # class 0
            PRUDENCE_CLASS_WEIGHTS["w_allow"],    # class 1
            PRUDENCE_CLASS_WEIGHTS["w_escalate"], # class 2
        ],
        device=device,
        dtype=torch.float,
    )
    # reduction='none' so we can multiply per-sample weights from DataLoader
    return nn.CrossEntropyLoss(weight=weights, reduction="none")


# ─────────────────────────────────────────────────────────────
# Single epoch helpers
# ─────────────────────────────────────────────────────────────

def _train_epoch_prudence(
    model: nn.Module,
    loader: DataLoader,
    optimizer: optim.Optimizer,
    criterion: nn.CrossEntropyLoss,
    device: torch.device,
    grad_clip: float = 0.5,
) -> Dict[str, float]:
    model.train()
    total_loss = 0.0
    correct = 0
    total = 0
    per_class_correct = [0, 0, 0]
    per_class_total   = [0, 0, 0]

    for seq, labels, weights in loader:
        seq     = seq.to(device)      # [B, K, 512]
        labels  = labels.to(device)   # [B]
        weights = weights.to(device)  # [B]

        optimizer.zero_grad()
        out = model(sequence=seq)
        gate = out["gate_probabilities"]  # [B, 3]

        loss_per = criterion(gate, labels)          # [B]
        loss = (loss_per * weights).mean()

        # Auxiliary: confidence should be high when correct
        pred = gate.argmax(dim=-1)
        conf_target = (pred == labels).float().unsqueeze(-1)
        conf_loss = nn.functional.mse_loss(out["confidence"], conf_target)

        total_l = loss + 0.1 * conf_loss
        total_l.backward()
        nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
        optimizer.step()

        total_loss += total_l.item() * seq.size(0)
        correct += (pred == labels).sum().item()
        total += seq.size(0)
        for c in range(3):
            m = labels == c
            per_class_total[c]   += m.sum().item()
            per_class_correct[c] += (pred[m] == c).sum().item()

    def _acc(c: int) -> float:
        return per_class_correct[c] / max(per_class_total[c], 1)

    return {
        "loss":         total_loss / max(total, 1),
        "accuracy":     correct / max(total, 1),
        "acc_stop":     _acc(0),
        "acc_allow":    _acc(1),
        "acc_escalate": _acc(2),
    }


@torch.no_grad()
def _eval_epoch_prudence(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.CrossEntropyLoss,
    device: torch.device,
) -> Dict[str, float]:
    model.eval()
    total_loss = 0.0
    correct = 0
    total = 0
    per_class_correct = [0, 0, 0]
    per_class_total   = [0, 0, 0]

    for seq, labels, weights in loader:
        seq     = seq.to(device)
        labels  = labels.to(device)
        weights = weights.to(device)

        out = model(sequence=seq)
        gate = out["gate_probabilities"]

        loss_per = criterion(gate, labels)
        loss = (loss_per * weights).mean()
        total_loss += loss.item() * seq.size(0)

        pred = gate.argmax(dim=-1)
        correct += (pred == labels).sum().item()
        total += seq.size(0)
        for c in range(3):
            m = labels == c
            per_class_total[c]   += m.sum().item()
            per_class_correct[c] += (pred[m] == c).sum().item()

    def _acc(c: int) -> float:
        return per_class_correct[c] / max(per_class_total[c], 1)

    return {
        "loss":         total_loss / max(total, 1),
        "accuracy":     correct / max(total, 1),
        "acc_stop":     _acc(0),    # CFD recall (stop = dangerous)
        "acc_allow":    _acc(1),
        "acc_escalate": _acc(2),
    }


def _train_epoch_personality(
    model: nn.Module,
    loader: DataLoader,
    optimizer: optim.Optimizer,
    target_vector: torch.Tensor,
    target_lambda: float,
    device: torch.device,
    grad_clip: float = 0.5,
) -> Dict[str, float]:
    model.train()
    total_loss = 0.0
    total = 0

    for seq, target_emb, weights in loader:
        seq        = seq.to(device)
        target_emb = target_emb.to(device)
        weights    = weights.to(device)

        optimizer.zero_grad()
        out = model(sequence=seq)
        pred = out["behaviour_embedding"]  # [B, 64]

        mse  = ((pred - target_emb) ** 2).mean(dim=-1)       # [B]
        pull = ((pred - target_vector.unsqueeze(0)) ** 2).mean(dim=-1)  # [B]
        loss = (weights * (mse + target_lambda * pull)).mean()

        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
        optimizer.step()

        total_loss += loss.item() * seq.size(0)
        total += seq.size(0)

    return {"loss": total_loss / max(total, 1)}


@torch.no_grad()
def _eval_epoch_personality(
    model: nn.Module,
    loader: DataLoader,
    target_vector: torch.Tensor,
    target_lambda: float,
    device: torch.device,
) -> Dict[str, float]:
    model.eval()
    total_loss = 0.0
    total = 0

    for seq, target_emb, weights in loader:
        seq        = seq.to(device)
        target_emb = target_emb.to(device)
        weights    = weights.to(device)

        out = model(sequence=seq)
        pred = out["behaviour_embedding"]
        mse  = ((pred - target_emb) ** 2).mean(dim=-1)
        pull = ((pred - target_vector.unsqueeze(0)) ** 2).mean(dim=-1)
        loss = (weights * (mse + target_lambda * pull)).mean()

        total_loss += loss.item() * seq.size(0)
        total += seq.size(0)

    return {"loss": total_loss / max(total, 1)}


# ─────────────────────────────────────────────────────────────
# Core training functions
# ─────────────────────────────────────────────────────────────

def pretrain_prudence(
    arch_key: str,
    db_path: str,
    output_dir: str,
    lr: float = 3e-4,
    dropout: float = 0.1,
    epochs: int = 50,
    batch_size: int = 64,
    early_stopping_patience: int = 10,
    weight_decay: float = 1e-4,
    kd_weights_path: Optional[str] = None,
    device: Optional[str] = None,
) -> Dict:
    """
    Supervised pre-training for a single Prudence architecture.

    Args:
        arch_key:   "a" | "b" | "c" | "d" | "e"
        db_path:    Path to training SQLite
        output_dir: Directory to save checkpoints + history
        lr:         Learning rate
        dropout:    Dropout probability
        epochs:     Max training epochs
        batch_size: Mini-batch size
        early_stopping_patience: Epochs without val improvement before stopping
        weight_decay: AdamW L2 penalty
        kd_weights_path: Optional KD pre-trained weights to warm-start from
        device:     "cuda" | "cpu" | None (auto-detect)

    Returns:
        dict with keys: best_val_loss, history
    """
    if device is None:
        device_obj = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device_obj = torch.device(device)

    print(f"[pretrain] Prudence-{arch_key.upper()} | lr={lr} dropout={dropout} device={device_obj}")

    # Data
    train_loader, val_loader, _ = get_data_loaders(
        db_path, family="prudence", batch_size=batch_size
    )
    if len(train_loader.dataset) == 0:  # type: ignore[arg-type]
        print(f"  [skip] No training data for Prudence-{arch_key}")
        return {"best_val_loss": float("inf"), "history": []}

    # Model
    model_cls = PRUDENCE_ARCHS[arch_key]
    model = model_cls(dropout=dropout).to(device_obj)

    # Optionally warm-start from KD weights
    if kd_weights_path and Path(kd_weights_path).exists():
        print(f"  Loading KD weights from {kd_weights_path}")
        model.load_state_dict(torch.load(kd_weights_path, map_location=device_obj))

    criterion  = make_prudence_criterion(device_obj)
    optimizer  = optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    scheduler  = optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=5, factor=0.5)

    best_val_loss = float("inf")
    patience_ctr  = 0
    history: List[Dict] = []

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    ckpt_path = output_path / f"prudence_{arch_key}_best.pt"

    for epoch in range(epochs):
        t0 = time.time()
        train_m = _train_epoch_prudence(model, train_loader, optimizer, criterion, device_obj)
        val_m   = _eval_epoch_prudence(model, val_loader, criterion, device_obj)
        scheduler.step(val_m["loss"])

        record = {
            "epoch":         epoch,
            "train_loss":    train_m["loss"],
            "train_acc":     train_m["accuracy"],
            "val_loss":      val_m["loss"],
            "val_acc":       val_m["accuracy"],
            "val_acc_stop":  val_m["acc_stop"],    # CFD recall
            "val_acc_allow": val_m["acc_allow"],
            "val_acc_esc":   val_m["acc_escalate"],
            "lr":            optimizer.param_groups[0]["lr"],
            "secs":          time.time() - t0,
        }
        history.append(record)

        print(
            f"  ep={epoch:02d}  "
            f"train={train_m['loss']:.4f}/{train_m['accuracy']:.3f}  "
            f"val={val_m['loss']:.4f}/{val_m['accuracy']:.3f}  "
            f"stop_recall={val_m['acc_stop']:.3f}"
        )

        if val_m["loss"] < best_val_loss:
            best_val_loss = val_m["loss"]
            patience_ctr  = 0
            torch.save(model.state_dict(), ckpt_path)
        else:
            patience_ctr += 1
            if patience_ctr >= early_stopping_patience:
                print(f"  [early stop] epoch {epoch}")
                break

    with open(output_path / f"prudence_{arch_key}_history.json", "w") as f:
        json.dump(history, f, indent=2)

    print(f"  [done] best_val_loss={best_val_loss:.4f} → {ckpt_path}")
    return {"best_val_loss": best_val_loss, "history": history}


def pretrain_personality(
    arch_key: str,
    db_path: str,
    output_dir: str,
    lr: float = 3e-4,
    dropout: float = 0.1,
    epochs: int = 50,
    batch_size: int = 64,
    early_stopping_patience: int = 10,
    weight_decay: float = 1e-4,
    target_lambda: float = 0.3,
    target_vector: Optional[List[float]] = None,
    kd_weights_path: Optional[str] = None,
    device: Optional[str] = None,
) -> Dict:
    """
    Supervised pre-training for a single Personality architecture.

    Loss: MSE(predicted, observed_embedding) + λ * ||predicted - target_vector||²
    """
    if device is None:
        device_obj = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device_obj = torch.device(device)

    print(f"[pretrain] Personality-{arch_key.upper()} | lr={lr} dropout={dropout} device={device_obj}")

    train_loader, val_loader, _ = get_data_loaders(
        db_path, family="personality", batch_size=batch_size
    )
    if len(train_loader.dataset) == 0:  # type: ignore[arg-type]
        print(f"  [skip] No training data for Personality-{arch_key}")
        return {"best_val_loss": float("inf"), "history": []}

    # Target personality vector (defaults to zeros if not provided)
    if target_vector is not None:
        tv = torch.tensor(target_vector, dtype=torch.float, device=device_obj)
    else:
        tv = torch.zeros(PERSONALITY_DIM, dtype=torch.float, device=device_obj)

    model_cls = PERSONALITY_ARCHS[arch_key]
    model     = model_cls(dropout=dropout).to(device_obj)

    if kd_weights_path and Path(kd_weights_path).exists():
        print(f"  Loading KD weights from {kd_weights_path}")
        model.load_state_dict(torch.load(kd_weights_path, map_location=device_obj))

    optimizer = optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    scheduler = optim.lr_scheduler.ReduceLROnPlateau(optimizer, patience=5, factor=0.5)

    best_val_loss = float("inf")
    patience_ctr  = 0
    history: List[Dict] = []

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    ckpt_path = output_path / f"personality_{arch_key}_best.pt"

    for epoch in range(epochs):
        t0 = time.time()
        train_m = _train_epoch_personality(model, train_loader, optimizer, tv, target_lambda, device_obj)
        val_m   = _eval_epoch_personality(model, val_loader, tv, target_lambda, device_obj)
        scheduler.step(val_m["loss"])

        record = {
            "epoch":      epoch,
            "train_loss": train_m["loss"],
            "val_loss":   val_m["loss"],
            "lr":         optimizer.param_groups[0]["lr"],
            "secs":       time.time() - t0,
        }
        history.append(record)
        print(f"  ep={epoch:02d}  train={train_m['loss']:.4f}  val={val_m['loss']:.4f}")

        if val_m["loss"] < best_val_loss:
            best_val_loss = val_m["loss"]
            patience_ctr  = 0
            torch.save(model.state_dict(), ckpt_path)
        else:
            patience_ctr += 1
            if patience_ctr >= early_stopping_patience:
                print(f"  [early stop] epoch {epoch}")
                break

    with open(output_path / f"personality_{arch_key}_history.json", "w") as f:
        json.dump(history, f, indent=2)

    print(f"  [done] best_val_loss={best_val_loss:.4f} → {ckpt_path}")
    return {"best_val_loss": best_val_loss, "history": history}


# ─────────────────────────────────────────────────────────────
# Hyperparameter search
# ─────────────────────────────────────────────────────────────

HP_LR_OPTIONS      = (1e-3, 3e-4, 1e-4)
HP_DROPOUT_OPTIONS = (0.0, 0.1, 0.2)


def hp_search_prudence(
    arch_key: str,
    db_path: str,
    output_dir: str,
    device: Optional[str] = None,
) -> Dict:
    """
    Grid search over (LR × dropout) for a Prudence architecture.
    Runs 3×3=9 configurations, picks the one with lowest val_loss.
    """
    best_cfg  = None
    best_loss = float("inf")
    results   = []

    for lr in HP_LR_OPTIONS:
        for dropout in HP_DROPOUT_OPTIONS:
            r = pretrain_prudence(
                arch_key, db_path,
                output_dir=str(Path(output_dir) / f"hp_p{arch_key}_lr{lr}_dr{dropout}"),
                lr=lr, dropout=dropout, epochs=20, device=device,
            )
            results.append({"lr": lr, "dropout": dropout, **r})
            if r["best_val_loss"] < best_loss:
                best_loss = r["best_val_loss"]
                best_cfg  = {"lr": lr, "dropout": dropout}

    print(f"[hp_search] Prudence-{arch_key.upper()} best: {best_cfg} loss={best_loss:.4f}")
    return {"best_config": best_cfg, "best_val_loss": best_loss, "all": results}


def hp_search_personality(
    arch_key: str,
    db_path: str,
    output_dir: str,
    device: Optional[str] = None,
) -> Dict:
    """Grid search (LR × dropout) for a Personality architecture."""
    best_cfg  = None
    best_loss = float("inf")
    results   = []

    for lr in HP_LR_OPTIONS:
        for dropout in HP_DROPOUT_OPTIONS:
            r = pretrain_personality(
                arch_key, db_path,
                output_dir=str(Path(output_dir) / f"hp_i{arch_key}_lr{lr}_dr{dropout}"),
                lr=lr, dropout=dropout, epochs=20, device=device,
            )
            results.append({"lr": lr, "dropout": dropout, **r})
            if r["best_val_loss"] < best_loss:
                best_loss = r["best_val_loss"]
                best_cfg  = {"lr": lr, "dropout": dropout}

    print(f"[hp_search] Personality-{arch_key.upper()} best: {best_cfg} loss={best_loss:.4f}")
    return {"best_config": best_cfg, "best_val_loss": best_loss, "all": results}


# ─────────────────────────────────────────────────────────────
# Train all 10 networks
# ─────────────────────────────────────────────────────────────

def pretrain_all(
    db_path: str,
    output_dir: str,
    device: Optional[str] = None,
    run_hp_search: bool = False,
    target_vector: Optional[List[float]] = None,
) -> Dict[str, Dict]:
    """
    Pre-train all 10 networks and save a summary.

    Args:
        db_path:       Path to training.sqlite
        output_dir:    Directory for checkpoints and history files
        device:        "cuda" | "cpu" | None
        run_hp_search: If True, run hyperparameter search first

    Returns:
        dict mapping "prudence_a" … "personality_e" → metrics
    """
    results = {}

    for key in "abcde":
        if run_hp_search:
            hp_r = hp_search_prudence(key, db_path, output_dir, device)
            cfg  = hp_r["best_config"] or {"lr": 3e-4, "dropout": 0.1}
        else:
            cfg = {"lr": 3e-4, "dropout": 0.1}

        # KD warm-start if available
        kd_p = str(Path(output_dir) / f"personality_{key}_kd.pt")
        results[f"prudence_{key}"] = pretrain_prudence(
            key, db_path, output_dir, device=device, **cfg
        )
        results[f"personality_{key}"] = pretrain_personality(
            key, db_path, output_dir,
            kd_weights_path=kd_p if Path(kd_p).exists() else None,
            target_vector=target_vector,
            device=device, **cfg,
        )

    # Summary
    print("\n=== Pre-training Summary ===")
    for name, r in results.items():
        print(f"  {name}: best_val_loss={r['best_val_loss']:.4f}")

    summary_path = Path(output_dir) / "pretrain_summary.json"
    with open(summary_path, "w") as f:
        json.dump(
            {k: {"best_val_loss": v["best_val_loss"]} for k, v in results.items()},
            f, indent=2,
        )
    print(f"Summary → {summary_path}")
    return results


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AMYGDALA pre-training")
    parser.add_argument("--db",  required=True, help="Path to training.sqlite")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument("--device", default=None)
    parser.add_argument("--hp-search", action="store_true")
    parser.add_argument(
        "--target-vector",
        default=None,
        help="Path to a JSON file holding the 64-d personality target vector "
        "(must match the runtime decoder's generateTargetVector). Without it, "
        "personality nets train toward ZEROS — the degenerate all-nudges-fire state.",
    )
    args = parser.parse_args()

    target_vector = None
    if args.target_vector:
        with open(args.target_vector) as f:
            target_vector = json.load(f)
        print(f"[pretrain] target vector: {len(target_vector)}-d from {args.target_vector}")

    pretrain_all(args.db, args.out, args.device, args.hp_search, target_vector=target_vector)
