---
file: subagents-and-kits.md
purpose: How fork subagents are spawned, how kits drive orchestration, how plans persist across restarts, how Prefrontal observes it all
audience: AI
last_verified: 2026-05-16
last_verified_commit: HEAD
single_owner: yes — subagent + kit orchestration + plan persistence facts live here
see_also: topology.md (Prefrontal plugin), flows.md (F6 cc-bridge tool loop, F-PLAN-RESUME, F-KIT-INSTALL), tool-loop.md (why fork orchestration is different from upstream)
verify:
  - name: kit-matcher exists and auto-seeds a plan at turn start (FORK 2026-05-16 — the smart-router matching half)
    cmd: python3 -c 'import os; m=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/kit-matcher.ts")).read(); assert "export async function seedPlanFromPrompt" in m and "NO-MATCH" in m and "recipe-gap" in m, "kit-matcher.ts missing seedPlanFromPrompt or the no-match recipe-gap WARN — the smart-router matching half regressed"; idx=open(os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/index.ts")).read(); assert "seedPlanFromPrompt" in idx and "before_prompt_build" in idx, "index.ts no longer wires seedPlanFromPrompt into a before_prompt_build hook — turn-start auto-seed is dead, restart-continue has nothing to resume for normal turns"'
  - name: spawn helper script is executable
    cmd: test -x ~/src/tinkerclaw/scripts/openclaw-spawn-subagent.mjs
  - name: recipe-state helper script is executable
    cmd: test -x ~/src/tinkerclaw/scripts/openclaw-recipe-state.mjs
  - name: kits library has ≥10 kit.md files with schema:"kit/1.0"
    cmd: bash -lc 'count=$(grep -l "^schema: \"kit/1.0\"" ~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/kits/*/kit.md 2>/dev/null | wc -l); test "$count" -ge 10 || (echo "only $count kits found"; exit 1)'
  - name: every kit.md parses cleanly via yaml + carries slug/title/summary
    cmd: python3 -c 'import os,re,yaml,sys; r1=os.path.expanduser("~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/kits"); r2=os.path.expanduser("~/.openclaw/workspace/kits"); bad=[]; [bad.append(f+" (parse/field err)") if not all(yaml.safe_load(re.search(r"^---\n(.+?)\n---",open(f).read(),re.DOTALL).group(1)).get(k) for k in ["slug","title","summary"]) else None for root in [r1,r2] if os.path.isdir(root) for a in os.listdir(root) for f in ([os.path.join(root,a,"kit.md")] if os.path.isfile(os.path.join(root,a,"kit.md")) else [os.path.join(root,a,b,"kit.md") for b in os.listdir(os.path.join(root,a)) if os.path.isdir(os.path.join(root,a,b)) and os.path.isfile(os.path.join(root,a,b,"kit.md"))])]; sys.exit(1) if bad else print("ok "+str(len([f for root in [r1,r2] if os.path.isdir(root) for a in os.listdir(root) for f in ([os.path.join(root,a,"kit.md")] if os.path.isfile(os.path.join(root,a,"kit.md")) else [os.path.join(root,a,b,"kit.md") for b in os.listdir(os.path.join(root,a)) if os.path.isdir(os.path.join(root,a,b)) and os.path.isfile(os.path.join(root,a,b,"kit.md"))])]))+" kits")'
  - name: every parallelism.groups in our kits is a valid step-index covering exit=2
    cmd: |
      cd ~/src/tinkerclaw && python3 << 'PYEOF'
      import os, glob, sys
      try:
          import yaml
      except Exception:
          sys.exit(0)  # yaml not available; skip silently
      bad = []
      for fp in glob.glob("extensions/tinkerclaw-prefrontal/kits/*/kit.md"):
          text = open(fp).read()
          m = text.find("---\n")
          if m < 0: continue
          e = text.find("\n---\n", m + 4)
          if e < 0: continue
          try:
              fm = yaml.safe_load(text[m + 4:e]) or {}
          except Exception as ex:
              bad.append(f"{fp}: yaml parse error {ex}"); continue
          par = fm.get("parallelism")
          if par is None: continue
          groups = par.get("groups") if isinstance(par, dict) else None
          if not isinstance(groups, list):
              bad.append(f"{fp}: parallelism.groups missing or not a list"); continue
          body = text[e + 5:]
          step_count = sum(1 for ln in body.split("\n") if ln.startswith("### ") and ln[4:5].isdigit())
          seen = set()
          for g in groups:
              if not isinstance(g, list):
                  bad.append(f"{fp}: group not a list"); continue
              for idx in g:
                  if not isinstance(idx, int) or idx < 0 or idx >= step_count:
                      bad.append(f"{fp}: invalid step index {idx} (count={step_count})")
                  elif idx in seen:
                      bad.append(f"{fp}: step {idx} appears in multiple groups")
                  else:
                      seen.add(idx)
      if bad:
          print("\n".join(bad)); sys.exit(1)
      PYEOF
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

