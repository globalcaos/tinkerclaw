# AMYGDALA Training Guide

## Network Families

AMYGDALA uses two families of lightweight ONNX neural networks:

### Prudence Networks (Public — Safety)

Five networks (prudence-a through prudence-e) trained to gate dangerous actions. These are **publicly available** and can be downloaded from the release artifacts.

- **Purpose:** Block actions matching historical failure patterns before the LLM finishes reasoning
- **Input:** 384-d situation embedding (frozen mxbai-embed-large encoder)
- **Output:** Block probability (0.0 = safe, 1.0 = dangerous)
- **Training data:** Operational incident logs — destructive file operations, unsafe git commands, credential exposures
- **Size:** ~50KB per network

**To use pre-trained prudence models:**

```bash
# Download from release artifacts
mkdir -p models/amygdala/
# Place prudence-a.onnx through prudence-e.onnx in models/amygdala/
```

### Personality Networks (Private — Behavioral)

Five networks (personality-a through personality-e) that modulate agent behavior per-user. These are **private** — they encode your specific interaction patterns and preferences. You must train your own.

- **Purpose:** Adapt tone, verbosity, tool preferences, and communication style to the specific user
- **Input:** 384-d situation embedding
- **Output:** Behavioral modulation vector
- **Training data:** Your agent's operational logs — successful interactions, user corrections, preference signals
- **Size:** ~50KB per network

## Training From Scratch

### Prerequisites

- Python 3.10+
- PyTorch
- ONNX Runtime
- Training data: operational logs in JSONL format

### Data Format

Each training sample is a JSON object:

```json
{
  "situation": "tool=Bash args='rm -rf /tmp/cache' session=agent:main:main",
  "label": 1,
  "category": "destructive_operation"
}
```

For prudence: `label=1` means "should have been blocked", `label=0` means "safe action."
For personality: labels are behavioral preference scores (0.0–1.0).

### Training Pipeline

```bash
cd training/amygdala/

# 1. Generate situation embeddings from operational logs
python generate_embeddings.py \
  --input ~/.openclaw/workspace/memory/knowledge/ \
  --output data/embeddings.npz \
  --model mxbai-embed-large

# 2. Train prudence networks (safety)
python train_prudence.py \
  --embeddings data/embeddings.npz \
  --labels data/prudence_labels.jsonl \
  --output models/prudence \
  --epochs 100

# 3. Train personality networks (behavioral)
python train_personality.py \
  --embeddings data/embeddings.npz \
  --labels data/personality_labels.jsonl \
  --output models/personality \
  --epochs 100

# 4. Export to ONNX
python export_onnx.py \
  --checkpoint models/prudence/best.pt \
  --output ../../models/amygdala/prudence-a.onnx

# 5. Validate
python validate_onnx.py --model ../../models/amygdala/prudence-a.onnx
```

### Conformal Prediction Calibration

After training, calibrate uncertainty bounds:

```bash
python calibrate_conformal.py \
  --model models/prudence/best.pt \
  --calibration_data data/calibration.jsonl \
  --alpha 0.05
```

This ensures the model's confidence intervals are statistically valid.

## Phase Deployment

| Phase       | Behavior                      | Risk                             |
| ----------- | ----------------------------- | -------------------------------- |
| 1 (observe) | Log decisions, don't block    | Zero — passive monitoring        |
| 2 (warn)    | Block + require user approval | Low — user confirms              |
| 3 (enforce) | Block automatically           | Medium — may block valid actions |

Start at phase 1. Review logs. Promote to phase 2 when false positive rate < 5%.

## Rule-Based Fallback

When ONNX models are unavailable, AMYGDALA falls back to rule-based heuristics:

- Blocks `rm -rf` patterns
- Blocks `git push --force` to main/master
- Blocks credential file modifications
- Warns on `DROP TABLE`, `DELETE FROM` without WHERE

This fallback ensures safety even without trained models.
