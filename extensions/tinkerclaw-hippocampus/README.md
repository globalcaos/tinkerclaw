# Hippocampus

> Pre-computed anchor-to-chunk concept index for fast O(1) memory retrieval.

**Paper:** J2 — Concept Index for O(1) Memory Retrieval
**Status:** Production (deployed 6+ months)
**Vanilla OpenClaw:** Yes — drop-in installation

## What It Does

Enhances memory retrieval by maintaining a pre-computed concept index where each anchor maps directly to relevant memory chunks — bypassing scan-time search for known concepts. Importance scoring and deduplication prevent the index from growing stale. The episodic buffer holds recent events in fast-access storage before they are consolidated into long-term memory.

## Install

1. Copy this folder to `~/.openclaw/workspace/extensions/hippocampus/`
2. Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["hippocampus"],
    "entries": {
      "hippocampus": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

3. Restart gateway

## Configuration

No configuration options. The concept index is fully managed by the core memory system.

## Dependencies

- Required: Total Recall (`tinkerclaw-total-recall`) — Hippocampus enhances Total Recall's retrieval layer and has no effect without it
- Optional: none

## How It Works

Hippocampus is a registration stub. The core implementation lives inside the gateway's memory subsystem at `src/memory/engram/`. This extension exists solely to register the plugin ID with the discovery system so the `openclaw.json` entry passes validation. All hooks — importance scoring, deduplication, episodic buffer management, and concept index construction — are wired into the gateway at build time via that subsystem, not here at runtime. No `register()` body is needed.