## Canonical kit translation contract

There is exactly ONE kit data shape in this codebase. It is the kit.md frontmatter
as defined by the kit/1.0 spec (https://www.journeykits.ai/api/docs/kit-md). The
RPC `prefrontal.kit.list` parses every kit.md (both ours and downloaded) via
`yaml.parse` and returns a normalized array:

| Field      | Source                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `kitRef`   | `<owner>/<slug>` derived from path                                                                         |
| `owner`    | `globalcaos` for ours; remote owner for downloaded                                                         |
| `slug`     | frontmatter `slug` field, falls back to dir name                                                           |
| `title`    | frontmatter `title`                                                                                        |
| `summary`  | frontmatter `summary` (block scalars folded by `yaml.parse`)                                               |
| `tags`     | frontmatter `tags`                                                                                         |
| `category` | derived: explicit `category` field → tag match → pattern fallback (parser-internal `inferCategory`)        |
| `source`   | `"ours"` for `extensions/tinkerclaw-prefrontal/kits/*` / `"downloaded"` for `~/.openclaw/workspace/kits/*` |
| `path`     | absolute path to kit.md                                                                                    |

**There is no `RECIPE_CATALOG` or any hand-coded kit list in the UI.** Adding a
kit means dropping a kit.md on disk — the gateway picks it up and the UI shows
it on next render. Deleting a kit means deleting the file.

**Adding a new field to kit/1.0:** add it to `KitFrontmatter` type in
`kit-rpcs.ts`, surface it in the RPC response, consume it in the UI. Update the
table above. The merge gate (verify block in this file's frontmatter) catches
kit.md parse failures.

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

### The kit-matcher — auto-seed at turn start (FORK 2026-05-16)

`extensions/tinkerclaw-prefrontal/kit-matcher.ts` is the **matching half** of the smart router; `kit-runner.ts` is the execution half. Before 2026-05-16 nothing called the execution half from a normal conversational turn — Jarvis had to remember to invoke `prefrontal.kit.run`, and he didn't (the 2026-05-14 plan-not-set incident: a 7-minute turn with no plan, so restart-continue had nothing to resume). Per the "force rules in code" preference, matching now fires automatically.

Flow:

1. Registered as a second `before_prompt_build` hook in `index.ts` (priority 20, separate concern from the anti-goldplating hook at 40). The hook event carries `{ prompt, messages }`; ctx carries `{ sessionKey, trigger, runId }`.
2. Gate: only `sessionKey` ending `:main` (not `:subagent:`), and `trigger` not `heartbeat`/`cron`. Every other user turn is scored — there is **no complexity heuristic**; "no match" frequency is itself the signal (see below).
3. `loadKitIndex(ownKitsDir)` scans the local catalog's frontmatter (slug/title/summary/tags), cached by the kits-dir mtime. No Journey network call on the hot path.
4. `matchKits` scores each kit: exact phrase tag in prompt = 5, single-word tag hit = 3, title word = 2, summary word = 1. Threshold 3, top 3 kits.
5. `buildMergedPlan` concatenates matched kits' steps (parsed via the exported `parseKitStepsAndParallelism`), deduped by normalized title, highest-scored kit's phrasing wins. This is the user's "merge into one plan" decision (2026-05-14).
6. `planStore.set` seeds the plan — UNLESS an `in_progress` plan already exists (explicit/prior-turn plans win; never clobbered).
7. No match → a `WARN [kit-matcher] NO-MATCH … prompt="…" (catalog=N kits)` line. **This is the recipe-gap signal**: if it fires often for a class of prompts, the catalog is too thin, or the work has drifted into new territory, or we need on-the-fly kit authoring. Mining this WARN is how the catalog grows. The implicit 2-step panel (content-rich, see `tinker-ui.md` / `prefrontal-tree.ts` `humanizeRootStatus`) is the acceptable recovery UX for genuinely trivial no-match turns.

Recovery contract: because the matcher seeds a plan for substantially every non-trivial turn, **restart-continue almost always has an `in_progress` plan to resume** — that is the "working recovery system against restart." Trivial no-match turns are short enough that a restart just means the user re-asks; no plan-replay machinery is needed (deliberately not built — minimal blast radius).

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

## Kit parallelism

The `parallelism:` frontmatter block declares which step-groups can fan out:

```yaml
parallelism:
  groups:
    - [0, 1, 2]
    - [3]
    - [4, 5]
  notes: |
    Explore steps (0-2) are read-only and parallelizable; the design
    step (3) needs the prior reads. Write steps (4-5) can fan out per
    file/module.
```

Semantics: each inner array is a parallel group; groups execute sequentially. The
`prefrontal.kit.run` RPC consumes this block — for each group, it dispatches one
subagent per step via `scripts/openclaw-spawn-subagent.mjs` and waits for ALL of
them before advancing to the next group. The plan-row for each step is the per-step
write barrier (status:`in_progress` → status:`done`).

**Step indices are 0-based**, matching the `### N. Title` heading sequence
(heading "1." → index 0, "2." → index 1, etc.).

Absent `parallelism:` block → fully sequential execution (one step per group).

### prefrontal.kit.run RPC

```
prefrontal.kit.run { kitRef, sessionKey, intent, parameters?, dryRun? }
→ { ok, planId, dryRunPlan?, errorMessage? }
```

- `kitRef`: `"<owner>/<slug>"` e.g. `"globalcaos/code-review"`
- `sessionKey`: plan session key (used as the plan row identifier)
- `intent`: user-visible label for the plan
- `parameters`: optional `Record<string, string>` for `{{key}}` substitution in step body text
- `dryRun: true`: returns the dispatch plan (groups + step tasks) without spawning anything

Live mode returns `planId` immediately; dispatch runs in the background. Watch the
TUI plan board for live step progress.

### Implementation files

| File                                             | Role                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `extensions/tinkerclaw-prefrontal/kit-runner.ts` | Core runner — loads kit, resolves groups, fans out via spawn helper, polls plan-store for step completion |
| `extensions/tinkerclaw-prefrontal/kit-rpcs.ts`   | `prefrontal.kit.run` RPC wired here, delegates to kit-runner                                              |
| `src/gateway/protocol/schema/prefrontal-kit.ts`  | `PrefrontalKitRunParamsSchema` added (kitRef, sessionKey, intent, parameters, dryRun)                     |
| `scripts/openclaw-spawn-subagent.mjs`            | CLI helper invoked per-step for gateway subagent dispatch                                                 |

### Parallelism decision rules (heuristics)

- **Read-only / exploratory** (Read/Grep/Glob/WebFetch) → fan out freely
- **Analytical / synthesising** → single-step barrier
- **Write / mutating** (Edit/Write/destructive Bash) → serialize (shared file = collision risk)
- **Verify** (test/build) → barrier after the writes it verifies
- **Safety-ordered** (credential-rotation, deploy, incident contain) → fully serial regardless

### Anti-patterns

- Never fan steps that write the same output file (merge conflict)
- Never parallelize safety gates (revoke-before-verify, deploy-before-test)
- Never fan steps with strict data dependencies (reproduce→diagnose→fix→verify)
- Do not fan steps faster than ~30s expected duration (spawn overhead dominates)

Reference playbook: `docs/superpowers/specs/2026-05-13-kits-parallelism-playbook.md`
(in the jarvis-icu repo) for the per-kit recommendations and per-pattern speedup
estimates.

## Don't regress

- The `--trail` verbs are a small fixed set: `dispatch`, `complete`, `note`, `transition`, `warn`. Adding a new verb requires coordinating with the Prefrontal renderer.
- The kit catalog's `triggers` are documentation only; the matching is informal. Do not over-engineer it.
- The split between Prefrontal panel and chat text is the single most important orchestration invariant. If it breaks, both panels become useless noise.
- The `currentStep` invariant (at most one `in_progress` step per plan) is enforced by the plan-store. Never bypass it.
- Kit sandbox enforcement (`resolveSandboxPath`) must run on every file in every install — no exceptions, no trusted-path bypass.
