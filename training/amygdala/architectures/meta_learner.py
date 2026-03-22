"""
AMYGDALA Meta-Learner: Linear combination of 5 architecture outputs.
Paper: J11 — Learned Intuition, §5.5, P0.5.5

The meta-learner combines outputs from the 5 Prudence (or Personality)
architectures using learned scalar weights. Weights are updated monthly
based on per-architecture accuracy on the held-out CFD benchmark (paper §9.3).

Two meta-learners:
  PrudenceMetaLearner  — combines gate_probabilities, confidence, ambiguity
  PersonalityMetaLearner — combines behaviour_embedding vectors

Both are ONNX-exportable.
"""

import torch
import torch.nn as nn
from typing import List


class PrudenceMetaLearner(nn.Module):
    """
    Weighted combination of 5 Prudence architecture outputs.

    Inputs (concatenated along last dim):
      gate_probs_all:  [batch, 5, 3] — gate probabilities from each arch
      confidence_all:  [batch, 5]    — confidence from each arch
      ambiguity_all:   [batch, 5]    — ambiguity from each arch

    Or alternatively, can be called with pre-stacked tensors from outside.

    Weights are learned (not fixed). They start uniform (0.2 each) and are
    updated by the nightly training cycle using per-arch CFD benchmark accuracy.

    Output:
      gate_probabilities: [batch, 3]
      confidence:         [batch, 1]
      ambiguity:          [batch, 1]
    """

    def __init__(self, n_archs: int = 5):
        super().__init__()
        # Learned weights — initialized uniform, updated via gradient or
        # direct weight update from nightly meta-learner script.
        self.log_weights = nn.Parameter(torch.zeros(n_archs))

    @property
    def weights(self) -> torch.Tensor:
        """Normalized weights via softmax (always sum to 1, always positive)."""
        return torch.softmax(self.log_weights, dim=0)

    def forward(
        self,
        gate_probs_all: torch.Tensor,   # [batch, 5, 3]
        confidence_all: torch.Tensor,   # [batch, 5, 1] or [batch, 5]
        ambiguity_all: torch.Tensor,    # [batch, 5, 1] or [batch, 5]
    ) -> dict:
        """
        Combine 5 architecture outputs into a single ensemble prediction.

        Args:
            gate_probs_all: [batch, 5, 3]
            confidence_all: [batch, 5, 1] or [batch, 5]
            ambiguity_all:  [batch, 5, 1] or [batch, 5]
        """
        w = self.weights  # [5] — sums to 1

        # Weighted mean over architectures
        # gate_probs_all: [batch, 5, 3] → [batch, 3]
        gate = (gate_probs_all * w.unsqueeze(0).unsqueeze(-1)).sum(dim=1)

        # Handle both [batch, 5] and [batch, 5, 1]
        conf = confidence_all
        amb = ambiguity_all
        if conf.dim() == 3:
            conf = conf.squeeze(-1)  # [batch, 5]
        if amb.dim() == 3:
            amb = amb.squeeze(-1)    # [batch, 5]

        conf_out = (conf * w.unsqueeze(0)).sum(dim=1, keepdim=True)   # [batch, 1]
        amb_out = (amb * w.unsqueeze(0)).sum(dim=1, keepdim=True)     # [batch, 1]

        return {
            "gate_probabilities": gate,
            "confidence": conf_out,
            "ambiguity": amb_out,
        }

    def set_weights(self, weights: List[float]) -> None:
        """
        Update meta-learner weights directly (from nightly training script).

        Args:
            weights: List of 5 floats (need not sum to 1 — softmax is applied)
        """
        with torch.no_grad():
            w = torch.tensor(weights, dtype=torch.float32)
            # Store as log-weights so softmax gives the desired distribution
            # Approximate: set log_weights proportional to weights
            self.log_weights.copy_(torch.log(w.clamp(min=1e-6)))


class PersonalityMetaLearner(nn.Module):
    """
    Weighted combination of 5 Personality architecture behaviour embeddings.

    Input:
      embeddings_all: [batch, 5, 64] — behaviour embedding from each arch

    Output:
      behaviour_embedding: [batch, 64]
    """

    def __init__(self, n_archs: int = 5):
        super().__init__()
        self.log_weights = nn.Parameter(torch.zeros(n_archs))

    @property
    def weights(self) -> torch.Tensor:
        return torch.softmax(self.log_weights, dim=0)

    def forward(self, embeddings_all: torch.Tensor) -> dict:
        """
        Args:
            embeddings_all: [batch, 5, 64]
        Returns:
            dict with key 'behaviour_embedding': [batch, 64]
        """
        w = self.weights  # [5]
        combined = (embeddings_all * w.unsqueeze(0).unsqueeze(-1)).sum(dim=1)  # [batch, 64]
        return {"behaviour_embedding": combined}

    def set_weights(self, weights: List[float]) -> None:
        with torch.no_grad():
            w = torch.tensor(weights, dtype=torch.float32)
            self.log_weights.copy_(torch.log(w.clamp(min=1e-6)))
