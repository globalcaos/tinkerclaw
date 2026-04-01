# Fractal Reflection

> Post-turn self-reflection with 4-level framework. The agent reflects on what it did, finds patterns, and improves.

**Paper:** J3 — Fractal Memory Index
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

After each successful interactive turn, the agent injects a structured self-reflection prompt covering four abstraction levels: specific (what just happened), pattern (what this fits into), system (how this connects to broader context), and worldview (what it means for long-term behavior). Automated sessions (subagent, cron, heartbeat) are skipped. A per-session debounce prevents noise on rapid turns.

## Install

1. Copy this folder to `~/.openclaw/workspace/extensions/tinkerclaw-fractal-reflection/`
2. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["tinkerclaw-fractal-reflection"],
    "entries": {
      "tinkerclaw-fractal-reflection": {
        "enabled": true,
        "config": {
          "debounceMs": 30000,
          "enabled": true
        }
      }
    }
  }
}
```

3. Restart gateway

## Configuration

| Key          | Default | Description                                          |
| ------------ | ------- | ---------------------------------------------------- |
| `enabled`    | `true`  | Enable or disable the extension                      |
| `debounceMs` | `30000` | Minimum milliseconds between reflections per session |

## Dependencies

- Required: none
- Optional: none

## How It Works

The extension registers an `agent_end` hook that fires after each successful interactive agent run. It reads the reflection prompt template from `fractal-prompt.md` inside the extension directory, then injects it into the session via `callGateway("sessions.send")` — the same path used by the `sessions_send` tool. A per-session timestamp map enforces the debounce window. The hook runs fire-and-forget so it never blocks the agent lifecycle.
