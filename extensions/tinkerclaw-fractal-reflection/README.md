# Fractal Reflection

> Your agent finishes the turn — then reflects on it across four levels: specific, pattern, system, worldview.

Most agents close a turn and move on. This one stops and asks itself four questions, in increasing abstraction.

After every successful interactive turn, a structured reflection prompt is injected into the session covering: what just happened (specific), what category of situation this was (pattern), how it fits into the broader system (system), and what it means for long-term behavior (worldview). Subagent runs, cron triggers, and heartbeats are skipped — only real interactive turns reflect. A per-session debounce (default 30s) stops noise on rapid turns. The hook is fire-and-forget so it never blocks the agent lifecycle.

## Install

```bash
openclaw plugins install @globalcaos/openclaw-fractal-reflection
```

Enable it in `openclaw.json`:

```json
"plugins": {
  "allow": ["tinkerclaw-fractal-reflection"],
  "entries": { "tinkerclaw-fractal-reflection": { "enabled": true } }
}
```

## Pairs Well With

- **[@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — reflections become indexed memories the agent recalls later. What worked stays accessible; what failed becomes a warning the next time around.
- **[@globalcaos/openclaw-identity-persistence](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-identity-persistence)** — reflections are framed against your SOUL.md, so the agent improves on its own terms instead of regressing toward generic LLM defaults.
- **[@globalcaos/openclaw-memory-enhancements](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-memory-enhancements)** — the contradiction gate catches reflections that disagree with what the agent already believes, before they pollute durable memory.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
