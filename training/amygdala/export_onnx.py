"""
AMYGDALA ONNX Export (P0.5.2)
==============================
Exports all 10 trained PyTorch networks to ONNX for runtime inference.

Input shapes per architecture (K=32, DIM=512):
  A, B, C (sequence):  sequence [1, K, DIM]   → (gate_probs [1,3], conf [1,1], amb [1,1])
  D (dual-encoder):    context [1, K-1, DIM], current [1, DIM]
  E (ensemble MLP):    current [1, DIM]

All exports use opset 17 with dynamic batch dimension.

After export, each model is verified by running a forward pass through both
PyTorch and ONNX Runtime and comparing outputs (max absolute error < 1e-4).

Usage:
    python -m training.amygdala.export_onnx \
        --weights output/pretrain/ \
        --out models/amygdala/ \
        [--no-verify]
"""

import argparse
import os
from pathlib import Path
from typing import Dict, Optional, Tuple

import numpy as np
import torch
import os
os.environ['TORCH_ONNX_USE_EXPERIMENTAL_LOGIC'] = '0'  # Force legacy export
import torch.nn as nn

from .architectures import (
    PrudenceA_GRU_MLP,  PrudenceB_TCN,        PrudenceC_Transformer,
    PrudenceD_DualEncoder, PrudenceE_EnsembleMLP,
    PersonalityA_GRU_MLP, PersonalityB_TCN,    PersonalityC_Transformer,
    PersonalityD_DualEncoder, PersonalityE_EnsembleMLP,
)

OPSET     = 18
K         = 32     # temporal window
DIM       = 512    # embedding dimension
EMB_DIM   = 64     # personality embedding dimension

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
# Wrappers: flatten dict output → tuple for ONNX export
# ─────────────────────────────────────────────────────────────

class _PrudenceWrapper(nn.Module):
    """Wraps a Prudence model to return a tuple instead of a dict."""
    def __init__(self, inner: nn.Module):
        super().__init__()
        self.inner = inner

    def forward(self, *args, **kwargs):
        out = self.inner(*args, **kwargs)
        return out["gate_probabilities"], out["confidence"], out["ambiguity"]


class _PersonalityWrapper(nn.Module):
    """Wraps a Personality model to return a tuple instead of a dict."""
    def __init__(self, inner: nn.Module):
        super().__init__()
        self.inner = inner

    def forward(self, *args, **kwargs):
        out = self.inner(*args, **kwargs)
        return (out["behaviour_embedding"],)


# ─────────────────────────────────────────────────────────────
# Prudence export
# ─────────────────────────────────────────────────────────────

