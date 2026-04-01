# OpenClaw Cognitive Plugins — Installation Guide

> Making AI agents smarter through architecture, not model scale.
> Based on the PREFRONTAL paper series (Serra & Jarvis, 2026).

## Overview

These plugins implement the cognitive architecture described in the PREFRONTAL paper (J13). Each plugin adds a specific cognitive capability. They work independently but compound when used together — the paper's central thesis.

## Recommended Installation Order

Install in this order for maximum benefit at each step:

### Tier 1: Foundation (Start Here)

#### 1. Fractal Reflection (J3)

**What:** Post-turn self-reflection at multiple abstraction levels.
**Impact:** Converts every interaction into a reusable lesson. This is the compounding engine.
**Install:** Copy `extensions/tinkerclaw-fractal-reflection/` → `~/.openclaw/workspace/extensions/tinkerclaw-fractal-reflection/`

```json
{
  "plugins": {
    "allow": ["tinkerclaw-fractal-reflection"],
    "entries": {
      "tinkerclaw-fractal-reflection": {
        "enabled": true,
        "config": { "debounceMs": 30000 }
      }
    }
  }
}
```

#### 2. Total Recall — ENGRAM (J1)

**What:** Episodic memory with hybrid FTS + vector retrieval.
**Impact:** The agent remembers past sessions. Fractal reflections now persist and get retrieved.
**Requires:** Ollama with `mxbai-embed-large` model.

```json
"tinkerclaw-total-recall": {
  "enabled": true,
  "config": {
    "budgetTokens": 2000,
    "embeddingProvider": "ollama",
    "embeddingModel": "mxbai-embed-large"
  }
}
```

#### 3. Identity Persistence — CORTEX (J4)

**What:** Maintains agent personality across sessions via SOUL.md.
**Impact:** Consistent identity. No more personality drift.
**Setup:** Create `~/.openclaw/SOUL.md` with your agent's persona.

```json
"tinkerclaw-identity-persistence": {
  "enabled": true,
  "config": {
    "syncScoreThreshold": 0.6,
    "evaluationInterval": 10,
    "personaPath": "~/.openclaw/SOUL.md"
  }
}
```

### Tier 2: Intelligence (After Foundation Works)

#### 4. Round Table — SYNAPSE (J6)

**What:** Multi-model adversarial debate for high-stakes decisions.
**Impact:** Cross-model validation catches blind spots.

```json
"tinkerclaw-round-table": {
  "enabled": true,
  "config": { "defaultDepth": "standard", "maxRounds": 6 }
}
```

#### 5. Learned Intuition — AMYGDALA (J11)

**What:** Neural safety gate. Blocks dangerous actions before the LLM finishes reasoning.
**Impact:** Safety without wasting context tokens on prompt-based rules.
**Models:** Prudence networks (public, download from releases). Personality networks (private, train your own — see `TRAINING.md`).

```json
"tinkerclaw-learned-intuition": {
  "enabled": true,
  "config": {
    "phase": 1,
    "observeOnly": true,
    "modelsDir": "models/amygdala"
  }
}
```

Start at phase 1 (observe-only). Review logs before promoting to phase 2.

#### 6. Computational Humor — LIMBIC (J7)

**What:** Humor generation via embedding geometry.
**Impact:** Personality expressiveness. Makes the agent more human.

```json
"tinkerclaw-computational-humor": {
  "enabled": true,
  "config": { "frequency": "low", "sensitivityThreshold": 0.8 }
}
```

### Tier 3: Orchestration (The Full Stack)

#### 7. Prefrontal (J13)

**What:** The orchestration brain. Exploration gate, anti-goldplating, forcing questions, effort routing, CORF trigger, FAAR tracking, permission hooks.
**Impact:** Closes the gap with Claude Code. Enforces coding discipline programmatically.
**Vanilla-compatible:** Yes (graceful fallback when fork utilities unavailable).

```json
"prefrontal": {
  "enabled": true,
  "config": {
    "enabled": true,
    "model": "anthropic/claude-opus-4-6",
    "featureFlags": {
      "explorationGate": true,
      "antiGoldplating": true,
      "forcingQuestions": true,
      "effortRouting": true,
      "corfTrigger": true,
      "faarTracking": true,
      "permissionHooks": true
    }
  }
}
```

#### 8. Hippocampus (J2)

**What:** Concept-index memory for O(1) retrieval.
**Impact:** Faster, more accurate memory lookups.
**Requires:** Total Recall installed first.

```json
"hippocampus": { "enabled": true }
```

## Cumulative Benefit

| Plugins Installed | Expected FAAR Improvement             | What You Get                               |
| ----------------- | ------------------------------------- | ------------------------------------------ |
| Fractal alone     | +10-15%                               | Lessons persist across sessions            |
| + Total Recall    | +15-20%                               | Lessons get retrieved when relevant        |
| + Identity        | +5%                                   | Consistent personality, no drift           |
| + Round Table     | +5-10%                                | Cross-model validation for key decisions   |
| + AMYGDALA        | +5%                                   | Safety without token cost                  |
| + Prefrontal      | +15-20%                               | Coding discipline, exploration-before-code |
| **Full stack**    | **~60% reduction in repeated errors** | **The compounding thesis in practice**     |

_Based on 6 months of operational data (N=1, see paper §5 for methodology and caveats)._

## Cross-Plugin Communication

Plugins communicate via shared state files in `~/.openclaw/cognitive/`:

```
Identity Persistence ──writes──► identity-persistence.json ──reads──► Computational Humor
Learned Intuition ────writes──► personality-nudge.json ─────reads──► Identity Persistence
Total Recall ─────────writes──► total-recall.json ──────────reads──► Round Table
```

All dependencies are **soft** — each plugin works standalone. The shared files add capabilities but aren't required.

## Verification

After installing, verify each plugin loaded:

```bash
# Check gateway logs for registration messages
journalctl --user -u openclaw-gateway.service --no-pager -n 50 | grep -i 'ready\|registered\|loaded'
```

Each plugin logs a registration message on startup, e.g.:

```
[fractal-reflection] ready (debounce=30000ms)
[identity-persistence] ready (persona=YourAgent, threshold=0.6)
[prefrontal] Prefrontal plugin registered (poll: 5000ms)
```

## Papers

| ID  | Title                                | Plugin                          |
| --- | ------------------------------------ | ------------------------------- |
| J1  | Total Recall — ENGRAM                | tinkerclaw-total-recall         |
| J2  | Hippocampus — Concept Index          | hippocampus                     |
| J3  | Fractal Reflection — FMI             | tinkerclaw-fractal-reflection   |
| J4  | Identity Persistence — CORTEX        | tinkerclaw-identity-persistence |
| J6  | Round Table — SYNAPSE                | tinkerclaw-round-table          |
| J7  | Computational Humor — LIMBIC         | tinkerclaw-computational-humor  |
| J11 | Learned Intuition — AMYGDALA         | tinkerclaw-learned-intuition    |
| J13 | PREFRONTAL — Compounded Intelligence | prefrontal                      |
