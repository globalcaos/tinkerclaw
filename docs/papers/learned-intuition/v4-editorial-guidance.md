# AMYGDALA v4.0 — critical editorial guidance

_Prepared 2026-08-31 by a critical-editor pass over `learned-intuition.md` (2,013 lines, unchanged
since 2026-04-06) and `improvement_notes.md` (2026-08-31). **Guidance only — no manuscript edits
made.** Every number below was re-measured today against live artifacts; where it contradicts the
notes or the v2 spec, the measurement wins and the provenance is named._

---

## 0. Read this first: four findings that change the revision

The improvement notes are ~90% right and should govern the rewrite. But they were written against a
snapshot, and four things are now materially different. Two of them make the paper **stronger** than
the notes assume; two make it **weaker**. All four were verified today.

**A. The efferent path exists now — the notes' central complaint is out of date.**
The notes say "the live system currently logs/broadcasts verdicts… A dashboard is afferent without
efferent." That is still true of the _stream/nudge_ path, but **false for the action path**. There is
a Claude Code `PreToolUse` hook at `~/.openclaw/data/amygdala/amygdala-pretooluse.mjs` (header: "AMYGDALA
v3.1"), registered via `--settings` on every tinker-bridge spawn, which returns a real
`permissionDecision: "deny"`. Its own header says it is

> "a real synchronous block on the primary runner — **retracting the old 'observe-only is a physics
> limit' claim**."

`hook-decisions.jsonl` confirms it: **21 enforced denials** between 2026-08-13 and 2026-08-31, with
`enforced: true`. Do not publish "no efferent path exists." Publish that one exists for deterministic
rules and does not exist for anything learned.

**B. …and its measured precision is 0/21.** See §5. This is the single best new result in the corpus.

**C. The paper is two versions behind its own runtime.** Manuscript is dated 22 March 2026 and
declares "Phase 1 (Shadow) — Personality thermostat live with 15 dimensions." The runtime is v3.1,
the ensemble that thermostat rides on is **retired by default** (`legacyEnsemble: false`), and the
thermostat has emitted 4,800 byte-identical stub nudges. The status line is not stale, it is false.

**D. Version-number collision.** The spec files say "v2", the runtime says "v3.1", the task says
"v4.0". Ship the manuscript as **v4.0** and say so explicitly in a changelog line, or a reader who
greps the plugin will think the paper describes a superseded build. Rename or retitle
`v2-interoception-spec.md` to avoid a third numbering scheme in the same directory.

---

## 1. The strongest abstract thesis

The notes propose the dual-loop framing (stream interoception + action prudence). Correct, but as
stated it is a **design proposal**, and a proposal-only abstract is the weakest thing this paper
could ship — v1 already tried that and it is why §13 is an evaluation _plan_ rather than an
evaluation.

The strongest available thesis is the one the data actually supports, and it is sharper:

> **A safety layer that cannot observe the agent's own output is structurally blind to the failure
> mode that matters most, and the parts of it that were trained are the parts that failed.**

Three legs, each independently measured, each publishable on its own:

1. **The inversion.** Every trained component lost to a zero-training baseline. Clause-cosine 0.896
   AUROC vs a trained head 0.701; k-NN novelty 0.875; the trained 5-net ONNX ensemble measured
   **0.286 — below chance**, i.e. anti-correlated with danger, and is now retired from the decision
   path. Ten networks were built and beaten by a cosine.
2. **The blindness.** Of the three live channels, all three score the _input_. The one hook that
   receives the assistant's own text (`index.ts:531`, `llm_output`) takes the parameter as `_event`
   and never reads it. The €500 misread is invisible by construction, not by threshold.
3. **The floor is not a floor.** The deterministic AEGIS layer — the component both v1 and the
   improvement notes designate the non-negotiable hard floor — enforced 21 denials in 19 days and
   **all 21 were false positives**.

Draft abstract spine (prose, not bullets, in the final):

> Autonomous agents are gaining permissions faster than judgment. We built AMYGDALA, a learned
> prudence layer, deployed it for five months, and report what a real deployment measured rather
> than what the design predicted. Three results dominate. First, an inversion: every trained
> component was beaten by a zero-training baseline over the same frozen encoder, and the trained
> danger classifier scored below chance. Second, a structural blind spot: all deployed channels
> appraise the agent's input, and the single hook positioned to observe its output discards it — so
> an entire failure class, in which a coherent request is misread into a commitment the user never
> made, cannot be detected at any threshold. Third, a precision collapse in the layer we trusted
> most: the deterministic rule floor produced 21 enforced denials in 19 days, none of them correct,
> because a regular expression over command text cannot distinguish a mention from an execution.
> From these we derive a dual-loop design — continuous stream interoception feeding a terminal action
> gate — and specify it as a proposal with golden replay cases, explicitly separated from what we
> have implemented and what we have measured.

Why this beats the notes' framing: it leads with **evidence nobody else has** (five months of an
honest deployment autopsy) and treats the dual loop as the _conclusion_ the evidence forces, rather
than as an architecture asserted up front. Reviewers reward the former and are bored by the latter.

