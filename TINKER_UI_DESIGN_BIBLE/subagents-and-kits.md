---
file: subagents-and-kits.md
purpose: How fork subagents are spawned, how kits drive orchestration, how plans persist across restarts, how Prefrontal observes it all
audience: AI
last_verified: 2026-05-13
last_verified_commit: HEAD
single_owner: yes — subagent + kit orchestration + plan persistence facts live here
see_also: topology.md (Prefrontal plugin), flows.md (F6 cc-bridge tool loop, F-PLAN-RESUME, F-KIT-INSTALL), tool-loop.md (why fork orchestration is different from upstream)
verify:
  - name: spawn helper script is executable
    cmd: test -x ~/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs
  - name: recipe-state helper script is executable
    cmd: test -x ~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs
  - name: kits library has ≥10 kit.md files with schema:"kit/1.0"
    cmd: bash -lc 'count=$(grep -l "^schema: \"kit/1.0\"" ~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/kits/*/kit.md 2>/dev/null | wc -l); test "$count" -ge 10 || (echo "only $count kits found"; exit 1)'
---

# Subagents, kits, plans, and Prefrontal observability

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

## Kits

### Kit format (kit/1.0)

The kit/1.0 format is documented at https://www.journeykits.ai/api/docs/kit-md. Each kit is a markdown file (`kit.md`) with:

- YAML frontmatter: `schema: "kit/1.0"`, `name`, `description`, `triggers[]`, `steps[]` (optional inline), `constraints[]`, `safety_notes[]`
- Markdown body: numbered Steps, each with a title + optional tool list + success criteria

### Kit RPCs

Five RPCs in `prefrontal.kit.*`:

| RPC                      | Params                                     | Returns                                              |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------- |
| `prefrontal.kit.search`  | `{ query: string, limit?: number }`        | `{ results: KitSummary[] }`                          |
| `prefrontal.kit.get`     | `{ kitRef: string }`                       | `{ kit: KitManifest, body: string }`                 |
| `prefrontal.kit.install` | `{ kitRef: string, allowRisky?: boolean }` | `{ ok, installedPath, preflightResults, nextSteps }` |
| `prefrontal.kit.publish` | `{ slug, body, apiKey? }`                  | `{ ok, url }`                                        |
| `prefrontal.kit.list`    | `{}`                                       | `{ kits: LocalKitEntry[] }`                          |

`kitRef` format: `<owner>/<slug>` (e.g., `globalcaos/feature`). Search and get hit `https://www.journeykits.ai`.

### Kit storage layout

- **Source tree (bundled):** `extensions/tinkerclaw-prefrontal/kits/<slug>/kit.md`
- **Downloaded at install:** `~/.openclaw/workspace/kits/<owner>/<slug>/` (contains `kit.md` + any installed files)

### Sandbox enforcement

Every file path written by kit-install goes through `resolveSandboxPath`:

- Absolute paths are refused
- `..` traversal sequences are refused
- Only relative paths within the install target dir are accepted
- Kits with `risk: ["Critical"]` or `risk: ["High Risk"]` require `allowRisky: true` in the install call

### Kit catalog

Hand-written orchestration kits live at `~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/kits/`. Each subdirectory is a kit slug containing a `kit.md`.

Catalog entries (per `kits/CATALOG.md`):

| Kit                                   | Triggers (informal)            | Purpose                                                                            |
| ------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `writing/revise-paper/kit.md`         | revise / improve a paper draft | structure audit → evidence check → prose tightening → fresh additions → final pass |
| `writing/write-paper/kit.md`          | new paper from scratch         | sketch → outline → draft → review                                                  |
| `writing/brainstorm/kit.md`           | open-ended ideation            | divergent generation → cluster → prioritize                                        |
| `writing/write-plan/kit.md`           | implementation plan            | spec → step decomposition → invariants                                             |
| `coding/code-review/kit.md`           | review code                    | systematic pass with checklist                                                     |
| `coding/debug/kit.md`                 | debug issue                    | hypothesis → probe → confirm → fix                                                 |
| `coding/feature/kit.md`               | implement feature              | scope → design → implement → verify                                                |
| `coding/refactor/kit.md`              | refactor existing code         | tests-first → behavior-preserving change                                           |
| `coding/plan/kit.md`                  | plan a coding task             | step decomposition + risk identification                                           |
| `coding/verify/kit.md`                | verify completion              | checklist + probe runs                                                             |
| `analysis/investigate/kit.md`         | investigate unknown            | data gathering → pattern recognition → conclusions                                 |
| `analysis/dependency-analysis/kit.md` | dependency mapping             | static + dynamic analysis                                                          |

