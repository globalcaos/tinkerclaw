"""
AMYGDALA Training Data Pipeline (P0.5.2)
========================================
Loads (situation_embedding, label) pairs from SQLite (CFD and training log).
Provides chronological train/val/test split (80/10/10), oversampling of
rare/critical examples, batch collation for temporal sequences, and
configurable DataLoader.

Usage:
    from training.amygdala.data_loader import get_data_loaders
    train_dl, val_dl, test_dl = get_data_loaders(db_path, family='prudence')
"""

import sqlite3
import json
import math
import struct
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any

import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler


# ─────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────

WINDOW_SIZE = 32       # K — temporal window
EMBEDDING_DIM = 512    # Internal embedding dimension
PERSONALITY_DIM = 64   # Behaviour embedding output dimension

# Outcome → Prudence label: 0=stop, 1=allow, 2=escalate
OUTCOME_TO_PRUDENCE = {
    "severe_negative":   0,  # stop
    "moderate_negative": 0,  # stop
    "mild_negative":     2,  # escalate
    "positive":          1,  # allow
}

# Oversampling multipliers (per plan requirements)
OVERSAMPLE = {
    "catastrophic":         5,   # severe_negative (CFD, catastrophic corrections)
    "confirmed_block":      3,   # user-confirmed soft/hard blocks with positive outcome
    "overridden_block":     2,   # user overrode AMYGDALA block (disagreement signal)
}


# ─────────────────────────────────────────────────────────────
# Raw row loader
# ─────────────────────────────────────────────────────────────

def _load_rows(db_path: str) -> List[Dict[str, Any]]:
    """
    Load all labeled evaluation rows from both SQLite databases,
    ordered chronologically.

    Pulls from:
      - amygdala_evaluations (main training log)
      - cfd_entries (Catastrophic Failure Database) if present
    """
    rows: List[Dict[str, Any]] = []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")

    # Main training log
    cursor = conn.execute("""
        SELECT
            id,
            timestamp,
            embedding,
            situation_json,
            outcome,
            outcome_weight,
            outcome_source,
            personality_combined,
            user_override,
            gate_decision
        FROM amygdala_evaluations
        WHERE outcome IS NOT NULL
        ORDER BY timestamp ASC
    """)
    for r in cursor:
        rows.append(dict(r))

    # CFD entries (if table exists)
    try:
        cursor = conn.execute("""
            SELECT
                id,
                date_occurred    AS timestamp,
                situation_embedding AS embedding,
                situation_template  AS situation_json,
                'severe_negative'   AS outcome,
                1.0                 AS outcome_weight,
                'cfd'               AS outcome_source,
                NULL                AS personality_combined,
                0                   AS user_override,
                'hard_block'        AS gate_decision
            FROM cfd_entries
            WHERE situation_embedding IS NOT NULL
            ORDER BY date_occurred ASC
        """)
        for r in cursor:
            row = dict(r)
            row["_from_cfd"] = True
            rows.append(row)
    except sqlite3.OperationalError:
        # CFD table not in this database — skip
        pass

    conn.close()
    return rows


# ─────────────────────────────────────────────────────────────
# Embedding decoder
# ─────────────────────────────────────────────────────────────

def _decode_embedding(blob: Optional[bytes], dim: int) -> np.ndarray:
    """Decode a float32 BLOB into a numpy array. Returns zeros on failure."""
    if blob is None:
        return np.zeros(dim, dtype=np.float32)
    try:
        arr = np.frombuffer(blob, dtype=np.float32)
        if arr.shape[0] != dim:
            return np.zeros(dim, dtype=np.float32)
        return arr.copy()
    except Exception:
        return np.zeros(dim, dtype=np.float32)


# ─────────────────────────────────────────────────────────────
# Dataset
# ─────────────────────────────────────────────────────────────

class AmygdalaDataset(Dataset):
    """
    PyTorch Dataset for AMYGDALA training.

    Each sample is:
      - seq: FloatTensor [K=32, 512] — padded temporal window of embeddings
      - label: LongTensor scalar (Prudence) or FloatTensor [64] (Personality)
      - weight: FloatTensor scalar — sample importance weight

    The dataset also exposes ``sample_weights`` (List[float]) for use with
    WeightedRandomSampler to implement oversampling.
    """

    def __init__(
        self,
        rows: List[Dict[str, Any]],
        family: str = "prudence",    # "prudence" | "personality"
        window_size: int = WINDOW_SIZE,
        embedding_dim: int = EMBEDDING_DIM,
        personality_dim: int = PERSONALITY_DIM,
    ):
        self.family = family
        self.window_size = window_size
        self.embedding_dim = embedding_dim
        self.personality_dim = personality_dim

        # Decode all embeddings first
        embeddings: List[np.ndarray] = []
        for row in rows:
            embeddings.append(_decode_embedding(row["embedding"], embedding_dim))

        # Build (windowed_sequence, label, weight) samples
        self._samples: List[Tuple[np.ndarray, Any, float]] = []
        self.sample_weights: List[float] = []

        for i, row in enumerate(rows):
            outcome = row.get("outcome", "positive")
            base_weight = float(row.get("outcome_weight") or 1.0)
            user_override = bool(row.get("user_override", False))
            outcome_source = row.get("outcome_source", "")
            gate_decision = row.get("gate_decision", "allow")
            from_cfd = row.get("_from_cfd", False)

            # ── Build padded window [K, 512] ──
            start = max(0, i - window_size + 1)
            window = embeddings[start : i + 1]  # variable length
            # Left-pad with zeros for sequences shorter than K
            n_pad = window_size - len(window)
            if n_pad > 0:
                pad = [np.zeros(embedding_dim, dtype=np.float32)] * n_pad
                window = pad + window
            seq = np.stack(window, axis=0)  # [K, 512]

            # ── Prudence label ──
            if family == "prudence":
                label = OUTCOME_TO_PRUDENCE.get(outcome, 1)
            else:
                # Personality label: the saved personality embedding for this row
                label = _decode_embedding(row.get("personality_combined"), personality_dim)

            # ── Sample weight (oversampling) ──
            w = base_weight

            if from_cfd or outcome == "severe_negative":
                # CFD entries and catastrophic corrections → 5×
                w *= OVERSAMPLE["catastrophic"]
            elif outcome == "moderate_negative":
                w *= 2.0

            if user_override and gate_decision != "allow":
                # User overrode a block → disagreement signal → 2×
                w *= OVERSAMPLE["overridden_block"]

            if (gate_decision in ("soft_block", "hard_block")
                    and outcome == "positive"
                    and not user_override
                    and outcome_source in ("explicit_positive", "no_complaint_72h")):
                # Block that user confirmed was correct → 3×
                w *= OVERSAMPLE["confirmed_block"]

            self._samples.append((seq, label, w))
            self.sample_weights.append(w)

    def __len__(self) -> int:
        return len(self._samples)

    def __getitem__(self, idx: int):
        seq, label, weight = self._samples[idx]
        seq_t = torch.from_numpy(seq).float()  # [K, 512]

        if self.family == "prudence":
            label_t = torch.tensor(label, dtype=torch.long)
        else:
            label_t = torch.from_numpy(label).float()  # [64]

        weight_t = torch.tensor(weight, dtype=torch.float)
        return seq_t, label_t, weight_t


