# Prefrontal

> Autonomous orchestration with live agent topology, effort routing, anti-goldplating, and CORF trigger.

**Paper:** J13 — PREFRONTAL: Compounded Intelligence
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

Acts as the executive control layer for the entire agent system. It tracks every running subagent in a live force-directed topology graph, routes tasks to models by effort tier (cheap for simple, expensive for complex), guards against over-engineered responses (anti-goldplating), fires clarifying questions before expensive work starts (forcing questions), and triggers a structured CORF debate when the agent is stuck in a denial loop. A live call tree is available at `GET /api/prefrontal/tree` and via the Tinker UI.

## Install

1. Copy this folder to `~/.openclaw/workspace/extensions/prefrontal/`
2. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["prefrontal"],
    "entries": {
      "prefrontal": {
        "enabled": true,
        "config": {
          "autoRoute": true,
          "maxConcurrentWorkers": 8,
          "monitorIntervalMs": 120000,
          "staleThresholdMs": 180000,
          "guardianStaleThresholdMs": 300000,
          "effortRouting": {
            "low": ["ollama/qwen3:latest"],
            "medium": ["anthropic/claude-haiku-4-5"],
            "high": ["anthropic/claude-sonnet-4-6"]
          },
          "featureFlags": {
            "explorationGate": true,
            "antiGoldplating": true,
            "forcingQuestions": true,
            "effortRouting": true,
            "corf": true,
            "faarTracking": true
          }
        }
      }
    }
  }
}
```

3. Restart gateway

## Configuration

| Key                        | Default  | Description                                           |
| -------------------------- | -------- | ----------------------------------------------------- |
| `enabled`                  | `true`   | Enable or disable the plugin                          |
| `autoRoute`                | `true`   | Automatically route tasks to models by effort tier    |
| `maxConcurrentWorkers`     | `8`      | Maximum parallel subagent workers                     |
| `monitorIntervalMs`        | `120000` | How often the monitor checks for stuck agents (ms)    |
| `staleThresholdMs`         | `180000` | Time before an agent is marked stale (ms)             |
| `guardianStaleThresholdMs` | `300000` | Time before guardian triggers recovery (ms)           |
| `effortRouting`            | —        | Model lists per effort tier (`low`, `medium`, `high`) |
| `model`                    | —        | Primary model for Prefrontal analysis                 |
| `summaryModel`             | —        | Model for topology summary generation                 |
| `pollIntervalMs`           | `5000`   | Session store enrichment poll interval (ms)           |
| `chatMinIntervalMs`        | `30000`  | Minimum interval for chat status broadcasts (ms)      |
| `chatMaxIntervalMs`        | `180000` | Maximum interval for chat status broadcasts (ms)      |
| `persistPath`              | —        | Path to persist topology state across restarts        |
| `featureFlags`             | —        | Object to enable/disable individual subsystems        |

## Dependencies

- Required: none — all subsystems degrade gracefully when their dependencies are absent
- Optional: All other cognitive plugins benefit from Prefrontal's orchestration. Session store enrichment requires the fork's `src/gateway/session-utils.js` but falls back silently on vanilla OpenClaw.

## How It Works

Prefrontal hooks into subagent lifecycle events (`subagent_spawned`, `subagent_ended`), LLM input/output, tool calls, and `agent_end` to maintain a live `TopologyStore` graph of all running agents. A background monitor polls for stale/stuck agents and broadcasts markdown status updates to the Tinker UI via `ChatEmitter`. Six independent subsystems are gated by feature flags: the Exploration Gate prevents redundant work before a task starts; Anti-Goldplating injects a conciseness prompt when it detects over-engineering patterns; Forcing Questions fires clarifying prompts before high-effort work; Effort Router validates that the model tier matches the task complexity; CORF Trigger detects denial-loop patterns and initiates a structured debate; FAAR Tracker logs task completion quality for long-term improvement. The HTTP handler serves the live call tree at `GET /api/prefrontal/tree`. Topology state is persisted on shutdown and reloaded on restart. Crash recovery state is read and cleared on startup.
