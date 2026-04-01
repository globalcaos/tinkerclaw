# Total Recall

> Episodic memory with FTS + vector retrieval, pointer compaction, and event-sourced store.

**Paper:** J1 — Event-Navigated Graded Retrieval & Archival Memory (ENGRAM)
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

Gives the agent a persistent episodic memory that survives context compaction. Every assistant response is ingested into a per-session event store with full-text search and optional vector embeddings. Before each prompt, the most relevant past events are retrieved and injected as a memory context block. Messages about to be lost to context compaction are persisted first so nothing is forgotten. The agent gains a `recall` tool for explicit memory queries.

## Install

1. Install Ollama and pull the embedding model: `ollama pull mxbai-embed-large`
2. Copy this folder to `~/.openclaw/workspace/extensions/tinkerclaw-total-recall/`
3. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["tinkerclaw-total-recall"],
    "entries": {
      "tinkerclaw-total-recall": {
        "enabled": true,
        "config": {
          "budgetTokens": 2000,
          "embeddingProvider": "ollama",
          "embeddingModel": "mxbai-embed-large",
          "retentionDays": null,
          "pointerMode": true
        }
      }
    }
  }
}
```

4. Restart gateway

## Configuration

| Key                 | Default               | Description                                           |
| ------------------- | --------------------- | ----------------------------------------------------- |
| `budgetTokens`      | `2000`                | Maximum tokens to inject as memory context per prompt |
| `embeddingProvider` | `"ollama"`            | Embedding provider (`ollama` supported)               |
| `embeddingModel`    | `"mxbai-embed-large"` | Embedding model name                                  |
| `retentionDays`     | `null`                | Days to retain events (null = keep forever)           |
| `pointerMode`       | `true`                | Use pointer compaction for efficient storage          |

## Dependencies

- Required: Ollama with `mxbai-embed-large` model for vector embeddings
- Optional: Hippocampus — enhances retrieval with concept-index anchor lookup

## How It Works

Three hooks are registered. `before_prompt_build` (priority 50, runs after Identity Persistence) retrieves relevant past events for the current query using a hybrid FTS + vector recall and injects them as a `## Retrieved Memory Context` block. The `llm_output` hook ingests each assistant response into the event store asynchronously (fire-and-forget). The `before_compaction` hook intercepts messages about to be truncated by the context window and ingests them before they are lost. Events are stored per-session under `~/.openclaw/engram/`. Shared state is written to `~/.openclaw/cognitive/total-recall.json` so Round Table can detect availability and route debate traces here instead of its own JSONL.