# ─────────────────────────────────────────────────────────────
# Collation
# ─────────────────────────────────────────────────────────────

def collate_fn(batch):
    """
    Batch collation for variable-length temporal sequences.

    All sequences are already padded to K=32 during __getitem__, so this
    is a standard stack. The collator is kept explicit for clarity and to
    allow future extension (e.g., masking).

    Returns:
        seqs:    FloatTensor [B, K, 512]
        labels:  LongTensor [B] (Prudence) or FloatTensor [B, 64] (Personality)
        weights: FloatTensor [B]
    """
    seqs, labels, weights = zip(*batch)
    seqs_t = torch.stack(seqs, dim=0)       # [B, K, 512]
    labels_t = torch.stack(labels, dim=0)   # [B] or [B, 64]
    weights_t = torch.stack(weights, dim=0) # [B]
    return seqs_t, labels_t, weights_t


# ─────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────

def get_data_loaders(
    db_path: str,
    family: str = "prudence",
    train_split: float = 0.80,
    val_split: float = 0.10,
    batch_size: int = 64,
    num_workers: int = 0,
    window_size: int = WINDOW_SIZE,
    embedding_dim: int = EMBEDDING_DIM,
    use_weighted_sampler: bool = True,
    seed: int = 42,
) -> Tuple[DataLoader, DataLoader, DataLoader]:
    """
    Build chronological train/val/test DataLoaders from SQLite.

    Split order:  first 80% → train, next 10% → val, last 10% → test.
    IMPORTANT: The split is CHRONOLOGICAL (no shuffle before split) to
    prevent temporal leakage.

    Args:
        db_path:              Path to training.sqlite (and/or cfd.sqlite)
        family:               "prudence" or "personality"
        train_split:          Fraction for training (default 0.80)
        val_split:            Fraction for validation (default 0.10)
        batch_size:           Samples per batch
        num_workers:          DataLoader workers (0 = main process)
        window_size:          Temporal window K (default 32)
        embedding_dim:        Embedding dimension (default 512)
        use_weighted_sampler: Use WeightedRandomSampler for training

    Returns:
        (train_loader, val_loader, test_loader)
    """
    rows = _load_rows(db_path)
    if not rows:
        raise ValueError(f"No labeled data found in {db_path}")

    n = len(rows)
    train_end = int(n * train_split)
    val_end = train_end + int(n * val_split)

    train_rows = rows[:train_end]
    val_rows   = rows[train_end:val_end]
    test_rows  = rows[val_end:]

    train_ds = AmygdalaDataset(train_rows, family, window_size, embedding_dim)
    val_ds   = AmygdalaDataset(val_rows,   family, window_size, embedding_dim)
    test_ds  = AmygdalaDataset(test_rows,  family, window_size, embedding_dim)

    # Training: use WeightedRandomSampler to implement oversampling
    if use_weighted_sampler and len(train_ds) > 0:
        sampler = WeightedRandomSampler(
            weights=train_ds.sample_weights,
            num_samples=len(train_ds),
            replacement=True,
            generator=torch.Generator().manual_seed(seed),
        )
        train_loader = DataLoader(
            train_ds,
            batch_size=batch_size,
            sampler=sampler,
            collate_fn=collate_fn,
            num_workers=num_workers,
            pin_memory=torch.cuda.is_available(),
        )
    else:
        train_loader = DataLoader(
            train_ds,
            batch_size=batch_size,
            shuffle=True,
            collate_fn=collate_fn,
            num_workers=num_workers,
        )

    val_loader = DataLoader(
        val_ds,
        batch_size=batch_size,
        shuffle=False,
        collate_fn=collate_fn,
        num_workers=num_workers,
    )
    test_loader = DataLoader(
        test_ds,
        batch_size=batch_size,
        shuffle=False,
        collate_fn=collate_fn,
        num_workers=num_workers,
    )

    print(
        f"[data_loader] {family}: "
        f"train={len(train_ds)} val={len(val_ds)} test={len(test_ds)} "
        f"(total={n})"
    )
    return train_loader, val_loader, test_loader
