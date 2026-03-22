"""
Unit tests for all 10 AMYGDALA network architectures.
Paper: J11 — Learned Intuition, §5.1–§5.5

Tests:
  1. Forward pass with random input for all 10 networks
  2. Output shapes match spec
  3. Output value ranges (softmax sums to 1, sigmoid ∈ [0,1])
  4. Parameter counts are within budget (<500K, >50K)
  5. ONNX export for each architecture

Run:
  cd ~/src/tinkerclaw
  python -m pytest training/amygdala/tests/test_architectures.py -v
"""

import os
import sys
import pytest
import torch

# Ensure the training directory is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))

from training.amygdala.architectures.prudence import (
    PrudenceA_GRU_MLP,
    PrudenceB_TCN,
    PrudenceC_Transformer,
    PrudenceD_DualEncoder,
    PrudenceE_EnsembleMLP,
)
from training.amygdala.architectures.personality import (
    PersonalityA_GRU_MLP,
    PersonalityB_TCN,
    PersonalityC_Transformer,
    PersonalityD_DualEncoder,
    PersonalityE_EnsembleMLP,
)
from training.amygdala.architectures.meta_learner import (
    PrudenceMetaLearner,
    PersonalityMetaLearner,
)

# ─────────────────────────────────────────────────────────────
# Test fixtures / constants
# ─────────────────────────────────────────────────────────────

BATCH = 4
K = 32
DIM = 512
EMB_DIM = 64

PRUDENCE_CLASSES = [
    PrudenceA_GRU_MLP,
    PrudenceB_TCN,
    PrudenceC_Transformer,
    PrudenceD_DualEncoder,
    PrudenceE_EnsembleMLP,
]

PERSONALITY_CLASSES = [
    PersonalityA_GRU_MLP,
    PersonalityB_TCN,
    PersonalityC_Transformer,
    PersonalityD_DualEncoder,
    PersonalityE_EnsembleMLP,
]


# ─────────────────────────────────────────────────────────────
# Prudence: forward pass + output shapes
# ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cls", PRUDENCE_CLASSES)
def test_prudence_forward_shape(cls):
    """Forward pass produces correct output shapes."""
    model = cls()
    model.eval()
    seq = torch.randn(BATCH, K, DIM)
    with torch.no_grad():
        out = model(sequence=seq)

    assert "gate_probabilities" in out, f"{cls.__name__} missing 'gate_probabilities'"
    assert "confidence" in out, f"{cls.__name__} missing 'confidence'"
    assert "ambiguity" in out, f"{cls.__name__} missing 'ambiguity'"

    assert out["gate_probabilities"].shape == (BATCH, 3), \
        f"{cls.__name__} gate_probs shape {out['gate_probabilities'].shape} != ({BATCH}, 3)"
    assert out["confidence"].shape == (BATCH, 1), \
        f"{cls.__name__} confidence shape {out['confidence'].shape} != ({BATCH}, 1)"
    assert out["ambiguity"].shape == (BATCH, 1), \
        f"{cls.__name__} ambiguity shape {out['ambiguity'].shape} != ({BATCH}, 1)"


@pytest.mark.parametrize("cls", PRUDENCE_CLASSES)
def test_prudence_output_ranges(cls):
    """gate_probabilities sum to 1; confidence and ambiguity in [0,1]."""
    model = cls()
    model.eval()
    seq = torch.randn(BATCH, K, DIM)
    with torch.no_grad():
        out = model(sequence=seq)

    gate_sum = out["gate_probabilities"].sum(dim=-1)
    assert torch.allclose(gate_sum, torch.ones(BATCH), atol=1e-5), \
        f"{cls.__name__} gate_probs do not sum to 1 (got {gate_sum})"

    assert (out["confidence"] >= 0).all() and (out["confidence"] <= 1).all(), \
        f"{cls.__name__} confidence out of [0,1]"
    assert (out["ambiguity"] >= 0).all() and (out["ambiguity"] <= 1).all(), \
        f"{cls.__name__} ambiguity out of [0,1]"


