# Total Recall

> Yesterday's chat got compacted away? Per-session event store with FTS + vector recall — pulled back on demand.

Context compaction silently drops the messages that matter most by the time you wish they were still there. ENGRAM catches them on the way out.

Every assistant response is ingested into a per-session event store with full-text search and Ollama-powered vector embeddings (`mxbai-embed-large` by default). Before each prompt, the most relevant past events are retrieved and injected as a `## Retrieved Memory Context` block within a tunable token budget (default `2000`). Messages about to be lost to compaction are persisted _first_ via `before_compaction`, so nothing important disappears. The agent gets a `recall` tool for explicit memory queries. Pointer compaction keeps storage efficient at scale; null retention means the engram is yours forever.

## Install

```bash
openclaw plugins install @globalcaos/openclaw-total-recall
```

Pull the embedding model: `ollama pull mxbai-embed-large`. Then enable in `openclaw.json`:

```json
"plugins": {
  "allow": ["tinkerclaw-total-recall"],
  "entries": { "tinkerclaw-total-recall": { "enabled": true } }
}
```

## Evicted tool output comes back with one call

When the context passes 80% of the window, TinkerClaw takes old, large tool results (command logs, fetched pages, file reads) off the desk and leaves a marker in their place:

```
[Evicted exec output (50,028 chars, 2,502 lines), from "$ make build" to "BUILD OK in 41s". The whole result is kept in this chat's transcript; recall({"id":"call-1"}) brings it back.]
```

The quotes are exact lines from the result, so the agent can also search for them. `recall({ id })` returns the whole result from the chat's transcript, which eviction never edits. A long one comes back in pages of 20,000 characters: pass `offset` (the `nextOffset` of the last page) and, if you like, `length` (at most 100,000). The same call takes a transcript entry id. It reads only the calling chat's own transcript.

Nothing to configure: eviction runs in the embedded agent runner and is on by default (`ENGRAM_TOOL_EVICTION=0` in the gateway's environment turns it off). The agent needs the `recall` tool, so add `recall` to `tools.alsoAllow`. Chats on a CLI lane (claude-code and other CLI backends) keep their own context, so eviction does not reach them.

## Pairs Well With

- **[@globalcaos/openclaw-memory-enhancements](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-memory-enhancements)** — the hippocampus index makes ENGRAM lookups O(1) on known concepts. Big speedup once the corpus grows past a few thousand events.
- **[@globalcaos/openclaw-identity-persistence](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-identity-persistence)** — your SOUL.md shapes what's worth remembering. ENGRAM stores the events; CORTEX makes sure recall stays in character.
- **[@globalcaos/openclaw-round-table](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-round-table)** — debate traces flow into the same engram. The agent stops rehashing questions the panel already answered last week.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
