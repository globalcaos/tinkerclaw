# Identity Persistence

> All agents drift from their persona — we measure it with EWMA SyncScore, re-inject your persona file before it's gone.

You wrote a persona. By turn 30 the agent sounds like every other LLM. CORTEX won't let that happen.

**This plugin is off until you turn it on, and it needs a persona file you wrote.** It never invents one for you.

Once enabled, the persona is loaded at startup and prepended to the system context of **every** prompt — your agent never wakes up not knowing who it is. Every N turns (default 10) an EWMA SyncScore evaluates how far recent output has drifted; when it falls below threshold (default `0.6`), the persona block is re-injected mid-context automatically. Behavioral observations are extracted to a JSONL log at `~/.openclaw/cortex/observations.jsonl` so you can see exactly when and why drift happens.

## Install

```bash
openclaw plugins install @globalcaos/tinker-identity-persistence
```

Write your persona to `~/.openclaw/workspace/SOUL.md` (or anywhere, and point `personaPath` at it). Then enable it in `openclaw.json` — **both** the entry and `config.enabled` are required:

```json
"plugins": {
  "allow": ["tinkerclaw-identity-persistence"],
  "entries": {
    "tinkerclaw-identity-persistence": {
      "enabled": true,
      "config": {
        "enabled": true,
        "personaPath": "~/.openclaw/workspace/SOUL.md"
      }
    }
  }
}
```

If `config.enabled` is not `true`, or the persona file does not exist, the plugin registers **no hooks at all** and logs why. An explicitly configured `personaPath` that does not exist is treated as a configuration error — it does not fall back to the default path and substitute a different persona.

## What it reads, writes and changes

|             |                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reads**   | your persona file (`personaPath`, default `~/.openclaw/workspace/SOUL.md`), plus `~/.openclaw/workspace/IDENTITY.md`, `~/.openclaw/persona.json` and `~/.openclaw/engram/persona-state.json` when present                                    |
| **Mutates** | the **system context of every prompt**, by prepending the rendered persona block; re-injects it mid-context on drift                                                                                                                         |
| **Writes**  | `~/.openclaw/cognitive/identity-persistence.json` (shared state), `~/.openclaw/cortex/observations.jsonl` (extracted observations), `~/.openclaw/cortex/sync-score-log.jsonl` and `~/.openclaw/engram/sync-score-log.json` (drift telemetry) |
| **Never**   | creates, bootstraps or overwrites a persona file                                                                                                                                                                                             |

The bootstrap persona ships with **no hard rules** and a neutral name. Everything the agent is told about who it is comes from your file.

### `personalityNudge` (off by default)

The **Learned Intuition** plugin can write a personality nudge to `~/.openclaw/cognitive/personality-nudge.json`. Setting `personalityNudge: true` folds that file into the injected system context too. It is a second prompt mutation sourced from a file this plugin does not own, so it is opt-in separately — enabling persona injection is not consent to inject whatever another plugin last wrote to disk.

## Config

| key                  | default                         | what it does                                           |
| -------------------- | ------------------------------- | ------------------------------------------------------ |
| `enabled`            | `false`                         | Master opt-in. While false, no hooks are registered.   |
| `personaPath`        | `~/.openclaw/workspace/SOUL.md` | Your persona markdown. Must already exist.             |
| `syncScoreThreshold` | `0.6`                           | EWMA SyncScore below which the persona is re-injected. |
| `evaluationInterval` | `10`                            | Evaluate SyncScore every N turns.                      |
| `personalityNudge`   | `false`                         | Also inject the AMYGDALA nudge file (see above).       |

## Pairs Well With

- **[@globalcaos/openclaw-learned-intuition](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-learned-intuition)** — failure-derived personality nudges can flow into persona re-injections (opt in with `personalityNudge`). Your agent doesn't just dodge bad actions; the patterns reshape who it is.
- **[@globalcaos/openclaw-computational-humor](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-computational-humor)** — persona-aware humor. Your persona file tells LIMBIC what flavor of jokes match your agent, instead of generic LLM banter.
- **[@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — episodic memory shaped by persona. ENGRAM stores the events; CORTEX makes sure recall stays in character.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
