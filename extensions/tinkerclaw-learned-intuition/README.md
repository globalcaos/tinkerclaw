# Learned Intuition

> Neural safety gate trained on real failures. Evaluates every tool call through 10 ONNX networks.

**Paper:** J11 — Learned Intuition (AMYGDALA)
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

Intercepts every tool call via `before_tool_call` and evaluates it through two families of ONNX networks: Prudence (safety gate — public, downloadable) and Personality (behavioral calibration — private, train your own). Phase 1 is observe-only: the gate logs what it would have blocked but never stops anything. Phase 2+ enables active blocking. Falls back to a rule-based heuristic gate when ONNX models are not available, so the plugin loads cleanly on any system.

## Install

1. Copy this folder to `~/.openclaw/workspace/extensions/tinkerclaw-learned-intuition/`
2. (Optional) Download Prudence ONNX models and place them at `~/src/tinkerclaw/models/amygdala/onnx/`
3. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["tinkerclaw-learned-intuition"],
    "entries": {
      "tinkerclaw-learned-intuition": {
        "enabled": true,
        "config": {
          "phase": 1,
          "alphaPrudence": 0.0,
          "aegisEnabled": false,
          "observeOnly": true,
          "modelsDir": "~/src/tinkerclaw/models/amygdala"
        }
      }
    }
  }
}
```

4. Restart gateway

## Configuration

| Key             | Default                            | Description                                                     |
| --------------- | ---------------------------------- | --------------------------------------------------------------- |
| `phase`         | `1`                                | Deployment phase: 1 = observe-only, 2+ = active blocking        |
| `alphaPrudence` | `0.0`                              | Trust weight for Prudence models (0.0–0.15)                     |
| `aegisEnabled`  | `false`                            | Enable AEGIS extended safety checks                             |
| `observeOnly`   | `true`                             | Override to always observe without blocking regardless of phase |
| `modelsDir`     | `~/src/tinkerclaw/models/amygdala` | Path to ONNX models directory                                   |

## Dependencies

- Required: none (rule-based fallback activates automatically when ONNX models are absent)
- Optional: ONNX models in `modelsDir/onnx/` — five Prudence models (`prudence_a` through `prudence_e`) for neural safety evaluation, and five Personality models for behavioral calibration (private, must train separately)

## How It Works

On startup the extension attempts to load ONNX models from `modelsDir`. If unavailable, it activates the rule-based gate and logs a warning. The `before_tool_call` hook (priority 10, evaluated early) extracts the tool name, target path or command, and args, then feeds them into the gate. The Prudence ensemble runs five models and aggregates via weighted meta-ensemble; if any model exceeds `conservative_override_threshold` (0.9) or model disagreement exceeds threshold, the conservative vote wins. In phase 1 or `observeOnly` mode, blocked actions are only logged. In phase 2+, the hook returns `{ abort: true }` to stop the tool call. The `llm_output` hook generates personality nudges from the target behavioral vector and writes them to `~/.openclaw/cognitive/personality-nudge.json` for Identity Persistence to read.