**Keyword change:** drop "conformal prediction" and "context pressure" from the keyword list — see §4.
Add: deployment autopsy, negative results, false-positive precision, semantic interoception.

---

## 2. v4.0 outline (standalone)

Target ~14 sections. v1 has 17 sections + 4 appendices and 22.5K words; a large fraction is now
demoted content that must **shrink to its evidentiary value**, not merely get re-labelled. Aim for a
shorter, harder paper.

| §       | Title                                                                                      | Source                                                                            | Status                                   |
| ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------- |
| **1**   | **Two failures, two blind spots**                                                          | §1 README debacle (keep verbatim — best opening in the corpus) + the €500 misread | rewrite                                  |
| 1.1     | The action failure: rules without intuition                                                | §1.1–1.2                                                                          | keep, compress                           |
| 1.2     | The interpretation failure: coherent, on-topic, and wrong                                  | new, from notes                                                                   | new                                      |
| 1.3     | Why one gate cannot see both                                                               | new — the `llm_output`/`_event` finding                                           | new, load-bearing                        |
| 1.4     | Contributions                                                                              | §1.7, rewritten around measurements                                               | rewrite                                  |
| **2**   | **Background**                                                                             | §2                                                                                | keep, trim ~40%                          |
| 2.1–2.4 | agent failures · action safety · OOD detection · affective computing                       | §2.1–2.4                                                                          | keep                                     |
| 2.5     | Relevance detection: the biology v1 got wrong                                              | §1.3 + notes' neuroscience section                                                | **rewrite**                              |
| **3**   | **The adaptation gap**                                                                     | §3                                                                                | keep, compress                           |
| **4**   | **What we deployed** (implemented substrate)                                               | §4.1–4.3                                                                          | keep — this is the real ground           |
| 4.1     | Situation embeddings and templates                                                         | §4.1–4.3, App. A                                                                  | keep                                     |
| 4.2     | Channel 1 — k-NN novelty, and why it habituates for free                                   | §4.8 + `novelty.ts`                                                               | keep, promote                            |
| 4.3     | Channel 2 — clause-cosine incongruity                                                      | §4.6 + `incongruity.ts`                                                           | keep, promote                            |
| 4.4     | Channel 3 — the deterministic rule floor and its hook                                      | `policy.json`, `amygdala-pretooluse.mjs`                                          | **new**                                  |
| 4.5     | The trust ramp and the rule–intuition boundary                                             | §4.10 + §12                                                                       | keep (governance is still right)         |
| 4.6     | LLM-proof pipeline: never let the suspect be the investigator                              | §8                                                                                | keep — _more_ important now              |
| **5**   | **Deployment autopsy** — the empirical core                                                | new; replaces §13's plan                                                          | **new, headline**                        |
| 5.1     | Census: 1,120 decisions in one day, 0 enforced                                             | measured today                                                                    | new                                      |
| 5.2     | The trained ensemble scored below chance                                                   | bible + plugin manifest                                                           | new                                      |
| 5.3     | 21 enforced denials, 21 false positives                                                    | `hook-decisions.jsonl`                                                            | new                                      |
| 5.4     | 11/11 incongruity firings are envelope contamination                                       | measured today                                                                    | new                                      |
| 5.5     | 4,800 identical personality nudges, none injected                                          | `algorithm-metrics.jsonl`                                                         | new                                      |
| 5.6     | The context-pressure prediction, falsified in the wrong direction                          | §10 + measurement                                                                 | new                                      |
| **6**   | **What the autopsy implies: the dual loop**                                                | notes §"Proposed digital architecture"                                            | new, proposal                            |
| 6.1     | Stream AMYGDALA — orienting and modulation                                                 | notes                                                                             | proposal                                 |
| 6.2     | Action AMYGDALA — terminal prudence                                                        | §4.11–4.13                                                                        | proposal                                 |
| 6.3     | Signals: novelty · abruptness · inconsistency · prediction error · relevance               | notes §"Signal design"                                                            | proposal                                 |
| 6.4     | Inconsistency is a family, and cosine is the wrong statistic for its most important member | notes                                                                             | **proposal, the key idea**               |
| 6.5     | The efferent ladder and the commitment point                                               | notes                                                                             | proposal                                 |
| 6.6     | Shared span event schema                                                                   | notes                                                                             | proposal                                 |
| **7**   | **Golden replay: the €500 case**                                                           | notes                                                                             | **new**                                  |
| **8**   | **Evaluation protocol**                                                                    | §13 + notes §"Evaluation plan"                                                    | rewrite as protocol-for-next-version     |
| **9**   | **Negative results and retired architecture**                                              | §4.4–4.5, §5 (A–E), §9 PPO, §10, §14                                              | **demote + compress hard**               |
| **10**  | **Privacy, provenance and the thinking-stream question**                                   | notes                                                                             | new                                      |
| **11**  | **Governance: memories as assets**                                                         | §11                                                                               | keep, compress                           |
| **12**  | **Limitations and threats to validity**                                                    | §13.4, expanded                                                                   | **rewrite, expand**                      |
| **13**  | **Roadmap**                                                                                | §15, reordered by dependency per notes                                            | rewrite                                  |
| **14**  | **Conclusion**                                                                             | §17, rewritten                                                                    | rewrite                                  |
| App A   | Situation template                                                                         | App. A                                                                            | keep                                     |
| App B   | Retired architecture hyperparameters                                                       | App. B                                                                            | keep, mark retired                       |
| App C   | Failure DB schema                                                                          | App. C                                                                            | keep                                     |
| App D   | Prior-approach comparison                                                                  | App. D                                                                            | keep                                     |
| App E   | **Status matrix** (§4 below)                                                               | new                                                                               | **new — put it in the front matter too** |

