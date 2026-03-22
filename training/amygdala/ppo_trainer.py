"""
AMYGDALA PPO Online RL Trainer (P0.5.2)
=========================================
Online reinforcement learning for Prudence networks using Proximal Policy
Optimization (PPO) with Generalized Advantage Estimation (GAE).

State:   situation embedding sequence [K=32, 512]
Action:  gate decision ∈ {0=stop, 1=allow, 2=escalate}
Reward:  scalar derived from deployment outcomes (see reward labeling in nightly.py)

PPO hyper-parameters:
  clip_ratio  = 0.2   (ε in the PPO clipped objective)
  gamma       = 0.99  (discount factor)
  gae_lambda  = 0.95  (GAE smoothing)
  value_coeff = 0.5
  entropy_coeff = 0.01
  max_grad_norm = 0.5

Replay buffer:
  Rolling 90-day window.
  Loaded from training.sqlite (outcome IS NOT NULL, within window).

Nightly update:
  1-3 PPO epochs on the day's new experiences.

Usage (called from nightly.py):
    from training.amygdala.ppo_trainer import build_ppo_buffer_from_db, ppo_update

    buffer = build_ppo_buffer_from_db(db_path, model, device)
    metrics = ppo_update(model, buffer, device=device)
"""

import sqlite3
import json
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

# ─────────────────────────────────────────────────────────────
# Reward table (paper §9.2)
# ─────────────────────────────────────────────────────────────

REWARD_TABLE = {
    "severe_negative":   -1.0,    # Catastrophic correction / file restoration
    "moderate_negative": -0.7,    # Explicit user correction
    "mild_negative":     -0.3,    # Minor complaint / re-work
    "positive":           0.5,    # No complaint within 72h
    # Special cases handled in build_ppo_buffer_from_db:
    # user_override + positive → +0.6 (block was correct, user agrees)
    # explicit_positive        → +0.8
}

# Outcome → action index the policy took (retrospective reconstruction)
OUTCOME_TO_ACTION = {
    "severe_negative":   1,  # allow (AMYGDALA should have said stop)
    "moderate_negative": 1,
    "mild_negative":     2,  # escalate would have been better
    "positive":          1,  # allow was correct
}

WINDOW_SIZE    = 32
EMBEDDING_DIM  = 512

# ─────────────────────────────────────────────────────────────
# GAE / Replay Buffer
# ─────────────────────────────────────────────────────────────

