# Learned Intuition

> A deterministic rule floor, a novelty sense that habituates, and an incongruity check — a safety layer that observes before it ever blocks.

AMYGDALA v3.1 sits between your agent and the rest of your system. It watches tool calls and says, in effect, "that one is different, are you sure?"

Three signals, none of which needs a model file:

- **AEGIS** — deterministic destructive-action rules (the `rm -rf /`, `DROP TABLE` tier). This is the floor, and it is the only tier that can hard-block — once you set `observeOnly: false`.
- **Novelty (k-NN)** — an embedding-space "I have not seen anything like this before" channel that habituates as experience accumulates, so it stops crying wolf about your normal work.
- **Incongruity** — a clause-cosine check on the prompt itself: when the action and its stated purpose don't cohere ("build a chess game so I can water my plants"), it surfaces an *ask*, never a block.

**It observes by default — AEGIS included.** `observeOnly` is `true`, so no tool call is blocked: every match, AEGIS hard-block matches too, is logged as "would block" and the call goes ahead. Set `observeOnly: false` when you have read the log and trust it; from then on AEGIS matches are blocked, and neural soft-blocks are blocked too once `phase` is 2 or higher.

### About the five neural networks

Earlier versions of this plugin ran a 5-net ONNX prudence/personality ensemble on every tool call. **It is retired from the decision path** and off by default: it was trained on mislabelled data, and the frozen-MiniLM danger classification measured *below chance*. Saying so is more useful than shipping it quietly. `legacyEnsemble: true` puts it back if you want to reproduce the result; the embedding pipeline is retained for novelty either way.

## Install

```bash
openclaw plugins install @globalcaos/tinker-learned-intuition
```

Enable it in `openclaw.json`:

```json
"plugins": {
  "allow": ["tinkerclaw-learned-intuition"],
  "entries": { "tinkerclaw-learned-intuition": { "enabled": true } }
}
```

Optional — drop the public Prudence ONNX models into `~/src/tinkerclaw/models/amygdala/onnx/`. Without them the deterministic rule gate runs alone and the plugin loads cleanly anywhere.

## Pre-execution enforcement is opt-in

`hookEnforcement` is the broadest thing this plugin can do, so it is **off by default**. When you set it to `true` it:

1. stages a hook script into `~/.openclaw/data/amygdala/`, and
2. writes `~/.openclaw/data/amygdala/cc-hook-settings.json` — a claude-cli settings file registering a **`PreToolUse` hook with matcher `"*"`**.

tinker-bridge then passes that file via `--settings` on **every** spawn, where the hook can synchronously **deny** a tool call — including under `bypassPermissions`. That is a real safety gate and it is why some people want it; it is also a machine-wide interception installed by a plugin, which is why it should be a decision you make rather than a side effect of installing something.

```json
"config": { "hookEnforcement": true }
```

Setting it back to `false` writes no settings file and deletes any existing one, leaving the observe-only spool intact. This hook is governed by `hookEnforcement` alone, not by `observeOnly`.

## Config

| key | default | what it does |
|---|---|---|
| `aegisEnabled` | `true` | Evaluate the deterministic rule floor. In-process only; adds no hooks and mutates no prompt. Blocks only when `observeOnly` is `false`. |
| `observeOnly` | `true` | Log what would have been blocked instead of blocking it — applies to AEGIS and neural blocks alike. |
| `phase` | `1` | With `observeOnly: false`: 1 = only AEGIS blocks; 2+ = neural soft-blocks block too. |
| `alphaPrudence` | `0.0` | Prudence weight on the trust model. 0.0 = neutral. |
| `hookEnforcement` | `false` | Opt-in pre-execution `PreToolUse` deny hook (see above). |
| `personalityNudge` | `false` | Opt-in. Writes a nudge to `~/.openclaw/cognitive/personality-nudge.json` for Identity Persistence to inject — text meant to steer the model, so it is a prompt mutation with an extra step. Needs the ONNX personality models. |
| `legacyEnsemble` | `false` | Put the retired 5-net ensemble back in the decision path. |
| `modelsDir` | `~/src/tinkerclaw/models/amygdala` | Where the ONNX models live. |

## What it writes locally

- `~/.openclaw/data/amygdala/` — `policy.json`, `training.sqlite` (when `better-sqlite3` is installed), `hook-decisions.jsonl`, and, only with `hookEnforcement`, the hook script and `cc-hook-settings.json`.
- `~/.openclaw/data/amygdala-decisions.jsonl` — the decision log.
- `~/.openclaw/cognitive/learned-intuition.json` — status for other plugins; `personality-nudge.json` only with `personalityNudge`.
- It watches git state under `~/src` for situation context (via `chokidar`, when installed).

## Pairs Well With

- **[@globalcaos/tinker-identity-persistence](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-identity-persistence)** — with `personalityNudge` on both sides, failure-derived nudges feed persona re-injection. The agent doesn't just bounce off vetoes; it changes shape.
- **[@globalcaos/tinker-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — every veto becomes an indexed event. Patterns emerge across sessions instead of fading the moment context compacts.
- **[@globalcaos/tinker-round-table](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-round-table)** — risky synthesis from a multi-model debate? AMYGDALA flags the ratification before the agent ships the action.

## Changelog

- **0.1.2** — `observeOnly` (default `true`) now also covers AEGIS hard-blocks, so the default blocks nothing; README install name fixed to `@globalcaos/tinker-learned-intuition`; the package now ships the `src/` and `hook/` files that `index.ts` imports.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