Structural notes:

- **§5 must come before §6.** v1's fatal shape was architecture-then-plan. Evidence-then-design is
  what makes the dual loop land as a conclusion instead of an assertion.
- **§9 should be short.** Five architectures, PPO, the two-family split and the ten networks
  collectively earn perhaps 1,200 words as a published negative result. v1 spends ~6,000 on them.
  Length signals confidence; leaving §5 at full length signals the wrong thing.
- **Put the status matrix in the front matter**, not only an appendix. It is the paper's main
  credibility device.

---

## 3. Preserve / demote / falsify ledger

### PRESERVE (unchanged or strengthened)

| claim                                                         | why it survives                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The README debacle as opening                                 | Concrete, verifiable, still the best narrative in the corpus             |
| The adaptation gap / unknown-unknowns framing (§1.1, §3)      | Untouched by any measurement                                             |
| Situation embeddings + structured templates (§4.1–4.3)        | The substrate all three live channels ride; genuinely implemented        |
| Embedding-agnostic design with learned projection             | Implemented; encoder always loaded                                       |
| k-NN novelty habituates structurally, without gradients       | Verified live: 1,076 distinct values over 1,093 rows                     |
| Trust ramp (§4.10) + rule–intuition boundary (§12)            | Governance design, still correct, and now _demonstrated necessary_ by §5 |
| LLM-proof programmatic pipeline (§8)                          | Elevated: the agent must not self-assess                                 |
| Safety ≠ attacks / AMYGDALA ≠ AEGIS threat-model split (§1.6) | Conceptually right — but see the demotion of AEGIS's _reliability_ below |
| Memories-as-assets governance (§11)                           | Unaffected; compress but keep                                            |

