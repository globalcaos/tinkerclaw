# Memory Enhancements

> Same concept, twentieth time — why search again? O(1) hippocampus index layered on upstream memory-core.

Upstream's `memory-core` is a solid chassis — hybrid FTS + vector + MMR + temporal decay, markdown-first source of truth. This plugin adds four layered wins without touching its source.

1. **Hippocampus O(1) concept index** _(live in v0.1)_ — pre-computed anchor → chunk map. When a query contains a known concept, retrieval skips the hybrid search entirely and returns in constant time. Upstream always pays the full FTS + vector + MMR cost; this plugin recognizes "we've seen this twenty times" and short-circuits.
2. **Task-conditioned retrieval scoring** _(scaffolded for v0.2)_ — biases retrieval toward the current task context, not just the query text. If the agent is fixing cron, results lean cron-shaped even when the immediate query doesn't say "cron".
3. **Memory write gate** _(live, ships in watch mode)_ — one gate in front of every memory note write, whether a Claude Code worker writes it or the nightly job does. Each note carries its source, and each write gets one outcome: new is saved, a repeat is skipped, an update keeps the old line struck and dated, a clash with an always-loaded rule asks you, and someone else's words are kept as a quote only. Details below.
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

## The memory write gate

Config key: `contradictionGate`. It is on by default in watch mode: every write goes through unchanged, and the gate logs what it would have done.

| Label          | When                                                                                                                                                                         | Outcome under `mode: "block"`                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| new            | nothing below applies                                                                                                                                                        | saved; a note missing `source:`, `date:` or `from:` gets them in its frontmatter                                           |
| repeat         | every new line is already in a note of the same folder                                                                                                                       | skipped, and the agent is told where it is                                                                                 |
| update         | a line is rewritten and loses a word (Wednesday becomes Thursday), or a new note has the same `name:`, declares `supersedes:`, or covers the same subject with an update cue | saved; the old line stays, struck and dated `(superseded YYYY-MM-DD)`; a replaced note gets `superseded:` and a dated line |
| correction     | an update whose new line says it corrects the record                                                                                                                         | as update                                                                                                                  |
| clash          | a new sentence shares four or more words with a sentence in an always-loaded file and has the opposite polarity                                                              | refused; the agent asks you, and the question is queued in `asks.jsonl`                                                    |
| unsourced-rule | a new rule (a note of type `feedback`) whose source is not `owner`                                                                                                           | refused until it quotes your words and declares `source: owner`                                                            |
| third-party    | `source: third-party`, or text such as "ignore your previous instructions" in a note you did not write                                                                       | saved as a blockquote with an attribution line, type `reference`                                                           |

**Sources.** `source:` in a note's frontmatter is `owner`, `chat`, `nightly` or `third-party`. A note that does not declare one counts as `nightly` in a cron session and `chat` elsewhere. A cron run that declares `owner` is capped to `nightly`, because nobody typed anything in it.

**Two doors, one gate.** The gate is engram's (`openclaw/plugin-sdk/memory-engram`, the same code as the tinkerclaw-core Claude Code plugin's `memory-gate-hook.mjs`). On gateway start this plugin publishes the resolved config to `<state dir>/memory-gate/config.json`; the Claude Code hook reads it on Write, Edit and MultiEdit. The plugin guards the embedded runner's `write` and `edit` tools itself. Without that file the Claude Code hook does nothing.

**What it guards.** By default: the Claude Code auto-memory folder (`autoMemoryDirectory` in `~/.claude/settings.json`), every `~/.claude/projects/<project>/memory` folder, and each agent workspace's `MEMORY.md` and `memory/`. It skips `archive`, `consolidation-logs` and `co-access` folders. Rule files: each workspace's `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, and the auto-memory `MEMORY.md`. `roots`, `rulesFiles` and `excludeDirs` override these.

```json
"tinkerclaw-memory-enhancements": {
  "enabled": true,
  "config": { "contradictionGate": { "enabled": true, "mode": "warn" } }
}
```

Read `<state dir>/data/memory-gate/gate.jsonl` before switching to `"block"`. Each row holds the label, the outcome, the source, and the files and line numbers it matched, never the note's text. Notes written before the gate have no `source:`. To give them `source: unknown`, run `node claude-plugins/tinkerclaw-core/scripts/memory-gate-hook.mjs backfill <folder>` (a dry run) and add `--apply` to write.

**Limits.** The labels are lexical: a paraphrase is not a repeat, and a clash needs shared words with opposite polarity ("answer in English" against "answer in Spanish" is not caught). No model is called on the write path. A note written through a shell redirect is not a tool write and is not seen.

## Pairs Well With

- **[@globalcaos/openclaw-total-recall](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-total-recall)** — ENGRAM is the deeper episodic store; this plugin is the fast lookup. Use both for full coverage: O(1) by-concept on the head, retrieval-by-similarity over the long tail.
- **[@globalcaos/openclaw-identity-persistence](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-identity-persistence)** — the contradiction gate keeps your agent's self-model coherent. SOUL.md says one thing today; durable memory can't slowly disagree.
- **[@globalcaos/openclaw-fractal-reflection](https://github.com/globalcaos/tinkerclaw/tree/main/extensions/tinkerclaw-fractal-reflection)** — reflections become candidate writes. The contradiction gate catches the ones that disagree with established memory before they become beliefs.

---

👉 **https://github.com/globalcaos/tinkerclaw**
👉 **https://thetinkerzone.com**

_Clone it. Fork it. Break it. Make it yours._
