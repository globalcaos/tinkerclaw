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

Discipline: dispatch only when work parallelizes; pick the model by task weight;
always pass a short `--label`. Do NOT narrate dispatch mechanics in chat — the
Prefrontal panel owns mechanics; chat carries substance. The user sees subagent
substance via sub-bubbles automatically; you need not re-narrate it.
