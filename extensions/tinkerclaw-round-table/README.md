# Round Table

> Multi-model adversarial debate via RAAC protocol with cognitive diversity scoring.

**Paper:** J6 — Multi-Model Adversarial Debate (SYNAPSE)
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

Exposes a `synapse_debate` tool the agent can invoke on any question where a single perspective is insufficient. The tool runs a structured 5-phase deliberation (Propose → Challenge → Defend → Synthesize → Ratify) across multiple model profiles chosen for cognitive diversity. The result is a confidence-scored consensus with full debate traces, dissenting opinions, and action items. On hard problems, this pattern reliably outperforms larger single-model calls at a fraction of the cost.

## Install

1. Copy this folder to `~/.openclaw/workspace/extensions/tinkerclaw-round-table/`
2. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["tinkerclaw-round-table"],
    "entries": {
      "tinkerclaw-round-table": {
        "enabled": true,
        "config": {
          "defaultDepth": "standard",
          "maxRounds": 6
        }
      }
    }
  }
}
```

3. Restart gateway

## Configuration

| Key            | Default      | Description                                                          |
| -------------- | ------------ | -------------------------------------------------------------------- |
| `defaultDepth` | `"standard"` | Default debate depth: `quick` (2 rounds), `standard` (4), `deep` (6) |
| `maxRounds`    | `6`          | Hard cap on debate rounds regardless of depth setting                |

## Dependencies

- Required: none
- Optional: Total Recall — debate traces are stored in its event store when active; otherwise falls back to `~/.openclaw/synapse/traces.jsonl`

## How It Works

The extension registers a single `synapse_debate` tool. When called, it selects 3–5 provider profiles with diverse strengths (logical, creative, critical, systematic, integrative), assigns adversarial roles, and runs the RAAC protocol. Each round participants propose, challenge each other's proposals, defend against attacks, synthesize across positions, and vote to ratify or amend. Convergence is detected when the synthesis stabilizes. The final result includes a confidence score (0.3–1.0), consensus text, dissenting votes, and round-by-round traces. Traces are persisted via Total Recall if available, or written to a local JSONL file. Shared state is written to `~/.openclaw/cognitive/round-table.json`.
