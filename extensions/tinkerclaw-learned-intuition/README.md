# Learned Intuition

> Five neural networks vote yes/no on every tool call — trained on real failures, rules fallback if models miss.

A pattern-matching layer between your agent and the rest of your system, trained on what actually went wrong before.

The AMYGDALA layer intercepts every tool call via `before_tool_call` and runs it through five Prudence ONNX networks (the public, downloadable family) plus an optional five Personality networks (private — train your own). The Prudence ensemble aggregates via weighted meta-vote; if any single model crosses the conservative override threshold (`0.9`) or model disagreement spikes, the cautious vote wins. Phase 1 is observe-only — the gate logs what it would have blocked but never stops anything. Phase 2+ enables active blocking. If ONNX models aren't present, a rule-based heuristic gate kicks in automatically so the plugin loads cleanly anywhere.

## Install

```bash
openclaw plugins install @globalcaos/openclaw-learned-intuition
```

Optional — drop the public Prudence ONNX models into `~/src/tinkerclaw/models/amygdala/onnx/`. Then enable in `openclaw.json`:

```json
"plugins": {
  "allow": ["tinkerclaw-learned-intuition"],
  "entries": { "tinkerclaw-learned-intuition": { "enabled": true } }
}
```

## Pairs Well With

- **[@globalcaos/openclaw-identity-persistence](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-identity-persistence)** — failure-derived nudges feed SOUL.md re-injection. The agent doesn't just bounce off vetoes; it changes shape.
- **[@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — every veto becomes an indexed event. Patterns emerge across sessions instead of fading the moment context compacts.
- **[@globalcaos/openclaw-round-table](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-round-table)** — risky synthesis from a multi-model debate? AMYGDALA vetoes the ratification before the agent ships the action.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
