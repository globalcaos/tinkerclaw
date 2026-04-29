# Memory Enhancements

> Same concept, twentieth time — why search again? O(1) hippocampus index layered on upstream memory-core.

Upstream's `memory-core` is a solid chassis — hybrid FTS + vector + MMR + temporal decay, markdown-first source of truth. This plugin adds four layered wins without touching its source.

1. **Hippocampus O(1) concept index** _(live in v0.1)_ — pre-computed anchor → chunk map. When a query contains a known concept, retrieval skips the hybrid search entirely and returns in constant time. Upstream always pays the full FTS + vector + MMR cost; this plugin recognizes "we've seen this twenty times" and short-circuits.
2. **Task-conditioned retrieval scoring** _(scaffolded for v0.2)_ — biases retrieval toward the current task context, not just the query text. If the agent is fixing cron, results lean cron-shaped even when the immediate query doesn't say "cron".
3. **Contradiction-gate on writes** _(scaffolded for v0.2)_ — before the nightly deep-dreaming sweep promotes short-term recalls to durable `MEMORY.md`, candidates are checked against existing facts. `warn` logs; `block` vetoes the promotion. Stops slow self-corruption by wishful thinking.
4. **Compaction-aware capture** _(live in v0.1, ingestion landing in v0.2)_ — snapshots messages on the way out of the context window so nothing important is lost to truncation.

Remove the plugin and `memory-core` works exactly as upstream ships it. You just lose the four wins.

## Install

```bash
openclaw plugins install @globalcaos/openclaw-memory-enhancements
```

Enable it in `openclaw.json`:

```json
"plugins": {
  "allow": ["tinkerclaw-memory-enhancements"],
  "entries": { "tinkerclaw-memory-enhancements": { "enabled": true } }
}
```

## Pairs Well With

- **[@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — ENGRAM is the deeper episodic store; this plugin is the fast lookup. Use both for full coverage: O(1) by-concept on the head, retrieval-by-similarity over the long tail.
- **[@globalcaos/openclaw-identity-persistence](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-identity-persistence)** — the contradiction gate keeps your agent's self-model coherent. SOUL.md says one thing today; durable memory can't slowly disagree.
- **[@globalcaos/openclaw-fractal-reflection](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-fractal-reflection)** — reflections become candidate writes. The contradiction gate catches the ones that disagree with established memory before they become beliefs.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
