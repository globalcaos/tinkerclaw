---
file: subagents-and-recipes.md
purpose: How fork subagents are spawned, how recipes drive orchestration, how Prefrontal observes it
audience: AI
last_verified: 2026-05-11
last_verified_commit: HEAD
single_owner: yes — subagent + recipe orchestration facts live here
see_also: topology.md (Prefrontal plugin), flows.md (F6 cc-bridge tool loop), tool-loop.md (why fork orchestration is different from upstream)
---

# Subagents, recipes, and Prefrontal observability

## Why the fork has its own subagent path

cc-bridge sessions use claude-cli internally; claude-cli has its own subagent mechanism (`Task` tool, agents-md hierarchy). But the fork needs a SECOND path: spawn an OpenClaw subagent that uses a non-cc-bridge provider (e.g., openai, google), or an OpenClaw subagent that runs orchestration logic separate from claude-cli's tool tree.

The fork RPC for this is `fork.subagents.spawn` (`src/fork/subagents-rpc.ts`, FORK 2026-04-20). It wraps `spawnSubagentDirect` from the agent runtime.

## The spawn helper

`~/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs` is the CLI wrapper Jarvis uses from cc-bridge:

```
node ~/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs \
     --task "<instruction>" \
     --label "<short-name>" \
     [--model claude-code/claude-opus-4-7] \
     [--thinking medium] \
     [--timeout 600] \
     --json
```

Stdout (with `--json`) returns `{childSessionKey, runId}`.

When the active provider is a regular LLM (anthropic, openai, google, ollama), the **native `sessions_spawn` tool** takes over automatically — no orchestration code rewrite required. The helper is the fallback for the claude-cli mode where the native tool isn't exposed.

## Recipe catalog

Hand-written orchestration recipes live at `~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes/`. Each recipe is a markdown file with YAML frontmatter (schema=recipe/1.0) and numbered Steps, Constraints, Safety Notes, Failures Overcome.

Catalog entries (per `recipes/CATALOG.md`):

| Recipe                            | Triggers (informal)            | Purpose                                                                            |
| --------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `writing/revise-paper.md`         | revise / improve a paper draft | structure audit → evidence check → prose tightening → fresh additions → final pass |
| `writing/write-paper.md`          | new paper from scratch         | sketch → outline → draft → review                                                  |
| `writing/brainstorm.md`           | open-ended ideation            | divergent generation → cluster → prioritize                                        |
| `writing/write-plan.md`           | implementation plan            | spec → step decomposition → invariants                                             |
| `coding/code-review.md`           | review code                    | systematic pass with checklist                                                     |
| `coding/debug.md`                 | debug issue                    | hypothesis → probe → confirm → fix                                                 |
| `coding/feature.md`               | implement feature              | scope → design → implement → verify                                                |
| `coding/refactor.md`              | refactor existing code         | tests-first → behavior-preserving change                                           |
| `coding/plan.md`                  | plan a coding task             | step decomposition + risk identification                                           |
| `coding/verify.md`                | verify completion              | checklist + probe runs                                                             |
| `analysis/investigate.md`         | investigate unknown            | data gathering → pattern recognition → conclusions                                 |
| `analysis/dependency-analysis.md` | dependency mapping             | static + dynamic analysis                                                          |

Usage discipline: when the user's task matches a recipe's `triggers`, READ the recipe FIRST, use its Steps as the skeleton of the plan, and reference the recipe id in orchestration narration. Recipes are PLAYBOOKS, not executable code. Combine them with the spawn helper: dispatch each Step in a recipe to its own subagent when independent and parallelisable.

## Prefrontal observability — the recipe-state CLI

Recipes coordinate; Prefrontal observes. The recipe-state CLI publishes orchestration state to the Prefrontal panel (which renders it as the call tree visible in Tinker UI).

`~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs`:

```bash
# announce or advance recipe state (call on every Step transition)
node ~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs --recipe revise-paper \
     --step 3 --total 6 --step-name "evidence check" --cap 3 \
     --in-flight '§3-oauth-check,§7-ev'

# push a trail event (dispatch, complete, note, transition, warn)
node ~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs --trail dispatch \
     --label '§7-ev' --message 'sonnet, ~240s budget'

node ~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs --trail complete \
     --label '§2-threat-ref' --message '6s · 340w delta'

node ~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs --trail transition \
     --label 'Step 3 → Step 4' --message 'evidence clean; tightening prose'
```

Rule of thumb: every spawn gets a paired `--trail dispatch` BEFORE the spawn, and a paired `--trail complete` (or `--trail warn`) AFTER the child's result. Every recipe-step change gets a `--recipe ... --step N` call.

## Split of concerns

The split is structural and load-bearing:

| Channel                                              | Owns                                                                     | Should NOT contain      |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------- |
| **Prefrontal panel** (via recipe-state CLI + trails) | orchestration mechanics: dispatches, recipe steps, spawn/complete trails | substance               |
| **Chat text** (assistant message content)            | substance: what was found, what changed, what's stuck                    | orchestration mechanics |

These complement each other. Do not duplicate orchestration into chat; do not push substance into trails. If the user has to flip between panels to know where the agent is, the split was wrong.

## Subagent guidelines

- **Spawn only when the work parallelizes.** Small tasks stay inline.
- **Pick the model by task weight:** `claude-code/claude-haiku-4-5` for minimal tasks (lookups, format); `claude-code/claude-sonnet-4-6` for standard work; `claude-code/claude-opus-4-7` for genuinely hard reasoning.
- **Always pass a short `--label`.** Prefrontal tree readability depends on it.
- **Do NOT narrate dispatches in chat.** Use trails. Chat is for substance.

## Prefrontal infrastructure status

From bible / memory:

- Monitoring loop: 5s rebuild, stall detection at 180s threshold.
- UI: `tinker-ui/src/panels/prefrontal-tree.ts`.
- Guardian: Phase 3.5 in `scripts/cron-health-gate.sh` kills sessions stalled >5min and preserves recovery state in `/tmp/prefrontal/recovery.json`.
- HTTP API: gateway-internal, served by the Prefrontal plugin.

The infrastructure is COMPLETE (2026-04-01). Open follow-up: Opus agent routing, LLM summaries, deliver_answer aggregation.

## Don't regress

- The `--trail` verbs are a small fixed set: `dispatch`, `complete`, `note`, `transition`, `warn`. Adding a new verb requires coordinating with the Prefrontal renderer.
- The recipe catalog's `triggers` are documentation only; the matching is informal. Do not over-engineer it.
- The split between Prefrontal panel and chat text is the single most important orchestration invariant. If it breaks, both panels become useless noise.

## Verify (proposed)

```yaml
verify:
  - cmd: ls ~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes | wc -l
    expect: "integer > 10"
  - cmd: test -x ~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs
    expect: "exit-code 0"
  - cmd: test -x ~/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs
    expect: "exit-code 0"
```