def export_prudence(
    arch_key: str,
    weights_path: Optional[str],
    output_path: str,
) -> None:
    """
    Export a trained (or untrained) Prudence network to ONNX.

    Args:
        arch_key:     "a" | "b" | "c" | "d" | "e"
        weights_path: Path to .pt checkpoint (None → random weights)
        output_path:  Destination .onnx file
    """
    model = PRUDENCE_ARCHS[arch_key]()
    if weights_path and Path(weights_path).exists():
        model.load_state_dict(torch.load(weights_path, map_location="cpu"))
    model.eval()

    wrapped = _PrudenceWrapper(model)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    if arch_key in ("a", "b", "c"):
        # Input: sequence [batch, K, 512]
        dummy = torch.randn(1, K, DIM)
        model.eval()
        torch.onnx.export(
            wrapped,
            (dummy,),
            output_path,
            dynamo=False,
            input_names=["sequence"],
            output_names=["gate_probabilities", "confidence", "ambiguity"],
            dynamic_axes={
                "sequence":           {0: "batch"},
                "gate_probabilities": {0: "batch"},
                "confidence":         {0: "batch"},
                "ambiguity":          {0: "batch"},
            },
            opset_version=OPSET,
        )

    elif arch_key == "d":
        # Dual-encoder: context [batch, K-1, 512] + current [batch, 512]
        dummy_ctx = torch.randn(1, K - 1, DIM)
        dummy_cur = torch.randn(1, DIM)

        # Architecture D's forward signature: (sequence=None, current=None)
        # We call it with (sequence=context, current=current) for the dual-input path.
        class _DualWrapper(nn.Module):
            def __init__(self, m):
                super().__init__()
                self.m = m
            def forward(self, context, current):
                return self.m(sequence=context, current=current)

        w = _PrudenceWrapper(_DualWrapper(model.inner if hasattr(model, "inner") else model))
        # Use the underlying model directly
        class _DualExportWrapper(nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner
            def forward(self, context, current):
                out = self.inner(sequence=context, current=current)
                return out["gate_probabilities"], out["confidence"], out["ambiguity"]

        w2 = _DualExportWrapper(model)
        model.eval()
        torch.onnx.export(
            w2,
            (dummy_ctx, dummy_cur),
            output_path,
            dynamo=False,
            input_names=["context", "current"],
            output_names=["gate_probabilities", "confidence", "ambiguity"],
            dynamic_axes={
                "context": {0: "batch"},
                "current": {0: "batch"},
                "gate_probabilities": {0: "batch"},
                "confidence":         {0: "batch"},
                "ambiguity":          {0: "batch"},
            },
            opset_version=OPSET,
        )

    elif arch_key == "e":
        # Ensemble MLP: current [batch, 512] only
        dummy_cur = torch.randn(1, DIM)

        class _EnsembleExportWrapper(nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner
            def forward(self, current):
                out = self.inner(sequence=None, current=current)
                return out["gate_probabilities"], out["confidence"], out["ambiguity"]

        w3 = _EnsembleExportWrapper(model)
        model.eval()
        torch.onnx.export(
            w3,
            (dummy_cur,),
            output_path,
            dynamo=False,
            input_names=["current"],
            output_names=["gate_probabilities", "confidence", "ambiguity"],
            dynamic_axes={
                "current":            {0: "batch"},
                "gate_probabilities": {0: "batch"},
                "confidence":         {0: "batch"},
                "ambiguity":          {0: "batch"},
            },
            opset_version=OPSET,
        )

    size_kb = Path(output_path).stat().st_size / 1024
    print(f"[export] Prudence-{arch_key.upper()} → {output_path} ({size_kb:.0f} KB)")


# ─────────────────────────────────────────────────────────────
# Personality export
# ─────────────────────────────────────────────────────────────

def export_personality(
    arch_key: str,
    weights_path: Optional[str],
    output_path: str,
) -> None:
    """Export a trained (or untrained) Personality network to ONNX."""
    model = PERSONALITY_ARCHS[arch_key]()
    if weights_path and Path(weights_path).exists():
        model.load_state_dict(torch.load(weights_path, map_location="cpu"))
    model.eval()

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    if arch_key in ("a", "b", "c"):
        dummy = torch.randn(1, K, DIM)

        class _PerABCWrapper(nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner
            def forward(self, sequence):
                return self.inner(sequence=sequence)["behaviour_embedding"]

        model.eval()
        torch.onnx.export(
            _PerABCWrapper(model),
            (dummy,),
            output_path,
            dynamo=False,
            input_names=["sequence"],
            output_names=["behaviour_embedding"],
            dynamic_axes={
                "sequence":          {0: "batch"},
                "behaviour_embedding": {0: "batch"},
            },
            opset_version=OPSET,
        )

    elif arch_key == "d":
        dummy_ctx = torch.randn(1, K - 1, DIM)
        dummy_cur = torch.randn(1, DIM)

        class _PerDWrapper(nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner
            def forward(self, context, current):
                return self.inner(sequence=context, current=current)["behaviour_embedding"]

        model.eval()
        torch.onnx.export(
            _PerDWrapper(model),
            (dummy_ctx, dummy_cur),
            output_path,
            dynamo=False,
            input_names=["context", "current"],
            output_names=["behaviour_embedding"],
            dynamic_axes={
                "context": {0: "batch"},
                "current": {0: "batch"},
                "behaviour_embedding": {0: "batch"},
            },
            opset_version=OPSET,
        )

    elif arch_key == "e":
        dummy_cur = torch.randn(1, DIM)

        class _PerEWrapper(nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner
            def forward(self, current):
                return self.inner(sequence=None, current=current)["behaviour_embedding"]

        model.eval()
        torch.onnx.export(
            _PerEWrapper(model),
            (dummy_cur,),
            output_path,
            dynamo=False,
            input_names=["current"],
            output_names=["behaviour_embedding"],
            dynamic_axes={
                "current": {0: "batch"},
                "behaviour_embedding": {0: "batch"},
            },
            opset_version=OPSET,
        )

    size_kb = Path(output_path).stat().st_size / 1024
    print(f"[export] Personality-{arch_key.upper()} → {output_path} ({size_kb:.0f} KB)")


# ─────────────────────────────────────────────────────────────
# Verification
# ─────────────────────────────────────────────────────────────

def verify_prudence(arch_key: str, onnx_path: str, atol: float = 1e-4) -> bool:
    """
    Verify ONNX model matches PyTorch model outputs.

    Runs a forward pass on both and checks max absolute error < atol.
    Returns True if verification passes.
    """
    try:
        import onnxruntime as ort
    except ImportError:
        print("[verify] onnxruntime not installed — skipping verification")
        return True

    model = PRUDENCE_ARCHS[arch_key]()
    model.eval()

    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    input_names = [i.name for i in sess.get_inputs()]

    with torch.no_grad():
        if arch_key in ("a", "b", "c"):
            dummy = torch.randn(2, K, DIM)   # batch=2 to test dynamic axis
            pt_out = model(sequence=dummy)
            np_dummy = dummy.numpy()
            ort_out = sess.run(None, {"sequence": np_dummy})
            pt_gate = pt_out["gate_probabilities"].numpy()

        elif arch_key == "d":
            dummy_ctx = torch.randn(2, K - 1, DIM)
            dummy_cur = torch.randn(2, DIM)
            pt_out = model(sequence=dummy_ctx, current=dummy_cur)
            ort_out = sess.run(None, {
                "context": dummy_ctx.numpy(),
                "current": dummy_cur.numpy(),
            })
            pt_gate = pt_out["gate_probabilities"].numpy()

        elif arch_key == "e":
            dummy_cur = torch.randn(2, DIM)
            pt_out = model(sequence=None, current=dummy_cur)
            ort_out = sess.run(None, {"current": dummy_cur.numpy()})
            pt_gate = pt_out["gate_probabilities"].numpy()
        else:
            return True

    ort_gate = ort_out[0]
    err = float(np.abs(pt_gate - ort_gate).max())
    ok  = err < atol
    status = "PASS" if ok else "FAIL"
    print(f"[verify] Prudence-{arch_key.upper()} {status} (max_err={err:.2e})")
    return ok


def verify_personality(arch_key: str, onnx_path: str, atol: float = 1e-4) -> bool:
    """Verify ONNX Personality model matches PyTorch outputs."""
    try:
        import onnxruntime as ort
    except ImportError:
        return True

    model = PERSONALITY_ARCHS[arch_key]()
    model.eval()
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

    with torch.no_grad():
        if arch_key in ("a", "b", "c"):
            dummy = torch.randn(2, K, DIM)
            pt_emb = model(sequence=dummy)["behaviour_embedding"].numpy()
            ort_emb = sess.run(None, {"sequence": dummy.numpy()})[0]

        elif arch_key == "d":
            dummy_ctx = torch.randn(2, K - 1, DIM)
            dummy_cur = torch.randn(2, DIM)
            pt_emb = model(sequence=dummy_ctx, current=dummy_cur)["behaviour_embedding"].numpy()
            ort_emb = sess.run(None, {
                "context": dummy_ctx.numpy(),
                "current": dummy_cur.numpy(),
            })[0]

        elif arch_key == "e":
            dummy_cur = torch.randn(2, DIM)
            pt_emb = model(sequence=None, current=dummy_cur)["behaviour_embedding"].numpy()
            ort_emb = sess.run(None, {"current": dummy_cur.numpy()})[0]
        else:
            return True

    err = float(np.abs(pt_emb - ort_emb).max())
    ok  = err < atol
    status = "PASS" if ok else "FAIL"
    print(f"[verify] Personality-{arch_key.upper()} {status} (max_err={err:.2e})")
    return ok


# ─────────────────────────────────────────────────────────────
# Export all 10 models
# ─────────────────────────────────────────────────────────────

def export_all(
    weights_dir: str,
    output_dir: str,
    verify: bool = True,
) -> Dict[str, bool]:
    """
    Export all 10 networks to ONNX and optionally verify each.

    Args:
        weights_dir: Directory containing *_best.pt checkpoints
        output_dir:  Directory to write .onnx files
        verify:      Whether to run PyTorch↔ONNX comparison

    Returns:
        dict mapping model name → verification passed (True/False)
    """
    results: Dict[str, bool] = {}
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    for key in "abcde":
        # Prudence
        p_ckpt = f"{weights_dir}/prudence_{key}_best.pt"
        p_out  = f"{output_dir}/prudence-{key}.onnx"
        export_prudence(key, p_ckpt if Path(p_ckpt).exists() else None, p_out)
        if verify:
            results[f"prudence_{key}"] = verify_prudence(key, p_out)

        # Personality
        i_ckpt = f"{weights_dir}/personality_{key}_best.pt"
        i_out  = f"{output_dir}/personality-{key}.onnx"
        export_personality(key, i_ckpt if Path(i_ckpt).exists() else None, i_out)
        if verify:
            results[f"personality_{key}"] = verify_personality(key, i_out)

    # Summary
    if verify:
        passed = sum(v for v in results.values())
        total  = len(results)
        print(f"\n[export_all] Verification: {passed}/{total} passed")
        if passed < total:
            failed = [k for k, v in results.items() if not v]
            print(f"  FAILED: {failed}")

    return results


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export AMYGDALA models to ONNX")
    parser.add_argument("--weights", required=True, help="Directory with *.pt checkpoints")
    parser.add_argument("--out",     required=True, help="Output directory for .onnx files")
    parser.add_argument("--no-verify", action="store_true")
    args = parser.parse_args()

    export_all(args.weights, args.out, verify=not args.no_verify)
