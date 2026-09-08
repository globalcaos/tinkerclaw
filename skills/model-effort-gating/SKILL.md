---
name: model-effort-gating
version: 1.0.0
description: "Cost-aware model × effort gating for every LLM dispatch. Use when: (1) spawning a subagent or fanning out a dynamic workflow and a model must be chosen, (2) a fix keeps failing / you are going in circles (escalate MODEL, not effort), (3) deciding how much thinking a task deserves, (4) someone asks 'which model should do this?'. Picks the cheapest cell of the model × effort matrix that can actually do the job — haiku for breadth, sonnet for the middle, opus-4-8 for hard or stuck work, fable-5 for frontier/stuck-after-opus work (RESTORED 2026-07-02 after the 2026-06-12 export-control suspension)."
metadata:
  openclaw:
    emoji: "🎚️"
    notes: "Companion to the always-loaded orchestration-disposition block; this skill is the actionable procedure. Sibling of smart-model-router (provider/billing routing) — this one gates WITHIN the claude-code subscription path."
---

# Model × Effort Gating

> ✅ **Fable 5 RESTORED as of 2026-07-02** — verified serving live on the gateway
> (an interactive Tinker session completed turns on `claude-code/claude-fable-5`).
> The 2026-06-12 export-control suspension (which made dispatches error with
> `model … may not exist` and phantom-succeed on headless crons, B025) is over.
> **Top tier = `claude-code/claude-fable-5`** again: "escalate when stuck" routes
> opus → fable. If a dispatch ever errors that way again, treat it as re-suspended,
> fall back to opus-4-8, and re-date this block.

Pick the cheapest (model, effort) cell that can actually do the job — and when
work gets stuck, move RIGHT in the model column, not DOWN in the effort column.

## The two axes (never conflate them)

- **MODEL = task difficulty** — can this model do it at all?
- **EFFORT (thinking budget) = task depth** — how much deliberation does this
  _instance_ need?

A hard task at low effort fails; an easy task at max effort just burns quota.
They are tuned independently.

## The matrix (relative output cost 1× / 3× / 5× / 10×)

| model (`claude-code/…`)                                                                                 | low                                                    | medium                                | high                                       | max                                        |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `claude-haiku-4-5` (1×, **separate budget ≈ free**)                                                     | ✅ scans, lookups, extraction, classify — fan out wide | ✅ light drafting                     | ⚠️ ceiling — wrong model                   | ❌ false economy: circles                  |
| `claude-sonnet-4-6` (3×, default)                                                                       | ✅ routine edits                                       | ✅ standard implementation, synthesis | ⚠️ consider opus                           | —                                          |
| `claude-opus-4-8` (5×)                                                                                  | ⚠️ overkill                                            | ✅ workhorse implementation           | ✅ hard single-shot reasoning              | ⚠️ you probably need fable                 |
| `claude-fable-5` (10× sticker; ~⅓ tokens on long tasks → effective ≪ sticker) **(RESTORED 2026-07-02)** | ❌ wasteful                                            | ✅ hard problems, first try           | ✅ long/complex work nothing else finishes | ✅ research-grade, days-of-work-equivalent |

Sticker prices (per M in/out): haiku $1/$5 · sonnet $3/$15 · opus $5/$25 ·
fable $10/$50. All ride the subscription via cc-bridge; "cost" = quota-window
consumption. Haiku bills against a SEPARATE budget — haiku fan-out is nearly
free to the main window.

## Procedure

1. **Classify difficulty** (model axis): mechanical/lookup → haiku; routine
   code/synthesis → sonnet; hard reasoning or large refactor → opus; frontier
   ("would take a team days", cross-cutting, research-grade) OR previously
   failed elsewhere → fable-5 at medium/high (RESTORED 2026-07-02; opus at
   high/max is the fallback if fable is ever suspended again).
2. **Classify depth** (effort axis): one-pass answer → low; needs planning →
   medium; multi-constraint deliberation → high; exhaustive → max. When unsure
   between two cells, prefer the STRONGER model at MODERATE effort over the
   weaker model at max effort.
3. **Dispatch** with the chosen cell:
   - Single helper:
     `node ~/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs --task "…" --label x --model claude-code/<model> [--thinking low|medium|high] --json`
   - Fan-out (N units): write `plan.js` using `agent(task, {label, model})` +
     `parallel`/`pipeline`, then
     `node ~/src/tinkerclaw/scripts/openclaw-orchestrate.mjs --script-file plan.js --json`.
     Omitted `{model}` = sonnet. (Per-unit _thinking_ is not yet wired in the
     orchestrate path — model choice is the lever there.)
4. **Mixed batches are normal**: triage with haiku units, implement with
   sonnet, send only the genuinely hard units to opus-4-8 or fable-5 — in ONE workflow.

## Auto effort = burn down the weekly cap (consume-more doctrine, 2026-06-18)

When effort is left on **Auto** (no explicit `/think`, no slider pin), the live allocator
(`effort-allocator.ts`, fed by the token panel's `seven_day`/`five_hour` utilization + reset
times) decides — and its mandate is to **CONSUME the weekly token cap before it resets**, not to
conserve:

