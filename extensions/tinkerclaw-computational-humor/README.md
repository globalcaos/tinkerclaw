# Computational Humor

> Your agent jokes. You laugh — it remembers. Humor from embedding geometry, calibrated by your reactions.

Most agents are funny by accident. This one is funny on purpose, and gets funnier.

When the LIMBIC layer notices two semantically distant concepts that bridge in embedding space — the bisociation behind every good joke — it considers attempting humor. A sensitivity threshold (default `0.8`) filters misfires. The next user message is scanned for laughter, emoji, affirmations, or dead air; that signal is captured and fed back into calibration so future attempts lean toward what actually lands. Frequency knobs go from `off` (zero overhead) to `high` (50% turn rate). Persona-aware humor preferences are read from Identity Persistence at startup if it's installed.

In the Tinker chat, three small chips sit under each reply that has a spoken line: laughed, neutral, not now. One tap records how the line landed, and a tap outranks anything read from your next message. Each recorded line is also marked joke or plain. Jev decides that, and only when Thalamus is already allowed to send real text to Jev (`jev.sendRealSituations`). It then gets the one line, redacted, and nothing else from the chat. Without that permission, or without a Jev token, nothing is sent and the line stays unmarked.

## Install

```bash
openclaw plugins install @globalcaos/openclaw-computational-humor
```

Enable it in `openclaw.json`:

```json
"plugins": {
  "allow": ["tinkerclaw-computational-humor"],
  "entries": { "tinkerclaw-computational-humor": { "enabled": true } }
}
```

## Pairs Well With

- **[@globalcaos/openclaw-identity-persistence](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-identity-persistence)** — your SOUL.md tells LIMBIC what flavor of humor matches the agent's persona, instead of generic LLM banter.
- **[@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — past laughter survives compaction. Calibration carries across sessions, not just within one.
- **[@globalcaos/openclaw-fractal-reflection](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-fractal-reflection)** — the agent reflects on what landed and what bombed; humor improves with the same loop that improves everything else.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
