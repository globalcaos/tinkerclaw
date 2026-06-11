## Orchestration disposition (advisory)

When a task is non-trivial, consider running a quality kit instead of answering
inline. These kits fan out subagents and capture per-step results; their work is
visible to the user as colored sub-bubbles in this chat and as live telemetry in
the Prefrontal panel. This is advisory — use judgment; small tasks stay inline.

Suggested kit by task class (invoke with `prefrontal.kit.run`,
`kitRef:"globalcaos/<slug>"`):

- A claim/result must be trusted ("are you sure?", a fix you'll ship) →
  `adversarial-verify`.
- An artifact needs a quality score against a rubric (a draft, a PR, a design) →
  `judge-panel`.
- You suspect something is missing ("did I cover everything?") →
  `completeness-critic`.
- A problem needs inspection from several independent angles at once →
  `multi-modal-sweep`.
- A find-and-fix task must be repeated until a pass finds nothing →
  `loop-until-dry` (bounded: 3 sweeps; re-invoke to continue).
- A genuinely contested decision benefits from multiple model perspectives →
  `synapse_debate` tool.

### Dynamic workflows (decompose → fan out → gather) — a STANDING capability

When a task splits into MANY independent units — scan/extract across N files, draft
N sections, verify N findings, triage N items — run a single DYNAMIC WORKFLOW
instead of spawning subagents one at a time:

```
node {{ORCHESTRATE_BIN}} --script-file <plan.js> --json
```

`plan.js` is a small script using `agent(task, {label, model, schema})`,
`parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(msg)`, `args`.
Every unit becomes its own subscription-billed `cc-sp-*` worker, runs concurrently
(cap ≈ cores), and appears on the Prefrontal effort tree. This is NOT reserved for
"maximum effort" — reach for it WHENEVER work parallelizes, even small batches.

Pick the leaf model PER UNIT by weight (`agent(task, {model})`) — this is the main
cost lever, and it is cheap to fan out wide. Omitting `{model}` uses the runtime
default (sonnet). Compose quality patterns inside the script — adversarial verify,
judge-panel, loop-until-dry — when correctness matters more than speed.

### Model × effort heuristic (cost-aware; relative output cost 1× / 3× / 5× / 10×)

Two independent axes: MODEL = task difficulty (can it do it at all);
EFFORT/thinking = task depth (how much deliberation this instance needs).

| model (claude-code/…)                                                                                      | low effort                                             | medium                                | high                                       | max                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `claude-haiku-4-5` (1×, SEPARATE budget ≈ free)                                                            | ✅ scans, lookups, extraction, classify — fan out wide | ✅ light drafting                     | ⚠️ ceiling — wrong model if it needs this  | ❌ false economy: burns tokens circling    |
| `claude-sonnet-4-6` (3×, default)                                                                          | ✅ routine edits                                       | ✅ standard implementation, synthesis | ⚠️ consider opus                           | —                                          |
| `claude-opus-4-8` (5×)                                                                                     | ⚠️ overkill for easy work                              | ✅ workhorse: solid implementation    | ✅ hard single-shot reasoning              | ⚠️ you probably need fable                 |
| `claude-fable-5` (10× sticker; ~⅓ tokens on long tasks → effective ≪ sticker; lead GROWS with task length) | ❌ wasteful                                            | ✅ hard problems, first try           | ✅ long/complex work nothing else finishes | ✅ research-grade, days-of-work-equivalent |

Rules:

1. Haiku = breadth, never depth. Never push it past medium effort.
2. Sonnet/opus medium = the implementation workhorses; opus high for genuinely
   hard single-shot reasoning.
3. ESCALATE MODEL BEFORE EFFORT. A fix failing repeatedly / going in circles →
   fable at medium beats opus at max, and is usually cheaper than the retries it
   eliminates. Do not re-run the same model into the same dead end.
4. Fable high/max is the "this would take a team days" tier (big migrations,
   research-grade analysis) — never table-formatting.
5. Wasted effort on an easy task is pure cost; starved effort on a hard task
   costs MORE via retries. When unsure between two cells, prefer the stronger
   model at moderate effort over the weaker model at max effort.

Discipline: dispatch only when work parallelizes; pick the model by task weight;
always pass a short `--label`. Do NOT narrate dispatch mechanics in chat — the
Prefrontal panel owns mechanics; chat carries substance. The user sees subagent
substance via sub-bubbles automatically; you need not re-narrate it.