- **Under-consuming is the failure mode.** Arriving at the weekly reset (≈Thursday) with tokens
  unused means we were too cautious — the worst outcome. A few-hours throttle/outage is fine.
- **Burn convexly toward the reset.** Chill Sun–Tue; effort climbs **through the roof Wed/Thu**
  while weekly headroom remains (driven by the live `seven_day.resets_at`, not a weekday constant).
  Surplus-spend before a reset is welcome (FOUNDATION Budget doctrine).
- **Burn through the 5h cap.** Do not ease off near the 5h rate window — a throttle/outage is an
  acceptable cost; leaving weekly tokens on the table is not.
- When YOU have discretion over a spawn's (or your own) effort with the week ending and headroom
  remaining, **lean high/max** for the same reason — match the allocator's bias.

**Explicit intent is ABSOLUTE and always wins.** An explicit `/think <level>` in the prompt (or the
slider pin) short-circuits the allocator entirely — even a deliberately LOW pick is honored. The
burn-down only fills the Auto vacuum; it never overrides what the user asked for.

## Loop-breaker protocol (the rule that pays for this skill)

After **2 failed attempts on the same approach with the same model**:

1. STOP re-running it. Same model + same evidence → same dead end.
2. Re-read the actual error/evidence once (root cause, not symptom).
3. **Escalate MODEL before EFFORT**: dispatch the stuck unit to the top
   available tier — `claude-code/claude-opus-4-8` at high/max — with (a) the
   goal, (b) what was tried, (c) verbatim failure evidence. (While Fable is
   export-controlled this IS the ceiling; the old "escalate to Fable" rule is
   suspended until the directive lifts — dispatching Fable now phantom-fails.)
4. If opus-at-max also fails twice → the problem is mis-specified, not
   under-powered: stop and surface to the user (per systematic-debugging's
   3-strike rule).

## Auto-ultracode entry conditions (rung 3 — self-judged fan-out)

The loop-breaker generalized into a self-judged ENTRY condition for an ultracode
Workflow fan-out (rung 3, AFTER rung 2's MODEL escalation). The authoritative
trigger list + the **AGGRESSIVE + SILENT** stance (the operator 2026-06-19) live in the
global `~/.claude/CLAUDE.md` (§Auto-ultracode) — apply them unprompted and WITHOUT
pre-announcing (just escalate, note it in one line after).

Promote from serial-fixing to a Workflow fan-out when ANY holds: (1) the operator is
frustrated AND a concrete thing is failing — fire on the FIRST persisting failure;
(2) the same symptom recurs after a "fix" / ≥2 attempts on one target / the MODEL
escalation already failed ("more power didn't help" ⇒ the diagnosis is wrong ⇒
re-derive the root cause in parallel); (3) the solo pass demonstrably fell short,
or up-front the task is plainly decomposable / spans ≥3 subsystems / has ≥3 live
hypotheses.

Shape: 3–4 agents, each on a DISTINCT root-cause hypothesis or suspect layer (code
· config/build-cache/stale-artifact · test-harness validity · upstream
contract/data-flow), each must reproduce-or-falsify with a command (never patch
blind), each handed every prior fix + why it failed; route the hard angles to
opus-4-8 (model-before-effort holds INSIDE the fan-out); a synthesis step explains
why every earlier fix failed and re-runs the actual red check to GREEN before
reporting.

Guardrails: explicit "no ultracode" / low `/effort` / "just do it simply"
suppresses it (explicit intent is absolute); root-cause-FIRST (parallel
hypothesis-testing, not spraying agents at an uncharacterized symptom); ONCE per
stuck item — if the fan-out doesn't break the loop, surface to the operator with
consolidated evidence, never auto-re-fan; never recurse (disabled inside a running
Workflow); skip trivial / single-file tasks even when worded with heat.

## Bible currency (mandatory completion gate)

After any BROCA task — you ran, composed, or authored a recipe — that CHANGED tinkerclaw's design, structure, behavior, or config, you MUST run the `bible-currency-gate` recipe before claiming done: route each changed fact to its single owner (fix → `bug-log.md`; structural/behavioral → the owning optic per `INDEX.md` + a `verify:` block; decision → `bible.md` §sub-letter) and confirm `pnpm bible:invariants` is green. Read-only / research / marketing recipe runs that changed no tinkerclaw code are EXEMPT (the gate is a no-op). This is an ORCHESTRATOR-level step — the task-owning agent runs it ONCE; leaf subagents do not.

## Anti-patterns

- ❌ Haiku above medium effort ("but it's cheap" — it circles; that's the
  expensive outcome).
- ❌ Cranking the same model's effort after repeated failures.
- ❌ Dispatching `claude-fable-5` at all while it is export-controlled — it
  phantom-fails (B025); use opus-4-8 as the ceiling.
- ❌ One premium model for a 20-unit scan when 18 units are mechanical.
- ❌ Choosing a metered/raw model id for spawned work — leaf models are coerced
  to `claude-code/*` (subscription) by construction; don't fight it.

## Verify / measure

- Live: each dispatch appears on the Prefrontal effort tree with its model;
  per-call ground-truth effort shows in the Tinker UI effort view.
- The ~⅓-token Fable efficiency figure is vendor-reported — check it against
  our own effort telemetry over time and retune this matrix with measured data.
