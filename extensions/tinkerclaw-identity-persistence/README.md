# Identity Persistence

> All agents drift from their persona — we measure it with EWMA SyncScore, re-inject SOUL.md before it's gone.

You wrote a SOUL.md. By turn 30 the agent sounds like every other LLM. CORTEX won't let that happen.

The persona is loaded from `~/.openclaw/SOUL.md` at startup and prepended to every prompt at top priority — your agent never wakes up not knowing who it is. Every N turns (default 10) an EWMA SyncScore evaluates how far recent output has drifted; when it falls below threshold (default `0.6`), the persona block is re-injected mid-context automatically. Behavioral observations are extracted to a JSONL log at `~/.openclaw/cortex/observations.jsonl` so you can see exactly when and why drift happens. Personality nudges from Learned Intuition (if active) fold in before injection.

## Install

```bash
openclaw plugins install @globalcaos/openclaw-identity-persistence
```

Drop a persona at `~/.openclaw/SOUL.md` — a default is bootstrapped if absent. Then enable in `openclaw.json`:

```json
"plugins": {
  "allow": ["tinkerclaw-identity-persistence"],
  "entries": { "tinkerclaw-identity-persistence": { "enabled": true } }
}
```

## Pairs Well With

- **[@globalcaos/openclaw-learned-intuition](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-learned-intuition)** — failure-derived personality nudges flow into SOUL.md re-injections. Your agent doesn't just dodge bad actions; the patterns reshape who it is.
- **[@globalcaos/openclaw-computational-humor](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-computational-humor)** — persona-aware humor. Your SOUL.md tells LIMBIC what flavor of jokes match your agent, instead of generic LLM banter.
- **[@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — episodic memory shaped by persona. ENGRAM stores the events; CORTEX makes sure recall stays in character.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