# ─────────────────────────────────────────────────────────────
# Personality: forward pass + output shapes
# ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cls", PERSONALITY_CLASSES)
def test_personality_forward_shape(cls):
    """Forward pass produces correct behaviour_embedding shape."""
    model = cls()
    model.eval()
    seq = torch.randn(BATCH, K, DIM)
    with torch.no_grad():
        out = model(sequence=seq)

    assert "behaviour_embedding" in out, f"{cls.__name__} missing 'behaviour_embedding'"
    assert out["behaviour_embedding"].shape == (BATCH, EMB_DIM), \
        f"{cls.__name__} embedding shape {out['behaviour_embedding'].shape} != ({BATCH}, {EMB_DIM})"


@pytest.mark.parametrize("cls", PERSONALITY_CLASSES)
def test_personality_with_target_vector(cls):
    """Networks accept a target_vector and still produce correct shapes."""
    target = torch.randn(EMB_DIM)
    model = cls(target_vector=target)
    model.eval()
    seq = torch.randn(BATCH, K, DIM)
    with torch.no_grad():
        out = model(sequence=seq)
    assert out["behaviour_embedding"].shape == (BATCH, EMB_DIM)


# ─────────────────────────────────────────────────────────────
# Parameter count checks
# ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cls", PRUDENCE_CLASSES + PERSONALITY_CLASSES)
def test_parameter_count(cls):
    """Parameter count is within budget: 50K < params < 500K."""
    model = cls()
    total = sum(p.numel() for p in model.parameters())
    assert total < 500_000, \
        f"{cls.__name__} has {total:,} params — exceeds 500K budget"
    assert total > 50_000, \
        f"{cls.__name__} has {total:,} params — suspiciously small (<50K)"


# ─────────────────────────────────────────────────────────────
# ONNX export tests
# ─────────────────────────────────────────────────────────────

def _export_prudence(cls, tmp_path):
    """Helper: export a Prudence model and verify the file exists."""
    try:
        import onnx  # noqa: F401
    except ImportError:
        pytest.skip("onnx not installed")

    model = cls()
    model.eval()
    seq = torch.randn(1, K, DIM)
    path = str(tmp_path / f"{cls.__name__}.onnx")

    if cls is PrudenceD_DualEncoder:
        context = seq[:, :-1, :]                   # [1, K-1, 512]
        current = seq[:, -1, :]                    # [1, 512]
        torch.onnx.export(
            model,
            (context, current),
            path,
            input_names=["context", "current"],
            output_names=["gate_probabilities", "confidence", "ambiguity"],
            dynamic_axes={
                "context": {0: "batch"},
                "current": {0: "batch"},
                "gate_probabilities": {0: "batch"},
                "confidence": {0: "batch"},
                "ambiguity": {0: "batch"},
            },
            opset_version=17,
        )
    elif cls is PrudenceE_EnsembleMLP:
        current = seq[:, -1, :]                    # [1, 512]
        torch.onnx.export(
            model,
            (None, current),
            path,
            input_names=["current"],
            output_names=["gate_probabilities", "confidence", "ambiguity"],
            dynamic_axes={
                "current": {0: "batch"},
                "gate_probabilities": {0: "batch"},
                "confidence": {0: "batch"},
                "ambiguity": {0: "batch"},
            },
            opset_version=17,
        )
    else:
        torch.onnx.export(
            model,
            (seq,),
            path,
            input_names=["sequence"],
            output_names=["gate_probabilities", "confidence", "ambiguity"],
            dynamic_axes={
                "sequence": {0: "batch"},
                "gate_probabilities": {0: "batch"},
                "confidence": {0: "batch"},
                "ambiguity": {0: "batch"},
            },
            opset_version=17,
        )

    assert os.path.exists(path), f"ONNX file not created for {cls.__name__}"
    assert os.path.getsize(path) > 0, f"ONNX file is empty for {cls.__name__}"
    return path


