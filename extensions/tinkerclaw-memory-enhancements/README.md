# Memory Enhancements

> Four retrieval, write-safety, and compaction wins layered on upstream `memory-core`. Drop-in plugin. ClawHub-ready.

**Status:** v0.1 scaffold. Hippocampus O(1) concept index is live. Three other features are scaffolded and queued for v0.2.

**Designed for:** personal-assistant deployments where the same concepts (names, projects, places, recurring topics) keep coming up, and the agent is expected to never forget the compaction-adjacent turn, and where trust in promoted memories matters.

---

## What this plugin is

Upstream's `memory-core` is a solid chassis — hybrid FTS + vector + MMR + temporal decay, backed by a markdown-first source of truth with clean recovery behavior. It ships the fundamentals well.

This plugin adds four things on top that upstream doesn't do, without touching memory-core's code. It's a pure layered enhancement:

1. **Hippocampus O(1) concept index** — pre-computed anchor → chunk map. When the query contains a known concept, retrieval skips the hybrid search entirely and returns in constant time. Upstream always pays the full FTS + vector + MMR cost; this plugin recognizes "we've seen this concept 20 times" and short-circuits. Based on paper J2, production-deployed for 6+ months on the fork.
2. **Task-conditioned retrieval scoring** — biases retrieval scores by the current task context, not just the query text. If the agent is working on cron fixes, its retrieval leans toward cron-related memories even if the immediate query doesn't say "cron". Useful for multi-task personal agents where the same user keeps context switching.
3. **Contradiction-gate on writes** — before memory-core's nightly deep-dreaming sweep promotes a short-term recall to durable `MEMORY.md`, this plugin checks for contradictions against existing facts. In `warn` mode it logs; in `block` mode it vetoes the promotion. Stops the agent from slowly corrupting its own memory with wishful thinking.
4. **Compaction-aware capture** — before context compaction drops old messages, the plugin snapshots them into memory-core's corpus so nothing important is lost. Complements memory-core's nightly dreaming (which only promotes things the agent *searched* for recently) with a "capture-on-the-way-out" pass.

Remove this plugin and memory-core still works exactly as upstream ships it. You just lose the four wins.

---

## Why it's a drop-in

This plugin registers through the standard `openclaw/plugin-sdk/core` entry. It uses the existing hook surface (`before_compaction`, `before_message_write`, and a retrieval score-modifier hook coming in v0.2) to integrate. It does not fork memory-core, does not patch memory-core source files, and does not claim memory-core's capability slot.

- **Storage isolation**: the hippocampus index lives in its own directory (default `~/.openclaw/state/memory-enhancements/hippocampus/anchors.json`) and never touches memory-core's state directory.
- **Configuration isolation**: the plugin reads its own config block via the plugin SDK. No mutation of `openclaw.json`'s `memory` section.
- **Failure isolation**: if this plugin crashes, memory-core continues working; you lose the four wins but retrieval still functions.

---

## Install

1. Clone or copy `extensions/tinkerclaw-memory-enhancements/` into your `extensions/` directory.
2. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["tinkerclaw-memory-enhancements"],
    "entries": {
      "tinkerclaw-memory-enhancements": {
        "enabled": true,
        "config": {
          "hippocampusIndex": { "enabled": true },
          "taskConditionedScoring": { "enabled": true, "taskWeight": 0.3 },
          "contradictionGate": { "enabled": true, "mode": "warn" },
          "compactionCapture": { "enabled": true, "captureMode": "dropped-only" }
        }
      }
    }
  }
}
```

3. Restart the gateway. You should see in the log:

```
[memory-enhancements] hippocampus: loaded N concepts, M chunk refs from ~/.openclaw/state/memory-enhancements/hippocampus
[memory-enhancements] ready — hippocampus index live, other 3 features scaffolded for v0.2
```

---

## What's live in v0.1 (this version)

- **Hippocampus index** — data structure, persistence, ingestion stub, lookup API. The index can be built and queried. The retrieval short-circuit is scaffolded but not yet registered as the retrieval pre-hook (that wiring is v0.2).
- **Compaction-aware capture** — registers `before_compaction` hook. Currently logs the number of messages about to be dropped. v0.2 will actually persist them via memory-core's public artifacts interface.

## What's scaffolded for v0.2

- **Task-conditioned retrieval scoring** — waiting on upstream's `memory_search` exposing a stable score-modifier hook. Plugin will register a score transformer that bumps chunks matching the current task.
- **Contradiction-gate** — waiting on upstream's `memory-core` exposing a hook on the short-term → durable promotion path (during the nightly deep dreaming phase). Plugin will intercept candidate promotions and veto/flag contradictions.
- **Hippocampus retrieval short-circuit** — wiring the live index as an actual pre-search filter that bypasses hybrid for known concepts. Currently the lookup API works, but it isn't called from memory-core's query path yet.

## Why v0.1 doesn't fully wire all four

Three of the four features need hook points that upstream's plugin SDK doesn't yet expose at the memory layer. The fork's previous monolithic implementation got these by patching memory-core source directly — which produced exactly the merge-tax spiral this plugin is designed to avoid. Rather than repeat that pattern, v0.1 ships the data structures and registration boilerplate, and v0.2 lands once the upstream hook surface is ready (or we contribute the hooks upstream, which is the better long-run play).

---

## Design notes

### Why not just fork memory-core?

We tried. The fork maintained a parallel event-store-based memory system (total-recall, ~5,700 LOC) for 6+ months. It had real wins on retrieval speed and auto-ingestion, but the merge tax against upstream's memory-core was crushing — every upstream refactor required hand-restoring our patches, and the two systems kept diverging. This plugin is the decision to stop fighting: adopt upstream's chassis wholesale, express our wins as additions, ship them as a plugin.

### Why should ClawHub care?

Personal-assistant deployments are a large slice of openclaw's real-world usage. Personal assistants have unique memory requirements that don't quite match the enterprise knowledge-base pattern upstream's memory-wiki is optimizing for:

- **O(1) concept retrieval matters** when the same names/places/projects come up every day.
- **Auto-capture matters** because there's no user curator.
- **Contradiction-gating matters** because a solo user can't audit memory promotions.
- **Task-conditioning matters** because a personal assistant context-switches constantly.

Upstream's memory team has shipped memory-wiki as their answer to the enterprise knowledge-base side. This plugin is the answer to the single-user personal-assistant side. They're complementary.

---

## License

MIT. Original concepts by Oscar Serra (fork author, paper J2 — Concept Index for O(1) Memory Retrieval).
