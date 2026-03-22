"""
AMYGDALA Personality Network Architectures (A through E)
Paper: J11 — Learned Intuition, §5.1–§5.5, Appendix B.1–B.5

Mirrors the Prudence architecture family but produces a 64-dimensional continuous
behaviour embedding instead of a gate classification. The embedding captures
behavioural style: tone, proactivity, social calibration, etc.

Each network takes a temporal window of K=32 situation embeddings (512d each)
and optionally a target personality vector, producing:
  - behaviour_embedding: [batch, 64] — continuous style vector

All architectures are ONNX-exportable (opset 17, no dynamic control flow).
"""

import torch
import torch.nn as nn
from typing import Optional


# ─────────────────────────────────────────────────────────────
# Architecture A: GRU-MLP (paper §5.1, Appendix B.1)
# ─────────────────────────────────────────────────────────────

class PersonalityA_GRU_MLP(nn.Module):
    """
    GRU-MLP variant for personality embedding output.

    Pipeline:
      Input:  [batch, K=32, 512]
      Proj:   Linear(512 → 384)   — matches Prudence A parameter budget
      GRU:    input=384, hidden=128
      MLP:    128 → 64 → 32
      Head:   Linear(32 → 64)     — 64d behaviour embedding

    Target vector mechanism:
      If target_vector is provided at construction, it is concatenated with
      the MLP output before the embedding head, allowing the network to
      learn to pull its output toward the target personality.
    """

    def __init__(
        self,
        input_dim: int = 512,
        gru_input_dim: int = 384,
        hidden_dim: int = 128,
        mlp_hidden: int = 64,
        output_hidden: int = 32,
        embedding_dim: int = 64,
        dropout: float = 0.1,
        target_vector: Optional[torch.Tensor] = None,
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
        # Target vector input mechanism: inject target as conditioning signal
        target_dim = embedding_dim if target_vector is not None else 0
        self.embedding_head = nn.Linear(output_hidden + target_dim, embedding_dim)

        if target_vector is not None:
            self.register_buffer("target_vector", target_vector.float())
        else:
            self.target_vector = None

    def forward(
        self,
        sequence: torch.Tensor,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        x = self.input_proj(sequence)
        _, h_n = self.gru(x)
        features = self.mlp(h_n.squeeze(0))        # [batch, 32]

        if self.target_vector is not None:
            batch = features.size(0)
            tv = self.target_vector.unsqueeze(0).expand(batch, -1)
            features = torch.cat([features, tv], dim=-1)

        return {"behaviour_embedding": self.embedding_head(features)}


# ─────────────────────────────────────────────────────────────
# Architecture B: TCN (paper §5.2, Appendix B.2)
# ─────────────────────────────────────────────────────────────

class _CausalConv1d(nn.Module):
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
        if self.padding > 0:
            out = out[:, :, : -self.padding]
        return out


class _TCNBlock(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, ks: int, dilation: int, dropout: float):
        super().__init__()
        self.conv = _CausalConv1d(in_ch, out_ch, ks, dilation)
        self.norm = nn.LayerNorm(out_ch)
        self.act = nn.GELU()
        self.drop = nn.Dropout(dropout)
        self.residual = nn.Conv1d(in_ch, out_ch, 1) if in_ch != out_ch else nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.conv(x)
        out = self.act(self.norm(out.transpose(1, 2)).transpose(1, 2))
        return self.drop(out) + self.residual(x)


class PersonalityB_TCN(nn.Module):
    """
    TCN variant for personality embedding output.

    Same 4-layer dilated TCN as PrudenceB_TCN but produces 64d embedding.
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
        embedding_dim: int = 64,
        target_vector: Optional[torch.Tensor] = None,
    ):
        super().__init__()
        if dilations is None:
            dilations = [1, 2, 4, 8]

        layers = []
        in_ch = input_dim
        for i, d in enumerate(dilations):
            out_ch = output_channels if i == len(dilations) - 1 else hidden_channels
            layers.append(_TCNBlock(in_ch, out_ch, kernel_size, d, dropout))
            in_ch = out_ch
        self.tcn = nn.Sequential(*layers)
        self.fc = nn.Sequential(nn.Linear(output_channels, output_hidden), nn.GELU())

        target_dim = embedding_dim if target_vector is not None else 0
        self.embedding_head = nn.Linear(output_hidden + target_dim, embedding_dim)

        if target_vector is not None:
            self.register_buffer("target_vector", target_vector.float())
        else:
            self.target_vector = None

    def forward(
        self,
        sequence: torch.Tensor,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        x = sequence.transpose(1, 2)
        x = self.tcn(x)
        features = self.fc(x[:, :, -1])           # [batch, 32]

        if self.target_vector is not None:
            batch = features.size(0)
            tv = self.target_vector.unsqueeze(0).expand(batch, -1)
            features = torch.cat([features, tv], dim=-1)

        return {"behaviour_embedding": self.embedding_head(features)}


# ─────────────────────────────────────────────────────────────
# Architecture C: Transformer-Micro (paper §5.3, Appendix B.3)
# ─────────────────────────────────────────────────────────────

class _LearnedPosEnc(nn.Module):
    def __init__(self, max_len: int, d_model: int):
        super().__init__()
        self.pe = nn.Embedding(max_len, d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        positions = torch.arange(x.size(1), device=x.device).unsqueeze(0)
        return x + self.pe(positions)


class PersonalityC_Transformer(nn.Module):
    """
    Transformer-Micro variant for personality embedding output.

    2-layer, 4-head Transformer → 64d embedding.
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
        embedding_dim: int = 64,
        target_vector: Optional[torch.Tensor] = None,
    ):
        super().__init__()
        self.input_proj = nn.Linear(input_dim, d_model)
        self.pos_enc = _LearnedPosEnc(max_len, d_model)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=nhead, dim_feedforward=d_ff,
            dropout=dropout, activation="gelu", batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        self.fc = nn.Sequential(nn.Linear(d_model, output_hidden), nn.GELU())

        target_dim = embedding_dim if target_vector is not None else 0
        self.embedding_head = nn.Linear(output_hidden + target_dim, embedding_dim)

        if target_vector is not None:
            self.register_buffer("target_vector", target_vector.float())
        else:
            self.target_vector = None

    def forward(
        self,
        sequence: torch.Tensor,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        x = self.input_proj(sequence)
        x = self.pos_enc(x)
        x = self.encoder(x).mean(dim=1)            # [batch, 96]
        features = self.fc(x)                      # [batch, 32]

        if self.target_vector is not None:
            batch = features.size(0)
            tv = self.target_vector.unsqueeze(0).expand(batch, -1)
            features = torch.cat([features, tv], dim=-1)

        return {"behaviour_embedding": self.embedding_head(features)}


# ─────────────────────────────────────────────────────────────
# Architecture D: Dual-Encoder (paper §5.4, Appendix B.4)
# ─────────────────────────────────────────────────────────────

class PersonalityD_DualEncoder(nn.Module):
    """
    Dual-Encoder variant for personality embedding output.

    Cross-attention between proposed action and historical context
    to produce a context-aware 64d behaviour embedding.
    """

    def __init__(
        self,
        input_dim: int = 512,
        hidden_dim: int = 128,
        cross_heads: int = 4,
        output_hidden: int = 32,
        dropout: float = 0.1,
        embedding_dim: int = 64,
        target_vector: Optional[torch.Tensor] = None,
    ):
        super().__init__()
        self.action_encoder = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
        )
        self.context_gru = nn.GRU(input_dim, hidden_dim, 1, batch_first=True)
        self.cross_attn = nn.MultiheadAttention(
            embed_dim=hidden_dim, num_heads=cross_heads,
            dropout=dropout, batch_first=True,
        )
        self.fusion = nn.Sequential(
            nn.Linear(hidden_dim * 2, 64),
            nn.LayerNorm(64),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(64, output_hidden),
            nn.GELU(),
        )

        target_dim = embedding_dim if target_vector is not None else 0
        self.embedding_head = nn.Linear(output_hidden + target_dim, embedding_dim)

        if target_vector is not None:
            self.register_buffer("target_vector", target_vector.float())
        else:
            self.target_vector = None

    def forward(
        self,
        sequence: Optional[torch.Tensor] = None,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        if sequence is not None and current is None:
            current = sequence[:, -1, :]
            context = sequence[:, :-1, :]
        elif sequence is not None and current is not None:
            context = sequence
        else:
            raise ValueError("PersonalityD_DualEncoder requires 'sequence' or both inputs")

        q = self.action_encoder(current).unsqueeze(1)
        ctx, _ = self.context_gru(context)
        attended, _ = self.cross_attn(q, ctx, ctx)
        fused = torch.cat([q.squeeze(1), attended.squeeze(1)], dim=-1)
        features = self.fusion(fused)              # [batch, 32]

        if self.target_vector is not None:
            batch = features.size(0)
            tv = self.target_vector.unsqueeze(0).expand(batch, -1)
            features = torch.cat([features, tv], dim=-1)

        return {"behaviour_embedding": self.embedding_head(features)}


# ─────────────────────────────────────────────────────────────
# Architecture E: Ensemble MLP (paper §5.5, Appendix B.5)
# ─────────────────────────────────────────────────────────────

class _MLPSubHead(nn.Module):
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


class PersonalityE_EnsembleMLP(nn.Module):
    """
    3 independent MLP sub-heads; mean-pool their embedding outputs.

    No temporal context — ablation baseline.
    """

    def __init__(
        self,
        input_dim: int = 512,
        hidden_dim: int = 128,
        head_output_dim: int = 64,
        n_heads: int = 3,
        dropout: float = 0.1,
        embedding_dim: int = 64,
        target_vector: Optional[torch.Tensor] = None,
    ):
        super().__init__()
        self.n_heads = n_heads
        self.heads = nn.ModuleList([
            _MLPSubHead(input_dim, hidden_dim, head_output_dim, dropout)
            for _ in range(n_heads)
        ])

        target_dim = embedding_dim if target_vector is not None else 0
        self.emb_heads = nn.ModuleList([
            nn.Linear(head_output_dim + target_dim, embedding_dim)
            for _ in range(n_heads)
        ])

        if target_vector is not None:
            self.register_buffer("target_vector", target_vector.float())
        else:
            self.target_vector = None

    def forward(
        self,
        sequence: Optional[torch.Tensor] = None,
        current: Optional[torch.Tensor] = None,
    ) -> dict:
        if current is None:
            if sequence is not None:
                current = sequence[:, -1, :]
            else:
                raise ValueError("PersonalityE_EnsembleMLP requires 'current' or 'sequence'")

        embeddings = []
        for i in range(self.n_heads):
            f = self.heads[i](current)
            if self.target_vector is not None:
                batch = f.size(0)
                tv = self.target_vector.unsqueeze(0).expand(batch, -1)
                f = torch.cat([f, tv], dim=-1)
            embeddings.append(self.emb_heads[i](f))

        return {"behaviour_embedding": torch.stack(embeddings).mean(dim=0)}