def _export_personality(cls, tmp_path):
    """Helper: export a Personality model and verify the file exists."""
    try:
        import onnx  # noqa: F401
    except ImportError:
        pytest.skip("onnx not installed")

    model = cls()
    model.eval()
    seq = torch.randn(1, K, DIM)
    path = str(tmp_path / f"{cls.__name__}.onnx")

    if cls is PersonalityD_DualEncoder:
        context = seq[:, :-1, :]
        current = seq[:, -1, :]
        torch.onnx.export(
            model, (context, current), path,
            input_names=["context", "current"],
            output_names=["behaviour_embedding"],
            dynamic_axes={"context": {0: "batch"}, "current": {0: "batch"}, "behaviour_embedding": {0: "batch"}},
            opset_version=17,
        )
    elif cls is PersonalityE_EnsembleMLP:
        current = seq[:, -1, :]
        torch.onnx.export(
            model, (None, current), path,
            input_names=["current"],
            output_names=["behaviour_embedding"],
            dynamic_axes={"current": {0: "batch"}, "behaviour_embedding": {0: "batch"}},
            opset_version=17,
        )
    else:
        torch.onnx.export(
            model, (seq,), path,
            input_names=["sequence"],
            output_names=["behaviour_embedding"],
            dynamic_axes={"sequence": {0: "batch"}, "behaviour_embedding": {0: "batch"}},
            opset_version=17,
        )

    assert os.path.exists(path)
    return path


@pytest.mark.parametrize("cls", PRUDENCE_CLASSES)
def test_prudence_onnx_export(cls, tmp_path):
    """Each Prudence network exports to ONNX without error."""
    _export_prudence(cls, tmp_path)


@pytest.mark.parametrize("cls", PERSONALITY_CLASSES)
def test_personality_onnx_export(cls, tmp_path):
    """Each Personality network exports to ONNX without error."""
    _export_personality(cls, tmp_path)


# ─────────────────────────────────────────────────────────────
# ONNX runtime inference tests (requires onnxruntime)
# ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cls", PRUDENCE_CLASSES)
def test_prudence_onnx_inference(cls, tmp_path):
    """Exported Prudence ONNX model produces correct output shapes at inference."""
    try:
        import onnxruntime as ort
        import numpy as np
    except ImportError:
        pytest.skip("onnxruntime not installed")

    path = _export_prudence(cls, tmp_path)
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])

    if cls is PrudenceD_DualEncoder:
        context = np.random.randn(1, K - 1, DIM).astype(np.float32)
        current = np.random.randn(1, DIM).astype(np.float32)
        gate, conf, amb = sess.run(None, {"context": context, "current": current})
    elif cls is PrudenceE_EnsembleMLP:
        current = np.random.randn(1, DIM).astype(np.float32)
        gate, conf, amb = sess.run(None, {"current": current})
    else:
        seq = np.random.randn(1, K, DIM).astype(np.float32)
        gate, conf, amb = sess.run(None, {"sequence": seq})

    assert gate.shape == (1, 3), f"gate shape {gate.shape}"
    assert conf.shape == (1, 1), f"conf shape {conf.shape}"
    assert amb.shape == (1, 1), f"amb shape {amb.shape}"
    assert abs(gate[0].sum() - 1.0) < 1e-4, "gate probs don't sum to 1"
    assert 0 <= conf[0, 0] <= 1, "confidence out of [0,1]"
    assert 0 <= amb[0, 0] <= 1, "ambiguity out of [0,1]"


@pytest.mark.parametrize("cls", PERSONALITY_CLASSES)
def test_personality_onnx_inference(cls, tmp_path):
    """Exported Personality ONNX model produces correct output shapes at inference."""
    try:
        import onnxruntime as ort
        import numpy as np
    except ImportError:
        pytest.skip("onnxruntime not installed")

    path = _export_personality(cls, tmp_path)
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])

    if cls is PersonalityD_DualEncoder:
        context = np.random.randn(1, K - 1, DIM).astype(np.float32)
        current = np.random.randn(1, DIM).astype(np.float32)
        (emb,) = sess.run(None, {"context": context, "current": current})
    elif cls is PersonalityE_EnsembleMLP:
        current = np.random.randn(1, DIM).astype(np.float32)
        (emb,) = sess.run(None, {"current": current})
    else:
        seq = np.random.randn(1, K, DIM).astype(np.float32)
        (emb,) = sess.run(None, {"sequence": seq})

    assert emb.shape == (1, EMB_DIM), f"embedding shape {emb.shape}"