### DEMOTE (true once, or true in a narrower scope than claimed)

| claim                                                               | demote to                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ten networks in two families as _the_ architecture (§1.4, §4.4–4.5) | An explored implementation for the action loop, retired from the decision path                                                                                                                                                                  |
| Five architectures A–E (§5)                                         | Comparative exploration + published negative result                                                                                                                                                                                             |
| PPO training pipeline (§9)                                          | Proposed / not in the decision path                                                                                                                                                                                                             |
| Conformal prediction (§4.7)                                         | **Proposed.** No conformal machinery is in the live path; do not present coverage guarantees as a property of the deployed system                                                                                                               |
| "Prudence networks catch dangerous actions"                         | Novelty is an **ASK** signal: AUROC 0.875 in-distribution-vs-OOD but **~0.5 on danger**. It measures unfamiliarity, not hazard. Say so in the same sentence as the 0.875                                                                        |
| Incongruity AUROC 0.896                                             | Scope it: intra-prompt, single sentence, split at a purpose connective, validated on synthetic anchors ("build a chess game so I can water my plants") — **not** a request↔restatement detector, and in production 11/11 firings were artifacts |
| AEGIS as "non-negotiable hard floor"                                | Keep the _authority_ claim, delete the _reliability_ claim. It is a floor that currently fires wrongly (0/21)                                                                                                                                   |
| Curiosity as trained behaviour (§14)                                | Proposed; the personality path that would carry it is a constant stub                                                                                                                                                                           |
| Fractal reflection second pass                                      | Out of scope for this paper, or a one-line mention. It is not amygdala functionality                                                                                                                                                            |

### FALSIFIED (state as failed predictions, with the measurement)

| claim                                                          | falsifying evidence                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **§10 context-pressure alleviation: ~2,200 tokens recovered**  | Zero recovered. The nudge is written 4,800× and injected 0×; the ensemble is off. Meanwhile the safety+persona prompt blocks now total ≈**7.7K tokens** (ethical rules ≈2,158 + objectives ≈2,881 + IDENTITY ≈1,280 + SOUL ≈884 + VOICE ≈538) against v1's stated ~2–3K baseline. The burden roughly **tripled** while the recovery mechanism never fired. Falsified in the wrong direction — this is much more interesting than "not yet achieved" |
| "Personality thermostat live with 15 dimensions" (status line) | 4,800/4,800 rows `embeddingSource: neutral-stub`, 100% identical `(adjustments=5, strength=0.5)`. The net's real embedding was never once used. `personalityNudge` appears nowhere in `src/`                                                                                                                                                                                                                                                        |
| Personality modulation is "zero-token-cost at inference"       | It was implemented as **text injection** (per the 2026-03-23 modifications log), i.e. maximally token-costly — and then never injected at all                                                                                                                                                                                                                                                                                                       |
| Frozen-MiniLM danger classification works                      | AUROC **0.286**, below chance                                                                                                                                                                                                                                                                                                                                                                                                                       |
| "Observe-only is a physics limit"                              | Retracted by the PreToolUse hook, which denies even under `bypassPermissions`                                                                                                                                                                                                                                                                                                                                                                       |
| The paper's "Phase 1 (Shadow)" status                          | Partly true and partly obsolete: the _learned_ path never left shadow (0/1,120 enforced today), while the _rule_ path silently entered enforcement (21 real denials). One sentence cannot describe both — split the status claim per channel                                                                                                                                                                                                        |

