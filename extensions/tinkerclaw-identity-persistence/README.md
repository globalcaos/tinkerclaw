# Identity Persistence

> Maintains agent personality via SOUL.md injection, drift detection, and mid-context reinforcement.

**Paper:** J4 — Persona-Aware Context Engineering
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

Loads the agent's persona from a `SOUL.md` file and injects it into every prompt at the highest priority (100), ensuring the agent never forgets who it is. An EWMA SyncScore tracks persona drift across turns: when the score falls below the threshold, the persona block is re-injected mid-context automatically. The extension also reads personality nudges from Learned Intuition (if active) and extracts behavioral observations from LLM output to a JSONL log.

## Install

1. Create `~/.openclaw/SOUL.md` with your agent's persona (the extension bootstraps a default if absent)
2. Copy this folder to `~/.openclaw/workspace/extensions/tinkerclaw-identity-persistence/`
3. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["tinkerclaw-identity-persistence"],
    "entries": {
      "tinkerclaw-identity-persistence": {
        "enabled": true,
        "config": {
          "syncScoreThreshold": 0.6,
          "evaluationInterval": 10,
          "personaPath": "~/.openclaw/SOUL.md"
        }
      }
    }
  }
}
```

4. Restart gateway

## Configuration

| Key                  | Default               | Description                                       |
| -------------------- | --------------------- | ------------------------------------------------- |
| `syncScoreThreshold` | `0.6`                 | EWMA SyncScore below which persona is re-injected |
| `evaluationInterval` | `10`                  | Evaluate SyncScore every N turns                  |
| `personaPath`        | `~/.openclaw/SOUL.md` | Path to persona markdown file                     |

## Dependencies

- Required: `~/.openclaw/SOUL.md` persona file (auto-bootstrapped if absent)
- Optional: Learned Intuition — supplies personality nudge adjustments via `~/.openclaw/cognitive/personality-nudge.json`

## How It Works

Three hooks are registered. `before_prompt_build` (priority 100) reads `SOUL.md`, appends any active personality nudge from Learned Intuition, and prepends the combined block to the system prompt. A second `llm_output` hook evaluates the SyncScore every N turns using EWMA smoothing and triggers mid-context re-injection when drift is detected. A third `llm_output` hook runs an observation extractor that identifies behavioral signals in the agent's responses and appends them to a JSONL log at `~/.openclaw/cortex/observations.jsonl`. Shared state is written to `~/.openclaw/cognitive/identity-persistence.json` so Computational Humor can read persona humor settings.