Usage discipline: when the user's task matches a kit's `triggers`, READ the kit FIRST, use its Steps as the skeleton of the plan, and reference the kit id in orchestration narration. Kits are PLAYBOOKS, not executable code. Combine them with the spawn helper: dispatch each Step in a kit to its own subagent when independent and parallelisable.

## Plans

Plans are the runtime counterpart of kits. A kit is a template; a plan is an instance of execution rooted in a session.

### Plan file location

`~/.openclaw/workspace/state/prefrontal/plans/<sessionKey-slug>.md`

Active plans live here. On `plan.close`, the file is archived to:
`~/.openclaw/workspace/state/prefrontal/plans/archive/<YYYY-MM-DD>/<sessionKey-slug>.md`

### Plan RPCs

Four RPCs in `prefrontal.plan.*`:

| RPC                     | Params                                                                                         | Returns                          |
| ----------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| `prefrontal.plan.set`   | `{ sessionKey, intent, runId, steps?: [{title,note?}], kitRef?: string, status?: PlanStatus }` | `{ ok, planPath }`               |
| `prefrontal.plan.step`  | `{ sessionKey, stepIndex, status: StepStatus, note?: string }`                                 | `{ ok }`                         |
| `prefrontal.plan.get`   | `{ sessionKey }`                                                                               | `{ plan: PlanDocument \| null }` |
| `prefrontal.plan.close` | `{ sessionKey, status: "done" \| "aborted" }`                                                  | `{ ok, archivedPath }`           |

### Plan frontmatter shape

```yaml
---
schema: plan/1.0
sessionKey: agent:main:main
runId: abc123
intent: "implement the feature branch"
kitRef: globalcaos/feature # optional — if seeded from a kit
status: in_progress # in_progress | done | aborted
currentStep: 1 # 0-indexed, index of the active step
---
```

Steps follow as a numbered markdown list in the body. Each step has `status` tracked in frontmatter or inline metadata.

### Plan step statuses

`pending` → `in_progress` → `done` | `error`

### The `currentStep` invariant

**At most one step may be `in_progress` at a time per plan.** When `plan.step` is called with `status: "in_progress"` for step N, any previously `in_progress` step is automatically demoted to `pending` before step N is promoted. This invariant is enforced by the plan-store, not the caller.

### Plans-as-instances vs kits-as-templates

When `plan.set` is called with `kitRef: "globalcaos/feature"`:

1. kit-rpcs fetches the kit from the Journey registry (or local source tree)
2. The kit's `steps[]` body is used as the seed for the plan's step list
3. `kitRef` is recorded in the plan frontmatter so the origin is traceable
4. Subsequent `plan.step` mutations track execution of those steps

Without `kitRef`, steps are provided inline in the `plan.set` call.

## Prefrontal observability — the kit-state CLI

Kits coordinate; Prefrontal observes. The kit-state CLI publishes orchestration state to the Prefrontal panel (which renders it as the call tree visible in Tinker UI).

`~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs`:

```bash
# announce or advance kit state (call on every Step transition)
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

Rule of thumb: every spawn gets a paired `--trail dispatch` BEFORE the spawn, and a paired `--trail complete` (or `--trail warn`) AFTER the child's result. Every kit-step change gets a `--recipe ... --step N` call.

## Split of concerns

The split is structural and load-bearing:

| Channel                                           | Owns                                                                  | Should NOT contain      |
| ------------------------------------------------- | --------------------------------------------------------------------- | ----------------------- |
| **Prefrontal panel** (via kit-state CLI + trails) | orchestration mechanics: dispatches, kit steps, spawn/complete trails | substance               |
| **Chat text** (assistant message content)         | substance: what was found, what changed, what's stuck                 | orchestration mechanics |

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

The infrastructure is COMPLETE (2026-04-01). Plan/kit RPCs added 2026-05-13 (Phases 1–7 of the plan-board implementation).

## Don't regress

- The `--trail` verbs are a small fixed set: `dispatch`, `complete`, `note`, `transition`, `warn`. Adding a new verb requires coordinating with the Prefrontal renderer.
- The kit catalog's `triggers` are documentation only; the matching is informal. Do not over-engineer it.
- The split between Prefrontal panel and chat text is the single most important orchestration invariant. If it breaks, both panels become useless noise.
- The `currentStep` invariant (at most one `in_progress` step per plan) is enforced by the plan-store. Never bypass it.
- Kit sandbox enforcement (`resolveSandboxPath`) must run on every file in every install — no exceptions, no trusted-path bypass.