class PPOBuffer:
    """
    Rollout buffer: stores transitions from the 90-day rolling window.

    Each transition:
      state:    FloatTensor [K, 512] — embedding sequence
      action:   int — gate decision taken (reconstructed from gate_decision col)
      reward:   float — derived from outcome
      log_prob: float — log π(action|state) at decision time (or 0 if unavailable)
      value:    float — V(state) estimate (or 0 if unavailable)
    """

    def __init__(self):
        self.states:    List[torch.Tensor] = []
        self.actions:   List[int]          = []
        self.rewards:   List[float]        = []
        self.log_probs: List[float]        = []
        self.values:    List[float]        = []

    def add(
        self,
        state: torch.Tensor,
        action: int,
        reward: float,
        log_prob: float = 0.0,
        value: float = 0.0,
    ) -> None:
        self.states.append(state)
        self.actions.append(action)
        self.rewards.append(reward)
        self.log_probs.append(log_prob)
        self.values.append(value)

    def __len__(self) -> int:
        return len(self.states)

    def clear(self) -> None:
        self.states.clear()
        self.actions.clear()
        self.rewards.clear()
        self.log_probs.clear()
        self.values.clear()

    def compute_advantages(
        self,
        gamma: float = 0.99,
        gae_lambda: float = 0.95,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Generalized Advantage Estimation.

        A_t = Σ_{k=0}^{T-t} (γλ)^k δ_{t+k}
        δ_t = r_t + γ V_{t+1} - V_t

        Returns (advantages, returns) both as numpy arrays of shape [N].
        """
        n = len(self.rewards)
        advantages = np.zeros(n, dtype=np.float32)
        returns    = np.zeros(n, dtype=np.float32)
        last_gae   = 0.0

        for t in reversed(range(n)):
            next_val  = self.values[t + 1] if t < n - 1 else 0.0
            delta     = self.rewards[t] + gamma * next_val - self.values[t]
            last_gae  = delta + gamma * gae_lambda * last_gae
            advantages[t] = last_gae
            returns[t]    = advantages[t] + self.values[t]

        return advantages, returns


# ─────────────────────────────────────────────────────────────
# Build buffer from SQLite
# ─────────────────────────────────────────────────────────────

def build_ppo_buffer_from_db(
    db_path: str,
    model: nn.Module,
    device: torch.device,
    window_days: int = 90,
    max_samples: int = 10_000,
) -> PPOBuffer:
    """
    Populate a PPOBuffer from the rolling 90-day training window.

    For each row with a non-null outcome:
      1. Decode the embedding sequence (K=32 embeddings)
      2. Reconstruct the action from gate_decision
      3. Compute the reward from outcome
      4. Estimate log_prob and value via a forward pass on the current model

    Args:
        db_path:     Path to training.sqlite
        model:       Current Prudence network (for log_prob / value estimation)
        device:      Compute device
        window_days: Rolling window size
        max_samples: Cap to prevent OOM on large DBs

    Returns:
        Populated PPOBuffer
    """
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")

    cutoff = (datetime.now() - timedelta(days=window_days)).isoformat()

    rows = conn.execute("""
        SELECT
            timestamp,
            embedding,
            outcome,
            outcome_source,
            outcome_weight,
            gate_decision,
            user_override
        FROM amygdala_evaluations
        WHERE outcome IS NOT NULL
          AND datetime(timestamp) >= datetime(?)
        ORDER BY timestamp ASC
        LIMIT ?
    """, (cutoff, max_samples)).fetchall()
    conn.close()

    if not rows:
        return PPOBuffer()

    # Decode all embeddings and build windowed sequences (same logic as data_loader)
    raw_embeddings: List[np.ndarray] = []
    for row in rows:
        blob = row[1]
        if blob:
            try:
                arr = np.frombuffer(blob, dtype=np.float32)
                raw_embeddings.append(arr.copy() if arr.shape[0] == EMBEDDING_DIM else np.zeros(EMBEDDING_DIM, dtype=np.float32))
            except Exception:
                raw_embeddings.append(np.zeros(EMBEDDING_DIM, dtype=np.float32))
        else:
            raw_embeddings.append(np.zeros(EMBEDDING_DIM, dtype=np.float32))

    buffer = PPOBuffer()
    model.eval()

    with torch.no_grad():
        for i, row in enumerate(rows):
            _, _, outcome, outcome_src, outcome_weight, gate_decision, user_override = row

            # ── Action reconstruction ──
            action_map = {"allow": 1, "soft_block": 0, "hard_block": 0}
            action = action_map.get(gate_decision or "allow", 1)

            # ── Reward ──
            reward = REWARD_TABLE.get(outcome or "positive", 0.5)
            if outcome_src == "explicit_positive":
                reward = 0.8
            if user_override and gate_decision in ("soft_block", "hard_block") and outcome == "positive":
                # User confirmed block was correct
                reward = 0.6
            reward *= float(outcome_weight or 1.0)

            # ── Windowed sequence ──
            start = max(0, i - WINDOW_SIZE + 1)
            window = raw_embeddings[start : i + 1]
            n_pad = WINDOW_SIZE - len(window)
            if n_pad > 0:
                window = [np.zeros(EMBEDDING_DIM, dtype=np.float32)] * n_pad + window
            seq = np.stack(window, axis=0)  # [K, 512]
            seq_t = torch.from_numpy(seq).float().unsqueeze(0).to(device)  # [1, K, 512]

            # ── Forward pass for log_prob and value ──
            out = model(sequence=seq_t)
            gate_probs = out["gate_probabilities"]  # [1, 3]
            confidence = out["confidence"]           # [1, 1]

            dist     = torch.distributions.Categorical(probs=gate_probs)
            log_prob = dist.log_prob(torch.tensor([action], device=device)).item()
            value    = confidence.squeeze().item()

            buffer.add(
                state    = seq_t.squeeze(0).cpu(),  # [K, 512]
                action   = action,
                reward   = reward,
                log_prob = log_prob,
                value    = value,
            )

    print(f"[ppo_buffer] loaded {len(buffer)} transitions from {window_days}-day window")
    return buffer


# ─────────────────────────────────────────────────────────────
# PPO update step
# ─────────────────────────────────────────────────────────────

def ppo_update(
    model: nn.Module,
    buffer: PPOBuffer,
    device: torch.device,
    lr: float = 1e-4,
    n_epochs: int = 3,           # 1-3 epochs per nightly update
    batch_size: int = 32,
    clip_ratio: float = 0.2,
    gamma: float = 0.99,
    gae_lambda: float = 0.95,
    value_coeff: float = 0.5,
    entropy_coeff: float = 0.01,
    max_grad_norm: float = 0.5,
    weight_decay: float = 1e-4,
) -> Dict[str, float]:
    """
    PPO update on the current buffer.

    Clipped objective:
        L^CLIP = E[ min(r_t A_t, clip(r_t, 1-ε, 1+ε) A_t) ]

    where:
        r_t = π_θ(a_t|s_t) / π_θ_old(a_t|s_t)

    Args:
        model:         Prudence network to update (in-place)
        buffer:        Populated PPOBuffer
        device:        Compute device
        lr:            Adam learning rate
        n_epochs:      Number of PPO mini-batch epochs
        batch_size:    Mini-batch size
        clip_ratio:    PPO clip parameter ε
        gamma:         Discount factor
        gae_lambda:    GAE smoothing parameter λ
        value_coeff:   Weight for value function loss
        entropy_coeff: Entropy bonus coefficient
        max_grad_norm: Gradient clipping norm
        weight_decay:  AdamW weight decay

    Returns:
        dict with training metrics averaged over all updates
    """
    if len(buffer) == 0:
        return {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0, "approx_kl": 0.0}

    advantages, returns = buffer.compute_advantages(gamma, gae_lambda)

    # Normalize advantages
    advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)

    # Tensors
    states_t    = torch.stack(buffer.states).to(device)          # [N, K, 512]
    actions_t   = torch.tensor(buffer.actions, dtype=torch.long, device=device)   # [N]
    old_lp_t    = torch.tensor(buffer.log_probs, dtype=torch.float, device=device) # [N]
    adv_t       = torch.tensor(advantages, dtype=torch.float, device=device)       # [N]
    returns_t   = torch.tensor(returns, dtype=torch.float, device=device)          # [N]

    optimizer = optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    n = len(buffer)

    metrics: Dict[str, float] = {
        "policy_loss": 0.0,
        "value_loss":  0.0,
        "entropy":     0.0,
        "approx_kl":   0.0,
    }
    n_updates = 0

    model.train()
    for _epoch in range(n_epochs):
        perm = torch.randperm(n, device=device)
        for start in range(0, n, batch_size):
            idx = perm[start : start + batch_size]

            b_states   = states_t[idx]       # [B, K, 512]
            b_actions  = actions_t[idx]      # [B]
            b_old_lp   = old_lp_t[idx]       # [B]
            b_adv      = adv_t[idx]          # [B]
            b_returns  = returns_t[idx]      # [B]

            out       = model(sequence=b_states)
            gate      = out["gate_probabilities"]    # [B, 3]
            values    = out["confidence"].squeeze(-1) # [B]

            dist     = torch.distributions.Categorical(probs=gate)
            new_lp   = dist.log_prob(b_actions)      # [B]
            entropy  = dist.entropy().mean()

            # PPO clipped objective
            ratio   = torch.exp(new_lp - b_old_lp)
            surr1   = ratio * b_adv
            surr2   = torch.clamp(ratio, 1 - clip_ratio, 1 + clip_ratio) * b_adv
            policy_loss = -torch.min(surr1, surr2).mean()

            # Value loss
            value_loss = nn.functional.mse_loss(values, b_returns)

            loss = policy_loss + value_coeff * value_loss - entropy_coeff * entropy

            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
            optimizer.step()

            with torch.no_grad():
                approx_kl = (b_old_lp - new_lp).mean().abs().item()

            metrics["policy_loss"] += policy_loss.item()
            metrics["value_loss"]  += value_loss.item()
            metrics["entropy"]     += entropy.item()
            metrics["approx_kl"]   += approx_kl
            n_updates += 1

    if n_updates > 0:
        for k in metrics:
            metrics[k] /= n_updates

    print(
        f"[ppo_update] policy={metrics['policy_loss']:.4f} "
        f"value={metrics['value_loss']:.4f} "
        f"entropy={metrics['entropy']:.4f} "
        f"kl={metrics['approx_kl']:.4f}"
    )
    return metrics


# ─────────────────────────────────────────────────────────────
# Convenience: update all Prudence networks
# ─────────────────────────────────────────────────────────────

def ppo_update_all(
    db_path: str,
    weights_dir: str,
    device_str: Optional[str] = None,
    n_epochs: int = 3,
) -> Dict[str, Dict]:
    """
    Load each Prudence network, build its PPO buffer, run update, save weights.

    Called from nightly.py after reward labeling completes.
    """
    from .architectures import (
        PrudenceA_GRU_MLP, PrudenceB_TCN, PrudenceC_Transformer,
        PrudenceD_DualEncoder, PrudenceE_EnsembleMLP,
    )
    archs = {
        "a": PrudenceA_GRU_MLP,
        "b": PrudenceB_TCN,
        "c": PrudenceC_Transformer,
        "d": PrudenceD_DualEncoder,
        "e": PrudenceE_EnsembleMLP,
    }

    device = torch.device(device_str or ("cuda" if torch.cuda.is_available() else "cpu"))
    results = {}

    for key, cls in archs.items():
        ckpt = f"{weights_dir}/prudence_{key}_best.pt"
        if not __import__("pathlib").Path(ckpt).exists():
            print(f"[ppo_update_all] No checkpoint for Prudence-{key.upper()}, skipping")
            continue

        model = cls().to(device)
        model.load_state_dict(torch.load(ckpt, map_location=device))

        buffer = build_ppo_buffer_from_db(db_path, model, device)
        metrics = ppo_update(model, buffer, device, n_epochs=n_epochs)

        torch.save(model.state_dict(), ckpt)
        results[f"prudence_{key}"] = metrics
        print(f"  Prudence-{key.upper()} updated and saved → {ckpt}")

    return results
