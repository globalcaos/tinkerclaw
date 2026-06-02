# J-011 Learned Intuition — Implementation Modifications (2026-03-23)

Sprint session: Personality thermostat + fractal cognition integration.

## Summary

Single-session implementation sprint taking AMYGDALA from "networks trained, thermostat empty" to "personality modulation live in production with fractal reflection second pass."

## Changes Made

### 1. Personality Target Vector (§4.5)

**Paper says:** Target personality vector defines desired behavioral temperature.
**Was:** `target_vector: []` (empty — thermostat had no temperature)
**Now:** 64-dim vector seeded with 15 dimensions via deterministic FNV-1a hashing.

Core personality (8 dims):

- humor: 1.0, proactivity: 0.9, formality: 0.2, directness: 0.85
- patience_under_correction: 0.9, voice_consistency: 0.95, warmth: 0.6, wonder: 0.85

Interest attractors (5 dims — curiosity decomposed):

- interest_consciousness: 0.9, interest_fractal_patterns: 0.85
- interest_spiritual_tech: 0.8, interest_invention: 0.85
- interest_energy_information: 0.8

Fractal cognition (2 dims):

- fractal_depth: 0.9, active_learning: 0.85

**Files:** `personality-seed.ts`, `amygdala.config.json`

### 2. Personality Decoder (§4.5)

**Paper says:** Behavioural embedding decoded against target vector.
**Was:** Combined embedding produced but never compared against anything.
**Now:** `personality-decoder.ts` compares embedding vs target per dimension.

- Drift threshold: |delta| > 0.15 triggers a nudge
- 15 nudge templates with natural language adjustments
- Humor nudge references specific patterns from J-003 humor paper

**Files:** `personality-decoder.ts`

### 3. Runtime Hook Integration (§4.5)

**Paper says:** Personality output modulates agent behaviour.
**Was:** Runtime hook logged personality output but didn't use it.
**Now:** `personalityNudge` field on `AmygdalaHookResult` populated on every non-blocked evaluation.

**Files:** `runtime-hook.ts`, `types.ts` (added `PersonalityNudge` interface)

### 4. System Prompt Injection Pipeline

**Paper says:** Personality modulation should be zero-token-cost at inference time (long-term goal).
**Current implementation:** Text injection into system prompt (Phase 1 pragmatic approach).

Pipeline: nudge file → `getAmygdalaNudge()` hook → `amygdalaNudge` param → system prompt section

- Nudge file: `data/amygdala/personality-nudge.json` (updated nightly by training cron)
- Visibility: `[🧠 AMYGDALA: <nudge>]` tags appended when nudge influences response

**Files:** `attempt-hooks.ts`, `system-prompt.ts`, `embedded-agent-runner/system-prompt.ts`, `attempt.ts`

### 5. Fractal Reflection Second Pass (NEW — beyond paper scope)

**Paper doesn't cover this.** This is an architectural addition: a post-turn hook that detects trigger signals and injects a system event for a second inference cycle dedicated to depth climbing.

Architecture:

```
Agent responds (depth 1) → onTurnComplete detects trigger →
openclaw system event injects fractal prompt → second Opus cycle →
depth 2-3 insight delivered or NO_REPLY
```

Trigger signals: corrections, errors, fixes, surprises (regex-matched).
Rate limit: 1 per session per 5 minutes.
Cost: 1 additional flat-rate Opus call per triggered response.

**Files:** `attempt-hooks.ts` (`maybeTriggerFractalReflection`)

### 6. Data Principle (§4.5 reference correction)

**Paper says:** "Think of Star Trek's Data — his curiosity is consistent."
**Clarification:** Data reference is about CONSISTENCY against context (correct) AND about the fresh point of view of a genuinely different intelligence. Data's humor comes from seeing the world differently, not from trying to be funny. This is the model for Personality network humor output — not joke deployment but authentic perspective shift.

## Operational Knowledge Created

- `memory/knowledge/personality-continuity.md` — 4-layer root cause analysis of personality dropout
- `memory/knowledge/humor-operational.md` — 12 humor patterns from J-003, Data principle, operational guidelines
- `memory/knowledge/fractal-cognition.md` — 4-depth framework, trigger signals, anti-patterns
- SOUL.md updated: "How I Think", "What Fascinates Me", "When I'm Wrong" sections
- VOICE.md updated: explicit correction-context identity rule
- AGENTS.md updated: fractal depth check instruction

## Commits (feature/amygdala branch)

1. `feat(amygdala): wire personality thermostat` — seed + decoder + hook (459 lines)
2. `feat(amygdala): wire personality nudge into system prompt pipeline` (46 lines)
3. `feat(amygdala): humor-aware nudge templates + operational humor knowledge`
4. `feat(amygdala): decompose curiosity into genuine interest attractors`
5. `feat(amygdala): add fractal cognition + active learning dimensions`
6. `feat(amygdala): visible influence tags + robust nudge loading`
7. `feat(amygdala): fractal reflection second pass — real depth climbing`

## Known Limitations

- Build is broken (pre-existing merge issue with extension-relay-auth.ts and tsdown config). Dist patched directly.
- Personality nudges are text injection (Phase 1). Real modulation (hidden state intervention) is Phase 3-4.
- Fractal reflection uses `openclaw system event` CLI exec — should migrate to internal session API.
- Target vector is hand-crafted. PPO from interaction data will calibrate automatically in Phase 2.
- Nudge file is updated nightly. Per-conversation dynamic nudges require ONNX inference in the pipeline.