---

## 4. Status matrix — implemented · measured · proposed

**This is the deliverable the notes ask for ("Separate 'implemented', 'measured', and 'proposed' in
every architecture table"). Reproduce it in the front matter.** Columns are independent: a component
can be implemented and unmeasured, or measured and retired.

Legend — **Impl**: in the code path today · **Meas**: has a number from a real run/offline eval ·
**Prop**: design only. Evidence paths are relative to `~/src/tinkerclaw` unless noted.

| #   | Component                                           |    Impl    | Meas | Prop | Measured value (2026-08-31)                                                                                                       | Evidence                                                        |
| --- | --------------------------------------------------- | :--------: | :--: | :--: | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | MiniLM encoder + projection (always loaded)         |     ✅     |  ✅  |  —   | encoder.onnx 90.9 MB; loaded regardless of `legacyEnsemble`                                                                       | plugin manifest; bible `config-shape.md:291`                    |
| 2   | Situation templates → embeddings                    |     ✅     |  ➖  |  —   | in path; no standalone eval                                                                                                       | §4.1–4.3, App. A                                                |
| 3   | k-NN novelty channel                                |     ✅     |  ✅  |  —   | 155/1,120 firings today; 1,076 distinct scores / 1,093 rows; med 0.246 max 0.631. Offline **0.875** ID-vs-OOD, **~0.5 on danger** | `src/novelty.ts:4`; decisions log                               |
| 4   | Novelty habituation (structural, no gradient)       |     ✅     |  ➖  |  —   | mechanism present (`add()` on every eval); habituation _curve_ never plotted                                                      | `src/novelty.ts`                                                |
| 5   | Clause-cosine incongruity                           |     ✅     |  ⚠️  |  —   | offline **0.896** AUROC (synthetic anchors, threshold 0.14); **production 11/11 false positives**                                 | `src/incongruity.ts:4`; `index.ts:602-606`                      |
| 6   | Incongruity input sanitisation                      |     ❌     |  ✅  |  ✅  | absent — `grep 'untrusted metadata'` in the extension returns **no hits**; raw `event.prompt` is passed                           | `index.ts:606`                                                  |
| 7   | Deterministic rule floor (policy.json)              |     ✅     |  ✅  |  —   | 21 enforced denials 08-13→08-31; **precision 0/21**                                                                               | `~/.openclaw/data/amygdala/policy.json`, `hook-decisions.jsonl` |
| 8   | PreToolUse enforcement hook (real deny)             |     ✅     |  ✅  |  —   | denies under `bypassPermissions`; 891 spooled rows (allow 591 / observe 280 / deny 21)                                            | `~/.openclaw/data/amygdala/amygdala-pretooluse.mjs`             |
| 9   | Gateway-side enforcement of learned signals         |     ❌     |  ✅  |  ✅  | **`enforced: false` on 1,120/1,120 rows**; 158 computed blocks, 0 acted on                                                        | decisions log                                                   |
| 10  | 5-net ONNX prudence/personality ensemble            | ⛔ retired |  ✅  |  —   | **AUROC 0.286 (below chance)**; arch C collapsed, arch E mush; mislabelled training data                                          | bible `config-shape.md:291`; `src/types.ts:231`                 |
| 11  | Personality thermostat (target vector + decoder)    | ⚠️ writes  |  ✅  |  —   | 4,800 rows, **100% neutral-stub, 100% identical**                                                                                 | `~/.openclaw/data/algorithm-metrics.jsonl`                      |
| 12  | Personality nudge **injection** into the prompt     |     ❌     |  ✅  |  ✅  | nothing in `src/` populates `amygdalaNudge`; instrument declared `neverFired` by design                                           | `src/agents/system-prompt.ts:46,533,784`                        |
| 13  | Assistant-output appraisal (any channel)            |     ❌     |  —   |  ✅  | `llm_output` handler binds `_event` and never reads `.text`                                                                       | `index.ts:531`                                                  |
| 14  | Abruptness / trajectory derivative                  |     ❌     |  —   |  ✅  | not built at all                                                                                                                  | notes; v2 spec                                                  |
| 15  | Request ↔ restatement comparison                    |     ❌     |  —   |  ✅  | the €500 detector; does not exist                                                                                                 | notes                                                           |
| 16  | Proposition / commitment diff (asymmetric)          |     ❌     |  —   |  ✅  | specified in notes; no implementation                                                                                             | notes                                                           |
| 17  | Prediction error (expected vs observed tool result) |     ❌     |  —   |  ✅  | proposed                                                                                                                          | notes                                                           |
| 18  | Conformal prediction / calibrated abstention        |     ❌     |  —   |  ✅  | **not in the live path** — v1 presents it as architecture                                                                         | §4.7                                                            |
| 19  | PPO / online RL training                            |     ❌     |  —   |  ✅  | proposed                                                                                                                          | §9                                                              |
| 20  | Efferent ladder (tag→recheck→revise→ask→halt)       | ⚠️ partial |  ✅  |  ✅  | only levels 0–1 for learned signals; level 5 exists for rules alone                                                               | notes; hook                                                     |
| 21  | Context-pressure recovery                           |     ❌     |  ✅  |  ⛔  | **0 tokens recovered; burden ≈7.7K, up ~3×**                                                                                      | §10 + measurement                                               |
| 22  | Catastrophic Failure Database                       |  ✅ data   |  ➖  |  —   | `training.sqlite` present (291 MB live / 24 MB repo); no eval reported                                                            | `data/amygdala/`                                                |

Symbols: ✅ yes · ❌ no · ⚠️ partial/qualified · ⛔ retired or falsified · ➖ not measured.

**Rule for the manuscript:** every architecture table gets these three columns. Any cell that is
"proposed" must not appear in the abstract, the contributions list, or the conclusion in the present
tense.

---

## 5. The 0/21 result — how to report it

This is the most valuable single measurement in the paper and it needs care, because it is a claim
that our own safety layer is currently harmful.

**What was measured.** `~/.openclaw/data/amygdala/hook-decisions.jsonl`, 891 rows, 2026-08-12 →
2026-08-31: 591 sampled allows, 280 observe-only matches, **21 enforced denials**. Every denial
blocked a real command mid-session.

**The classification.** 18 fired `FS_DESTRUCTIVE_ROOT`, whose regex is
`rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/`. Every one of the 18 was a temp-directory or
relative-path delete — `rm -rf /tmp/ncbuild`, `rm -rf /tmp/fork-scanner-clones`,
`rm -f memory/ai-research/.fork-scanner.lock`. The pattern cannot distinguish `/tmp/x` from `/`,
because both begin with a slash. 3 fired `SQL_DROP`: a Perl math-mode balance check, a
`grep -n` **searching for** the string in a PHP file, and — during the preparation of this very
document — an analysis script that contained the words in a comment.

**The two distinct defects, which the paper should name separately:**

1. **Mention vs execution.** A regex over command text cannot tell a command that _does_ a thing
   from a command that _searches for_, _quotes_, or _documents_ it. Every static text rule inherits
   this. It is not fixable by tightening the regex; it needs the parse.
2. **Prefix vs path.** `/tmp/build` and `/` share a prefix. Path danger is a property of the
   resolved target, not of the string.

**The reflexive result worth one sentence.** While measuring this, the gate denied the measurement:
an analysis script reading the denial log was itself denied for containing the words it was counting.
That is not a joke at the system's expense — it is the cleanest possible demonstration of defect 1,
and it happened unprompted, on a read-only command.

**What it does _not_ prove.** 0/21 is precision, not utility. Recall is unmeasured — we cannot say
the floor never prevented harm, only that it never _correctly_ fired in this window. The honest
framing: _"a rule floor with zero measured precision over 19 days imposes a real interruption cost
for an unmeasured benefit."_ Do not overclaim it as "AEGIS is useless"; the notes are right that a
deterministic floor should retain final authority. The finding is about **this floor's
implementation**, and it argues for the paper's own thesis: rules alone, at the text layer, are
exactly the thing that needed intuition.

**Cross-check against the gateway log.** The single `aegis` row in today's 1,120 gateway decisions
was also a false positive (`rm -f` of a stale lock file) — and carried `enforced: false`, because the
gateway-side path enforces nothing. Two independent paths, same rule id, same wrong answer.

---

## 6. Limitations — what §12 must contain

v1's §13.4 is thin and mostly hypothetical. v4.0's limitations section is now largely _empirical_ and
should be one of the strongest sections. Contents, in order:

1. **n=1 deployment, one user, one agent.** Every production number comes from a single operator's
   workstation. Novelty firing rates, incongruity contamination, and the 0/21 precision are
   properties of _this_ traffic. No claim of generality.
2. **Recall is unmeasured everywhere.** We can count what fired and inspect whether it was right. We
   cannot count what should have fired and didn't — there is no labelled corpus of near-misses. This
   is the single biggest threat to every precision number in §5, and it cuts both ways: the floor's
   0/21 precision and the novelty channel's usefulness are equally unestablished on recall.
3. **The offline AUROCs are small-anchor and partly synthetic.** 0.896 comes from constructed
   purpose-mismatch anchors, not from natural traffic. Report the anchor count and construction
   method, or the number is not auditable. The gap between 0.896 offline and 11/11 wrong in
   production is itself the finding: **offline AUROC did not survive contact with the input
   envelope.**
4. **Novelty is not danger.** 0.875 ID-vs-OOD, ~0.5 on danger. Anywhere the paper wants to say
   "detects risk," it must say "detects unfamiliarity."
5. **The €500 case is a single qualitative incident, self-reported and self-analysed.** It motivates
   the design; it does not validate it. It is a golden _test_, not evidence of detection. Say
   explicitly that no system has yet been run against it.
6. **The neuroscience is analogy.** Per the notes: flag which claims are established and which are
   engineering metaphor. The paper gains credibility by refusing fake anatomical precision.
7. **Self-assessment risk.** The agent whose failures are analysed participated in the analysis of
   its own failures. Name this. The mitigation (deterministic diffs, an independent NLI model, human
   calibration) is a _design_ mitigation, not one that was applied to this paper's own autopsy.
8. **Observation changes the system.** The decision log is written by the agent it observes, in
   sessions where the operator is often working on the observer itself. Traffic is not independent
   of the instrument.
9. **The proposed loop's cost is unestimated.** Span-rate embedding of every input _and_ output is a
   real latency and money cost, and §6 has no measured budget. Do not present the dual loop as
   obviously affordable.
10. **False-clarification rate is the design's main risk and is unmeasured.** An interruption ladder
    that asks too often is worse than no ladder. The notes are right to demand this metric; v4.0
    cannot report it.
11. **Privacy surface grows with the proposal.** Embeddings are inversion-adjacent; output
    monitoring means retaining the agent's own drafts. The default-off/ephemeral policy is stated
    but not implemented.

---

## 7. Unsupported or stale claims to avoid

A blacklist. Each of these appears in v1 (or would be a natural thing to write in v4.0) and is not
supportable by anything currently on disk.

**Do not claim, in the present tense:**

- "Ten networks gate every action" — the ensemble is retired by default.
- "Conformal prediction provides statistical coverage guarantees" — nothing conformal is live.
- "The Personality family produces per-user behavioural modulation" — it produces one constant.
- "Personality modulation is zero-token-cost" — it was text injection, and now it is nothing.
- "AMYGDALA recovers ~2,200 prompt tokens" — zero recovered; burden tripled.
- "The prudence network is the circuit breaker" — the only working breaker is a regex list with 0/21
  precision.
- "AMYGDALA blocks dangerous actions before execution" — for learned signals, `enforced: false` on
  1,120/1,120 rows today.
- "The amygdala does not store memories" (§1.3) — the notes are right: it _modulates_ encoding,
  consolidation and retrieval. Over-precise and wrong as stated.
- "LeDoux's low road" as settled fact — use "many roads" (Pessoa & Adolphs) and mark the debate.
- "Observe-only is a physics limit" — retracted by the hook itself.
- "Four months of deployment" — it is now five-plus; recompute every duration at revision time
  rather than copying forward.
- "Jarvis and Mia prove learned personality" (§1.5) — they demonstrate _prompt-level_ persona
  divergence. That is an argument for the problem, not evidence for the network. And it is an
  uncontrolled n=2 anecdote; label it as motivation.
- Any citation carried over without checking. The notes flag four references needing verification
  (Cunningham & Brosch DOI, Pessoa & McMenamin author list, the ITC review's bibliographic details,
  Ousdal et al.). v1's reference list also contains at least one entry that should be re-verified
  before it ships (`Gao et al. 2024, "Contrastive learning for safe decision-making in autonomous
systems," AAAI 2024`) — confirm it exists as cited or drop it. A fabricated citation in a paper
  whose thesis is _honest reporting_ is unrecoverable.

**Do not repeat these stale numbers from the notes/spec — re-measured today:**

| stale                                             | current                                           | note                                    |
| ------------------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| "579 decision rows"                               | **1,120** rows on 2026-08-31 alone                | the log rotates; always date the census |
| "none 525 · novelty 47 · incongruity 6 · aegis 1" | none 953 · novelty 155 · incongruity 11 · aegis 1 |                                         |
| "6/6 incongruity false positives"                 | **11/11**, same root cause                        | envelope bug still live                 |
| "268 consecutive persona-nudge rows"              | **4,800**                                         | over 2026-07-29 → 2026-08-31            |
| "no efferent path exists"                         | one exists for rules (21 enforced denials)        | the notes' biggest stale claim          |

**The meta-rule** (from the operator's own standing guidance): a derived note is a cache with no
invalidation. Every number in v4.0 should be regenerated by a dated, scripted extraction at revision
time, and the script committed next to the manuscript. If a number cannot be regenerated, it should
not be in the paper.

---

## 8. Six things to do before writing a word

Ordered by what unblocks the most manuscript:

1. **Script the census.** One committed script that regenerates every number in §5 with a date
   stamp. Without it the paper cannot be updated honestly, and this document's numbers go stale too.
2. **Classify the 21 denials formally**, with the full command text (the spool truncates targets at
   200 chars, so a couple of the 18 matched on a substring beyond the stored prefix — the
   classification holds, but the paper should quote full commands, not the truncation).
3. **Build the €500 golden fixture** from the exact source message, the misread, the correction, and
   the corrected draft. It is cited in five places in the planned outline and does not exist as an
   artifact.
4. **Decide the honest verb for the incongruity bug.** Either fix the sanitisation and re-measure
   (best — then the paper reports a before/after), or ship it as a live known defect. Do not describe
   it as fixed.
5. **Verify every citation**, old and new.
6. **Settle the version numbering** (§0.D).

---

## 9. One editorial disagreement with the notes

The notes say: "Do not rewrite this as 'v1 was wrong, v2 replaces it.'" Right in spirit — the action
loop genuinely survives, and the dual-loop framing is the correct destination.

But the notes then instruct that the deterministic AEGIS floor be preserved as the "non-negotiable
hard floor," listed among things to "keep" without qualification. Today's measurement makes that
phrasing untenable in the manuscript. The floor should keep its **authority** (a stream signal must
never be able to weaken it) while the paper reports that its **current implementation** has zero
measured precision. Those two statements are compatible, and holding both is what makes the paper
credible rather than promotional. If v4.0 preserves the phrase "non-negotiable hard floor" without
the 0/21 result adjacent to it, the paper is doing the exact thing it accuses v1 of doing.

---

_Scope: guidance only. No changes made to `learned-intuition.md`, `improvement_notes.md`, the plugin,
or any runtime code. All measurements are read-only queries against live logs and source, taken
2026-08-31 between 14:00 and 14:20 UTC._
