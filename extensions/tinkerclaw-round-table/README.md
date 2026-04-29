# Round Table

> Three models, one answer — cheaper than calling Opus once. RAAC debate protocol with cognitive diversity scoring.

Hard problems aren't decided by one expensive model thinking longer. They're decided by three or more models with different reasoning styles arguing it out.

The plugin exposes a `synapse_debate` tool the agent can call on any question where one perspective isn't enough. The tool selects 3–5 model profiles chosen for cognitive diversity (logical, creative, critical, systematic, integrative), assigns adversarial roles, and runs the 5-phase RAAC protocol: Propose → Challenge → Defend → Synthesize → Ratify. Convergence is detected when the synthesis stabilizes. The result is a confidence-scored consensus (0.3–1.0) with full debate traces, dissenting opinions, and action items. Three Sonnets debating beats one Opus alone on most non-trivial questions, at a fraction of the cost.

## Install

```bash
openclaw plugins install @globalcaos/openclaw-round-table
```

Enable it in `openclaw.json`:

```json
"plugins": {
  "allow": ["tinkerclaw-round-table"],
  "entries": { "tinkerclaw-round-table": { "enabled": true } }
}
```

## Pairs Well With

- **[@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — debate traces persist in ENGRAM instead of a local JSONL. Your agent recalls past arguments and stops re-deliberating questions it already settled.
- **[@globalcaos/openclaw-learned-intuition](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-learned-intuition)** — synthesis is just text until it ships as an action. AMYGDALA vetoes risky ratifications before the panel's confidence translates to a tool call.
- **[@globalcaos/openclaw-fractal-reflection](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-fractal-reflection)** — what surprised the panel? The four-level reflection runs after the debate so the agent learns the meta-pattern, not just the answer.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
