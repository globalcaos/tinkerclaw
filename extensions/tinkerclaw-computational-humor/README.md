# Computational Humor

> Humor generation via embedding geometry — bridge discovery between distant concepts.

**Paper:** J7 — Humor from Bisociation
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

Adds an emotional and social intelligence layer that gives the agent a calibrated sense of humor. It discovers bridges between semantically distant concepts in embedding space (bisociation), gating attempts through a sensitivity threshold to avoid misfires. Positive user reactions (laughter, emoji, affirmation) are captured and fed back into the calibration loop so humor improves over time. Setting `frequency` to `off` disables the extension entirely with zero overhead.

## Install

1. Copy this folder to `~/.openclaw/workspace/extensions/tinkerclaw-computational-humor/`
2. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["tinkerclaw-computational-humor"],
    "entries": {
      "tinkerclaw-computational-humor": {
        "enabled": true,
        "config": {
          "frequency": "low",
          "sensitivityThreshold": 0.8,
          "embeddingProvider": "ollama"
        }
      }
    }
  }
}
```

3. Restart gateway

## Configuration

| Key                    | Default    | Description                                                                 |
| ---------------------- | ---------- | --------------------------------------------------------------------------- |
| `frequency`            | `"low"`    | Humor attempt rate: `off`, `low` (10%), `medium` (25%), `high` (50%)        |
| `sensitivityThreshold` | `0.8`      | Minimum bridge strength to attempt humor (0.0–1.0, higher = more selective) |
| `embeddingProvider`    | `"ollama"` | Embedding provider used for concept bridge discovery                        |

## Dependencies

- Required: none (starts with FNV-1a hash fallback; upgrades asynchronously when Ollama is available)
- Optional: Ollama — enables full embedding-geometry bridge discovery. Identity Persistence — provides persona humor calibration (preferred patterns, audience model) from `~/.openclaw/cognitive/identity-persistence.json`

## How It Works

Two hooks are registered. `before_prompt_build` increments a turn counter, evaluates the current humor calibration state (pending attempts, known associations, preferred bisociation patterns), and appends a compact `[LIMBIC humor calibration: ...]` context line to the system prompt so the LLM knows its humor parameters. The `llm_output` hook scans the next user message for positive reaction signals (laugh tokens, emoji, affirmations) and, if a pending humor attempt ID is active, records the reaction to recalibrate future attempts. Humor settings from Identity Persistence are read at startup from `~/.openclaw/cognitive/identity-persistence.json`. Shared state is written to `~/.openclaw/cognitive/computational-humor.json`.
