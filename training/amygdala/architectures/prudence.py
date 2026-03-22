"""
AMYGDALA Prudence Network Architectures (A through E)
Paper: J11 — Learned Intuition, §5.1–§5.5, Appendix B.1–B.5

Each network takes a temporal window of K=32 situation embeddings (512d each)
and produces three outputs:
  - gate_probabilities: [batch, 3] — softmax over (stop, allow, escalate)
  - confidence:         [batch, 1] — sigmoid ∈ [0,1]
  - ambiguity:          [batch, 1] — sigmoid ∈ [0,1]

All architectures are ONNX-exportable (opset 17, no dynamic control flow).
Parameter budget: ~190K–310K per network.
"""

import torch
import torch.nn as nn
from typing import Optional


# ─────────────────────────────────────────────────────────────
# Architecture A: GRU-MLP (paper §5.1, Appendix B.1)
# Parameters: ~210K
# ─────────────────────────────────────────────────────────────

class PrudenceA_GRU_MLP(nn.Module):
    """
    GRU processes situation embedding sequence; MLP produces output.

    Pipeline:
      Input:  [batch, K=32, 512]
      Proj:   Linear(512 → 384)  — keeps params ≈210K (paper §5.1)
      GRU:    input=384, hidden=128, 1 layer
      MLP:    128 → 64 → 32
      Heads:  gate(32→3 softmax), confidence(32→1 sigmoid), ambiguity(32→1 sigmoid)

    NOTE: The 512→384 projection before the GRU is required to stay within the
    ~210K parameter budget. Without it, the GRU input=512 balloons to ~250K.
    """

    def __init__(
        self,
        input_dim: int = 512,
        gru_input_dim: int = 384,
        hidden_dim: int = 128,
        mlp_hidden: int = 64,
        output_hidden: int = 32,
        dropout: float = 0.1,
    ):
        super().__init__()
        self.input_proj = nn.Linear(input_dim, gru_input_dim)
        self.gru = nn.GRU(
            input_size=gru_input_dim,
            hidden_size=hidden_dim,
            num_layers=1,
            batch_first=True,
        )
        self.mlp = nn.Sequential(
            nn.Linear(hidden_dim, mlp_hidden),
            nn.LayerNorm(mlp_hidden),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(mlp_hidden, output_hidden),
            nn.LayerNorm(output_hidden),
            nn.GELU(),
        )
        self.gate_head = nn.Linear(output_hidden, 3)
        self.confidence_head = nn.Linear(output_hidden, 1)
        self.ambiguity_head = nn.Linear(output_hidden, 1)

    def forward(
        self,
        sequence: torch.Tensor,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        """
        Args:
            sequence: [batch, K, 512] — temporal window of embeddings
            current:  unused (present for API symmetry with arch D/E)
        Returns:
            dict with keys: gate_probabilities, confidence, ambiguity
        """
        x = self.input_proj(sequence)          # [batch, K, 384]
        _, h_n = self.gru(x)                   # h_n: [1, batch, 128]
        h_last = h_n.squeeze(0)                # [batch, 128]
        features = self.mlp(h_last)            # [batch, 32]

        return {
            "gate_probabilities": torch.softmax(self.gate_head(features), dim=-1),
            "confidence": torch.sigmoid(self.confidence_head(features)),
            "ambiguity": torch.sigmoid(self.ambiguity_head(features)),
        }


# ─────────────────────────────────────────────────────────────
# Architecture B: TCN (paper §5.2, Appendix B.2)
# Parameters: ~260K
# Receptive field: 2 × (1+2+4+8) = 30 steps (covers K=32)
# ─────────────────────────────────────────────────────────────

class _CausalConv1d(nn.Module):
    """1-D causal convolution — left-pads to prevent future leakage."""

    def __init__(self, in_channels: int, out_channels: int, kernel_size: int, dilation: int):
        super().__init__()
        self.padding = (kernel_size - 1) * dilation
        self.conv = nn.Conv1d(
            in_channels, out_channels,
            kernel_size=kernel_size,
            dilation=dilation,
            padding=self.padding,
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.conv(x)
        # Remove right-side padding introduced by Conv1d padding= argument
        if self.padding > 0:
            out = out[:, :, : -self.padding]
        return out


class _TCNBlock(nn.Module):
    """Single TCN residual block: CausalConv1d → LayerNorm → GELU → Dropout + skip."""

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int,
        dilation: int,
        dropout: float,
    ):
        super().__init__()
        self.conv = _CausalConv1d(in_channels, out_channels, kernel_size, dilation)
        self.norm = nn.LayerNorm(out_channels)
        self.act = nn.GELU()
        self.drop = nn.Dropout(dropout)
        # 1×1 conv for residual channel mismatch
        self.residual = (
            nn.Conv1d(in_channels, out_channels, 1)
            if in_channels != out_channels
            else nn.Identity()
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.conv(x)                         # [B, C_out, T]
        out = out.transpose(1, 2)                  # [B, T, C_out] for LayerNorm
        out = self.norm(out)
        out = out.transpose(1, 2)                  # [B, C_out, T]
        out = self.act(out)
        out = self.drop(out)
        return out + self.residual(x)


class PrudenceB_TCN(nn.Module):
    """
    4-layer Temporal Convolutional Network with dilations [1, 2, 4, 8].

    Pipeline:
      Input:  [batch, K=32, 512]
      Layer1: CausalConv1D(512→128, k=3, d=1) + LayerNorm + GELU + Dropout
      Layer2: CausalConv1D(128→128, k=3, d=2) + ...
      Layer3: CausalConv1D(128→128, k=3, d=4) + ...
      Layer4: CausalConv1D(128→64,  k=3, d=8) + ...
      Pool:   Take last temporal position → [batch, 64]
      FC:     Linear(64→32) + GELU
      Heads:  gate(32→3), confidence(32→1), ambiguity(32→1)
    """

    def __init__(
        self,
        input_dim: int = 512,
        hidden_channels: int = 128,
        output_channels: int = 64,
        kernel_size: int = 3,
        dilations: Optional[list] = None,
        dropout: float = 0.1,
        output_hidden: int = 32,
    ):
        super().__init__()
        if dilations is None:
            dilations = [1, 2, 4, 8]

        layers = []
        in_ch = input_dim
        for i, dilation in enumerate(dilations):
            out_ch = output_channels if i == len(dilations) - 1 else hidden_channels
            layers.append(_TCNBlock(in_ch, out_ch, kernel_size, dilation, dropout))
            in_ch = out_ch
        self.tcn = nn.Sequential(*layers)
        self.fc = nn.Sequential(nn.Linear(output_channels, output_hidden), nn.GELU())
        self.gate_head = nn.Linear(output_hidden, 3)
        self.confidence_head = nn.Linear(output_hidden, 1)
        self.ambiguity_head = nn.Linear(output_hidden, 1)

    def forward(
        self,
        sequence: torch.Tensor,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        x = sequence.transpose(1, 2)               # [batch, 512, K]
        x = self.tcn(x)                            # [batch, 64, K]
        x = x[:, :, -1]                            # [batch, 64] last position
        features = self.fc(x)                      # [batch, 32]
        return {
            "gate_probabilities": torch.softmax(self.gate_head(features), dim=-1),
            "confidence": torch.sigmoid(self.confidence_head(features)),
            "ambiguity": torch.sigmoid(self.ambiguity_head(features)),
        }


# ─────────────────────────────────────────────────────────────
# Architecture C: Transformer-Micro (paper §5.3, Appendix B.3)
# Parameters: ~190K
# 2 layers, 4 heads, d_model=96, d_ff=192
# ─────────────────────────────────────────────────────────────

class _LearnedPosEnc(nn.Module):
    def __init__(self, max_len: int, d_model: int):
        super().__init__()
        self.pe = nn.Embedding(max_len, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        positions = torch.arange(x.size(1), device=x.device).unsqueeze(0)
        return x + self.pe(positions)


class PrudenceC_Transformer(nn.Module):
    """
    2-layer Transformer encoder with learned positional encoding.

    Pipeline:
      Input:  [batch, K=32, 512]
      Proj:   Linear(512 → 96)
      PosEnc: Learned, K positions
      Enc:    2× TransformerEncoderLayer(d_model=96, nhead=4, d_ff=192)
      Pool:   Mean pool across sequence → [batch, 96]
      FC:     Linear(96→64) + GELU + Linear(64→32) + GELU
      Heads:  gate(32→3), confidence(32→1), ambiguity(32→1)
    """

    def __init__(
        self,
        input_dim: int = 512,
        d_model: int = 96,
        nhead: int = 4,
        d_ff: int = 192,
        num_layers: int = 2,
        max_len: int = 32,
        dropout: float = 0.1,
        output_hidden: int = 32,
    ):
        super().__init__()
        self.input_proj = nn.Linear(input_dim, d_model)
        self.pos_enc = _LearnedPosEnc(max_len, d_model)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=d_ff,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        self.fc = nn.Sequential(
            nn.Linear(d_model, 64),
            nn.GELU(),
            nn.Linear(64, output_hidden),
            nn.GELU(),
        )
        self.gate_head = nn.Linear(output_hidden, 3)
        self.confidence_head = nn.Linear(output_hidden, 1)
        self.ambiguity_head = nn.Linear(output_hidden, 1)

    def forward(
        self,
        sequence: torch.Tensor,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        x = self.input_proj(sequence)              # [batch, K, 96]
        x = self.pos_enc(x)
        x = self.encoder(x)                        # [batch, K, 96]
        x = x.mean(dim=1)                          # [batch, 96]
        features = self.fc(x)                      # [batch, 32]
        return {
            "gate_probabilities": torch.softmax(self.gate_head(features), dim=-1),
            "confidence": torch.sigmoid(self.confidence_head(features)),
            "ambiguity": torch.sigmoid(self.ambiguity_head(features)),
        }


# ─────────────────────────────────────────────────────────────
# Architecture D: Dual-Encoder with Cross-Attention (paper §5.4, Appendix B.4)
# Parameters: ~310K
# Designed to detect contradiction (e.g. README debacle pattern)
# ─────────────────────────────────────────────────────────────

class PrudenceD_DualEncoder(nn.Module):
    """
    Separate encoders for current action and historical context,
    with cross-attention to detect contradictions.

    Pipeline:
      Action encoder:  Linear(512→128) on current s_t
      Context encoder: GRU(512→128) on [s_{t-K+1}, ..., s_{t-1}]
      Cross-attention: MultiheadAttention(128, 4 heads)
                       Query = action encoding, Key/Value = context sequence
      Fusion:          [action ⊕ attended] → Linear(256→64) → GELU → Linear(64→32)
      Heads:           gate(32→3), confidence(32→1), ambiguity(32→1)

    Input contract (ONNX runtime):
      - 'sequence': [batch, K-1, 512]  — context window (all but latest)
      - 'current':  [batch, 512]       — the proposed action embedding

    Training convenience:
      If only 'sequence' is given (shape [batch, K, 512]), current is
      extracted as sequence[:, -1, :] and context as sequence[:, :-1, :].
    """

    def __init__(
        self,
        input_dim: int = 512,
        hidden_dim: int = 128,
        cross_heads: int = 4,
        output_hidden: int = 32,
        dropout: float = 0.1,
    ):
        super().__init__()
        self.action_encoder = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
        )
        self.context_gru = nn.GRU(
            input_size=input_dim,
            hidden_size=hidden_dim,
            num_layers=1,
            batch_first=True,
        )
        self.cross_attn = nn.MultiheadAttention(
            embed_dim=hidden_dim,
            num_heads=cross_heads,
            dropout=dropout,
            batch_first=True,
        )
        self.fusion = nn.Sequential(
            nn.Linear(hidden_dim * 2, 64),
            nn.LayerNorm(64),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(64, output_hidden),
            nn.GELU(),
        )
        self.gate_head = nn.Linear(output_hidden, 3)
        self.confidence_head = nn.Linear(output_hidden, 1)
        self.ambiguity_head = nn.Linear(output_hidden, 1)

    def forward(
        self,
        sequence: Optional[torch.Tensor] = None,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        # Handle both call signatures
        if sequence is not None and current is None:
            # Training: full sequence provided, split into context + current
            current = sequence[:, -1, :]           # [batch, 512]
            context = sequence[:, :-1, :]          # [batch, K-1, 512]
        elif sequence is not None and current is not None:
            # Runtime: context and current are explicit
            context = sequence                      # [batch, K-1, 512]
        else:
            raise ValueError("PrudenceD_DualEncoder requires 'sequence' or both inputs")

        q = self.action_encoder(current).unsqueeze(1)   # [batch, 1, 128]
        context_out, _ = self.context_gru(context)       # [batch, K-1, 128]
        attended, _ = self.cross_attn(q, context_out, context_out)
        attended = attended.squeeze(1)                    # [batch, 128]

        fused = torch.cat([q.squeeze(1), attended], dim=-1)  # [batch, 256]
        features = self.fusion(fused)                          # [batch, 32]
        return {
            "gate_probabilities": torch.softmax(self.gate_head(features), dim=-1),
            "confidence": torch.sigmoid(self.confidence_head(features)),
            "ambiguity": torch.sigmoid(self.ambiguity_head(features)),
        }


# ─────────────────────────────────────────────────────────────
# Architecture E: Ensemble MLP (paper §5.5, Appendix B.5)
# Parameters: ~200K (67K per head × 3)
# No temporal context — ablation baseline
# ─────────────────────────────────────────────────────────────

class _MLPHead(nn.Module):
    def __init__(self, input_dim: int, hidden_dim: int, output_dim: int, dropout: float):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, output_dim),
            nn.GELU(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class PrudenceE_EnsembleMLP(nn.Module):
    """
    3 independent MLP sub-heads on the CURRENT embedding only (no temporal context).
    Voting: mean for gate_probabilities, min(confidence) for most-cautious wins.

    Pipeline:
      Input:  [batch, 512] — current situation embedding ONLY
      Head1:  MLP(512→128→64)
      Head2:  MLP(512→128→64)
      Head3:  MLP(512→128→64)
      Vote:   gate = mean(heads); confidence = min(heads); ambiguity = max(heads)

    This architecture is a no-temporal ablation baseline (paper §5.5).
    In an ensemble, it acts as a canary: if it disagrees with the temporal
    architectures, the situation is likely novel or out-of-distribution.
    """

    def __init__(
        self,
        input_dim: int = 512,
        hidden_dim: int = 128,
        head_output_dim: int = 64,
        n_heads: int = 3,
        dropout: float = 0.1,
    ):
        super().__init__()
        self.n_heads = n_heads
        self.heads = nn.ModuleList([
            _MLPHead(input_dim, hidden_dim, head_output_dim, dropout)
            for _ in range(n_heads)
        ])
        self.gate_heads = nn.ModuleList([nn.Linear(head_output_dim, 3) for _ in range(n_heads)])
        self.conf_heads = nn.ModuleList([nn.Linear(head_output_dim, 1) for _ in range(n_heads)])
        self.amb_heads = nn.ModuleList([nn.Linear(head_output_dim, 1) for _ in range(n_heads)])

    def forward(
        self,
        sequence: Optional[torch.Tensor] = None,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        """
        Args:
            sequence: [batch, K, 512] — only last position used
            current:  [batch, 512]    — takes priority if provided
        """
        if current is None:
            if sequence is not None:
                current = sequence[:, -1, :]
            else:
                raise ValueError("PrudenceE_EnsembleMLP requires 'current' or 'sequence'")

        gate_list, conf_list, amb_list = [], [], []
        for i in range(self.n_heads):
            f = self.heads[i](current)
            gate_list.append(torch.softmax(self.gate_heads[i](f), dim=-1))
            conf_list.append(torch.sigmoid(self.conf_heads[i](f)))
            amb_list.append(torch.sigmoid(self.amb_heads[i](f)))

        # Conservative voting: most cautious wins on confidence
        gate_probs = torch.stack(gate_list).mean(dim=0)
        confidence = torch.stack(conf_list).min(dim=0).values
        ambiguity = torch.stack(amb_list).max(dim=0).values

        return {
            "gate_probabilities": gate_probs,
            "confidence": confidence,
            "ambiguity": ambiguity,
        }
