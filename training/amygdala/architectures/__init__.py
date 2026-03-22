"""
AMYGDALA Neural Network Architectures
Paper: J11 — Learned Intuition (§5.1–§5.5)

This package provides 10 PyTorch models:
  - 5 Prudence networks (A–E): output gate_probabilities, confidence, ambiguity
  - 5 Personality networks (A–E): output behaviour_embedding (64d)

All architectures are ONNX-exportable (no dynamic control flow).
"""

from .prudence import (
    PrudenceA_GRU_MLP,
    PrudenceB_TCN,
    PrudenceC_Transformer,
    PrudenceD_DualEncoder,
    PrudenceE_EnsembleMLP,
)
from .personality import (
    PersonalityA_GRU_MLP,
    PersonalityB_TCN,
    PersonalityC_Transformer,
    PersonalityD_DualEncoder,
    PersonalityE_EnsembleMLP,
)
from .meta_learner import PrudenceMetaLearner, PersonalityMetaLearner

__all__ = [
    # Prudence
    "PrudenceA_GRU_MLP",
    "PrudenceB_TCN",
    "PrudenceC_Transformer",
    "PrudenceD_DualEncoder",
    "PrudenceE_EnsembleMLP",
    # Personality
    "PersonalityA_GRU_MLP",
    "PersonalityB_TCN",
    "PersonalityC_Transformer",
    "PersonalityD_DualEncoder",
    "PersonalityE_EnsembleMLP",
    # Meta-learners
    "PrudenceMetaLearner",
    "PersonalityMetaLearner",
]