# ─────────────────────────────────────────────────────────────
# Meta-learner tests
# ─────────────────────────────────────────────────────────────

def test_prudence_meta_learner():
    """PrudenceMetaLearner combines 5 architecture outputs correctly."""
    meta = PrudenceMetaLearner(n_archs=5)
    meta.eval()

    gate_all = torch.randn(BATCH, 5, 3).softmax(dim=-1)
    conf_all = torch.rand(BATCH, 5)
    amb_all = torch.rand(BATCH, 5)

    with torch.no_grad():
        out = meta(gate_all, conf_all, amb_all)

    assert out["gate_probabilities"].shape == (BATCH, 3)
    assert out["confidence"].shape == (BATCH, 1)
    assert out["ambiguity"].shape == (BATCH, 1)
    assert torch.allclose(out["gate_probabilities"].sum(dim=-1), torch.ones(BATCH), atol=1e-5)


def test_personality_meta_learner():
    """PersonalityMetaLearner combines 5 embedding outputs correctly."""
    meta = PersonalityMetaLearner(n_archs=5)
    meta.eval()

    embs = torch.randn(BATCH, 5, EMB_DIM)
    with torch.no_grad():
        out = meta(embs)

    assert out["behaviour_embedding"].shape == (BATCH, EMB_DIM)


def test_meta_learner_set_weights():
    """set_weights() produces approximately the requested weight distribution."""
    meta = PrudenceMetaLearner(n_archs=5)
    target_weights = [0.4, 0.3, 0.15, 0.1, 0.05]
    meta.set_weights(target_weights)

    actual = meta.weights.detach().tolist()
    for target, actual_w in zip(target_weights, actual):
        assert abs(target - actual_w) < 0.05, \
            f"Weight mismatch: target={target:.3f} actual={actual_w:.3f}"


# ─────────────────────────────────────────────────────────────
# Gradient flow sanity check
# ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cls", PRUDENCE_CLASSES)
def test_prudence_gradients(cls):
    """Gradients flow through all parameters (no dead subgraph)."""
    model = cls()
    seq = torch.randn(2, K, DIM)
    out = model(sequence=seq)
    loss = out["gate_probabilities"].sum() + out["confidence"].sum() + out["ambiguity"].sum()
    loss.backward()

    for name, param in model.named_parameters():
        assert param.grad is not None, f"{cls.__name__}: no gradient for param '{name}'"


@pytest.mark.parametrize("cls", PERSONALITY_CLASSES)
def test_personality_gradients(cls):
    """Gradients flow through all Personality network parameters."""
    model = cls()
    seq = torch.randn(2, K, DIM)
    out = model(sequence=seq)
    loss = out["behaviour_embedding"].sum()
    loss.backward()

    for name, param in model.named_parameters():
        assert param.grad is not None, f"{cls.__name__}: no gradient for param '{name}'"


# ─────────────────────────────────────────────────────────────
# Determinism check (same input → same output)
# ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cls", PRUDENCE_CLASSES)
def test_prudence_deterministic(cls):
    """Same input produces same output in eval mode (no stochastic dropout)."""
    model = cls()
    model.eval()
    seq = torch.randn(2, K, DIM)
    with torch.no_grad():
        out1 = model(sequence=seq)
        out2 = model(sequence=seq)
    assert torch.allclose(out1["gate_probabilities"], out2["gate_probabilities"]), \
        f"{cls.__name__} is not deterministic in eval mode"


if __name__ == "__main__":
    import pytest as _pytest
    _pytest.main([__file__, "-v"])
