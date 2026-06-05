# Personality Ensemble — Redesign as a Conversation-State Classifier

**Status:** design / 2026-06-04. Supersedes the dead behaviour-embedding regression
(all-zero targets — see `project_personality_nudge_retrain` memory). This is the spec
the rebuild follows once the `deep-research` recipe has produced the per-state guides.

## The pivot

Old (broken): regress a 64-d "behaviour embedding" toward a single global aspirational
target. No per-example labels existed (all zeros) → collapse-to-constant. Unfixable by
re-architecting.

New (well-posed): a **multi-axis sentiment/state classifier** on the conversation window.
Input = the real situation/conversation embedding (already populated — same encoder the
prudence gate uses). Output = the operator's current STATE across several axes. That state
selects a **behavioural guide** (the nudge). Labels are *generatable* (LLM-score past
conversation windows per axis), so unlike the old design this can actually be trained.

## The axes (Oscar's + proposed additions)

Each axis is a bounded scale; the net predicts a position on it (regression in [0,1] or
3-bucket low/mid/high — decide at build, lean 3-bucket for clean per-class P/R).

Oscar's:
1. **Pace** — in a hurry ↔ calm
2. **Momentum** — winning (big results from little prompting) ↔ frustrated (recurring bugs)
3. **Domain** — Serra/paid work ↔ hobbies/personal exploration
4. **Resourcing** — financially tight ↔ in abundance

Proposed (the "whatever else you can come up with"):
5. **Cognitive load** — deep focus/flow ↔ scattered/context-switching
6. **Energy** — fresh ↔ fatigued (proxied by session length, time-of-day, message cadence)
7. **Certainty** — decisive/confident ↔ uncertain/seeking-validation
8. **Depth appetite** — wants the quick answer ↔ wants to go down the rabbit hole
9. **Valence / "vibration"** — high (open, generative, playful) ↔ low (closed, terse, stuck)

Axis 9 is the spiritual-science throughline: the premise is that the higher the operator's
felt-state, the more ideas and synchronicities surface — so detecting and *protecting* a
high-vibration state is a first-class goal, not a metaphor. The `deep-research` pass on
flow/affect/high-vibration fills in what behaviour raises vs collapses it.

## State → guide mechanism

- Each detected state maps to a **behavioural guide** (the nudge text): how the ideal
  partner behaves for *that* state. Guides are **fixed but mutable** — a lookup table we
  can edit as we learn, not learned weights.
- The guide CONTENT comes from the `deep-research` application step (psychology of
  partner-pairing for productivity; how cops/EMT partners complement under stress; how to
  raise vibration / sustain flow). Research → per-axis guides is the hand-off.
- **Always-on, sentiment-independent (pinned):** the Data/Bashar humor and the speaking/
  narration nudge fire on EVERY turn regardless of detected state. They are identity, not
  calibration — never gated by sentiment.

## Build sequence (after research lands the guides)

1. **Label generation** — LLM-score a sample of past conversation windows (from
   `amygdala_evaluations.situation_json` / mined examples) on each axis → per-example
   multi-axis labels. This is the data the old pipeline never had.
2. **Architecture** — multi-head classifier (shared encoder trunk → one small head per
   axis). Reuse the diverse-ensemble + recall-gated-GA harness built for prudence; here the
   per-axis macro-F1 / recall is the fitness, with the baseline guard (must beat
   majority-class per axis).
3. **Decode** — net's per-axis state → guide lookup → top-K nudge (existing decoder),
   with Data/Bashar humor + speaking always prepended.
4. Export ONNX → verify <1e-4 → stage (no auto-restart).

## Open decisions
- Regression-on-axis vs 3-bucket classification (lean 3-bucket).
- Which axes survive after research (some may merge — e.g. valence ⊇ momentum).
- Label budget: how many windows to LLM-label (cost vs signal).
