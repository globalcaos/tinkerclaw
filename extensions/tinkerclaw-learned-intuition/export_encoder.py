#!/usr/bin/env python3
"""
export_encoder.py — P0.2 AMYGDALA Embedding Pipeline
=====================================================
Downloads all-MiniLM-L6-v2 from HuggingFace and exports:
  1. encoder.onnx     — sentence encoder (all-MiniLM-L6-v2), opset 17
  2. projection.onnx  — Linear(384 → 512) + LayerNorm, Xavier-init, opset 17

Output directory: ~/src/tinkerclaw/models/amygdala/

Usage:
  pip install torch transformers optimum[exporters] onnx onnxruntime
  python export_encoder.py [--output-dir PATH] [--input-dim 384] [--output-dim 512]
"""

import argparse
import os
from pathlib import Path

import torch
import torch.nn as nn


# ---------------------------------------------------------------------------
# 1. Sentence Encoder export (all-MiniLM-L6-v2)
# ---------------------------------------------------------------------------

def export_encoder(output_path: Path, model_name: str = "sentence-transformers/all-MiniLM-L6-v2") -> None:
    """Download and export sentence encoder to ONNX."""
    try:
        from transformers import AutoTokenizer, AutoModel
    except ImportError:
        raise ImportError("pip install transformers")

    print(f"[encoder] Downloading {model_name} ...")
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModel.from_pretrained(model_name)
    model.eval()

    # Dummy input for tracing (batch=1, seq_len=128)
    dummy_text = "example situation string for export"
    inputs = tokenizer(
        dummy_text,
        return_tensors="pt",
        padding="max_length",
        truncation=True,
        max_length=128,
    )

    print(f"[encoder] Exporting to {output_path} ...")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        model,
        args=(inputs["input_ids"], inputs["attention_mask"], inputs["token_type_ids"]),
        f=str(output_path),
        input_names=["input_ids", "attention_mask", "token_type_ids"],
        output_names=["last_hidden_state", "pooler_output"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq_len"},
            "attention_mask": {0: "batch", 1: "seq_len"},
            "token_type_ids": {0: "batch", 1: "seq_len"},
            "last_hidden_state": {0: "batch", 1: "seq_len"},
            "pooler_output": {0: "batch"},
        },
        opset_version=17,
        do_constant_folding=True,
    )
    print(f"[encoder] ✓ Exported encoder to {output_path}")

    # Quick validation
    import onnxruntime as ort
    sess = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    result = sess.run(
        None,
        {
            "input_ids": inputs["input_ids"].numpy(),
            "attention_mask": inputs["attention_mask"].numpy(),
            "token_type_ids": inputs["token_type_ids"].numpy(),
        },
    )
    last_hidden = result[0]
    print(f"[encoder] ✓ Validation passed. last_hidden_state shape: {last_hidden.shape}")  # [1, 128, 384]


# ---------------------------------------------------------------------------
# 2. Projection Layer export (Linear 384 → 512 + LayerNorm)
# ---------------------------------------------------------------------------

class ProjectionLayer(nn.Module):
    """
    Linear projection from encoder_dim (384) to internal_dim (512) + LayerNorm.
    Xavier-uniform initialization.
    """

    def __init__(self, input_dim: int = 384, output_dim: int = 512) -> None:
        super().__init__()
        self.proj = nn.Linear(input_dim, output_dim)
        self.norm = nn.LayerNorm(output_dim)
        nn.init.xavier_uniform_(self.proj.weight)
        nn.init.zeros_(self.proj.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.norm(self.proj(x))


def export_projection(
    output_path: Path,
    input_dim: int = 384,
    output_dim: int = 512,
) -> None:
    """Create and export a random-init projection layer to ONNX."""
    print(f"[projection] Creating ProjectionLayer({input_dim} → {output_dim}) ...")
    model = ProjectionLayer(input_dim, output_dim)
    model.eval()

    dummy = torch.randn(1, input_dim)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        model,
        dummy,
        str(output_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
        do_constant_folding=True,
    )
    print(f"[projection] ✓ Exported projection layer to {output_path}")

    # Quick validation
    import onnxruntime as ort
    import numpy as np

    sess = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    result = sess.run(None, {"input": dummy.numpy()})
    out = result[0]
    print(f"[projection] ✓ Validation passed. output shape: {out.shape}")  # [1, 512]


# ---------------------------------------------------------------------------
# Also save a checkpoint of weights for future fine-tuning
# ---------------------------------------------------------------------------

def save_projection_weights(output_dir: Path, input_dim: int = 384, output_dim: int = 512) -> None:
    """Save projection layer PyTorch state_dict alongside ONNX."""
    model = ProjectionLayer(input_dim, output_dim)
    weights_path = output_dir / "projection_init.pt"
    torch.save(model.state_dict(), str(weights_path))
    print(f"[projection] ✓ Saved initial weights to {weights_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    default_output_dir = Path.home() / "src" / "tinkerclaw" / "models" / "amygdala"

    parser = argparse.ArgumentParser(description="Export AMYGDALA ONNX models")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=default_output_dir,
        help=f"Output directory (default: {default_output_dir})",
    )
    parser.add_argument("--input-dim", type=int, default=384, help="Encoder output dim (default: 384)")
    parser.add_argument("--output-dim", type=int, default=512, help="Projection output dim (default: 512)")
    parser.add_argument(
        "--encoder-only",
        action="store_true",
        help="Only export encoder (skip projection)",
    )
    parser.add_argument(
        "--projection-only",
        action="store_true",
        help="Only export projection (skip encoder download)",
    )
    args = parser.parse_args()

    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    if not args.projection_only:
        export_encoder(output_dir / "encoder.onnx")

    if not args.encoder_only:
        export_projection(output_dir / "projection.onnx", args.input_dim, args.output_dim)
        save_projection_weights(output_dir, args.input_dim, args.output_dim)

    print("\n✓ All models exported to:", output_dir)
    print("  - encoder.onnx")
    print("  - projection.onnx")
    print("  - projection_init.pt  (PyTorch weights for future fine-tuning)")


if __name__ == "__main__":
    main()
