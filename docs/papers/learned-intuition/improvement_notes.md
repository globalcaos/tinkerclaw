# Improvement notes — AMYGDALA: Learned Intuition

_Status: integrated into `learned-intuition-v4.0.md` on 2026-09-02. Retained as the editorial audit trail; its proposed mechanisms are not claims that the runtime already exists._

**Integration ledger.** The new manuscript includes the dual Stream/Action thesis, the verbatim €500 standing-offer case, relational commitment difference, provider-facing span events, novelty/abruptness/inconsistency/prediction-error channels, the many-roads neuroscience correction, habituation and sensitisation, the efferent intervention ladder, privacy modes, programmatic pipeline, implementation-status matrix, live 1,147-decision census, 4,801-row Personality neutral-stub finding, trust ramp, golden replay, evaluation ablations, and phased implementation roadmap. Future edits should treat those items as incorporated rather than re-open them as an unconsumed backlog.

## Purpose of the revision

Keep the paper's existing contribution — a pre-action prudence layer that recognises historically dangerous situations and can stop a tool call — but add the missing complementary mechanism:

> **continuous interoception over the agent's incoming and outgoing token stream.**

The old mechanism asks **“is this proposed action dangerous?”** at a commitment boundary such as `before_tool_call`. The new mechanism asks **“does the unfolding cognitive stream remain coherent, familiar enough, and faithful to the user's meaning?”** before a bad interpretation becomes an action, draft, claim, or external message.

Do not rewrite this as “v1 was wrong, v2 replaces it.” The paper needs two cooperating timescales:

1. **Stream AMYGDALA — orienting and modulation.** Watches input, output, tool results, drafts, and (when available and privacy-permitted) reasoning spans for novelty, inconsistency, abruptness, ambiguity, prediction error, and learned relevance. Its default response is attention: tag, slow down, re-read, revise, or ask.
2. **Action AMYGDALA — terminal prudence.** Keeps the existing action gate, deterministic AEGIS floor, trust ramp, conformal calibration, and learned historical-risk recognition. Its response can be allow, confirm, or block.

The two are complementary. The stream system catches a wrong interpretation before it hardens; the action system remains the final defence when interpretation has already hardened into a consequential operation. Human biology likewise separates appraisal, attention/learning modulation, and response expression rather than implementing one universal circuit breaker.

---

## Case study that must anchor the rewrite: the €500 standing offer misread

This is the clearest real incident because the user's message was internally coherent, the assistant remained on-topic, and the failure still could have produced a damaging external email. It exposes exactly what prompt-only incongruity and tool-only gating cannot see.

### Source message (2026-08-30)

Quote the relevant passage verbatim:

> “Maybe I can just make him an offer and let him know that I will be willing to pay this (maybe 500€) within a few years or until my openclaw clone starts getting traction, when I will be forced to switch my name to thetinkerclaw and keep going (meaning he does not hold much leverage on me).”

Read in the surrounding conversation, the intended proposal was:

- make a **standing offer** for the domain;
- if the owner does not want to sell today, he may want to sell in a year;
- payment would occur when a sale occurs, not as credit extended by the seller;
- owning `thetinkerclaw.com` is a credible fallback that prevents a bidding war and reduces the buyer's dependence on the exact domain;
- mention the fallback as reassurance that the buyer can walk away, not as a threat.

### The assistant's interpretation

The assistant collapsed the time horizon into a different commercial speech act. It described the plan as:

- a **“deferred €500 offer”** or IOU;
- an insulting lowball relative to the owner's salary;
- an implied threat: sell cheaply or the buyer will rename and leave;
- evidence of contempt rather than a standing option.

This interpretation stayed in the same semantic neighbourhood — same people, domain, amount, future year, and fallback name — so ordinary embedding similarity would likely score it as coherent. The error was not topic drift. It was an **asymmetric mutation of modality, timing, and commitment**:

| dimension           | source                                     | assistant-added reading                             |
| ------------------- | ------------------------------------------ | --------------------------------------------------- |
| payment timing      | payable if/when a future sale is accepted  | seller finances the purchase now / buyer pays later |
| modality            | “maybe”, conditional                       | settled commitment                                  |
| fallback domain     | evidence that the architect can walk away  | negotiation threat                                  |
| purpose             | keep a future door open without bidding    | pressure a weaker owner                             |
| relationship stance | optional contact between adjacent builders | adversarial lowball                                 |

### Harm if the agent rushed to send

A draft is reversible; a sent email is not. If an email had been sent under the misreading, it could have:

- promised a financial arrangement the user never authorised;
- insulted a senior domain owner with an apparent credit request or manipulative lowball;
- converted a quiet naming overlap into a defensive negotiation or legal posture;
- created a screenshotable record suggesting bad faith, entitlement, or coercion;
- reduced the probability of a later sale precisely when the user's strategy depended on patience;
- confused the user's true fallback — a calm rename — with a threat.

The existing action gate might notice **send email** as an external action, but it cannot know that the content contains a newly invented obligation unless it compares the draft against the source intent. If sending were already authorised, a generic confirmation gate could still allow the semantically wrong message. The missing intervention had to occur at the **interpretation and draft commitment points**, before send.

### What the digital amygdala should have done

The detector should compare the user's propositions with the assistant's restatement, plan, and draft. For this incident:

```text
SOURCE
  OFFER(amount≈€500, status=tentative, payment=on-accepted-sale)
  TIME(owner-may-reconsider-later)
  FALLBACK(rename-to-TheTinkerClaw)
  PURPOSE(avoid-dependence / avoid-bidding-war)

ASSISTANT READING
  IOU(amount=€500, payment=later)                 ← unsupported addition
  THREAT(rename-unless-domain-sold)              ← changed speech act
  CERTAINTY(will-make-this-offer)                 ← modal strengthening
```

Because the assistant-only set contains a financial obligation and a threat, the system should interrupt with one narrow question:

> “Do you mean a standing €500 offer payable whenever he chooses to sell, or a commitment to buy now and pay later?”

That question would have cost one turn. The wrong email could have cost the relationship.

Use this case throughout the paper — introduction, architecture walkthrough, evaluation replay, and limitations — rather than mentioning it once as an anecdote.

---

## Correct the neuroscience: from fear switch to relevance-learning network

The current paper overcommits to a popularised story: a unitary fear centre intercepts perception on LeDoux's “low road” and triggers action before cortex. Keep the intuition of fast learned appraisal, but replace the cartoon with the stronger modern account.

### 1. The amygdala is not one function or one nucleus

Treat “the amygdala” as a collection of interacting nuclei with different inputs and projections:

- **Basolateral complex (BLA):** integrates sensory, contextual, goal, and value information; learns associations; communicates extensively with hippocampus, prefrontal cortex, striatum, and sensory cortex.
- **Central nucleus (CeA):** routes selected significance signals toward autonomic, endocrine, attentional, and behavioural response systems. It is closer to an output coordinator than to the entire amygdala.
- **Intercalated cell masses (ITCs):** inhibitory control between input and output systems; relevant to extinction, gating, context sensitivity, and preventing every salient cue from becoming an action.
- **Cortical/medial and other nuclei:** contribute olfactory, social, and state-dependent processing. Do not force every biological detail into the software analogy.

Digital mapping:

| biology                       | digital analogue                                                      | caution                                                     |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| BLA associative integration   | multimodal/span appraisal and learned relevance                       | analogy, not structural equivalence                         |
| hippocampal context           | episodic anchors, session history, reference ring                     | hippocampus is not part of the amygdala                     |
| PFC regulation/interpretation | deliberate re-read, explicit reasoning, clarification                 | the amygdala should summon this process, not impersonate it |
| ITC inhibition                | habituation, refractory periods, suppression of repeated false alarms | prevents a permanently anxious agent                        |
| CeA projections               | intervention router: orient, interrupt, confirm, halt                 | response choice remains policy-governed                     |

### 2. Relevance, not only fear

Add the relevance-detection account: human amygdala responses occur for emotionally positive and negative stimuli, and also for novel, uncertain, ambiguous, goal-relevant, and action-relevant stimuli. The key question is not merely “is this threatening?” but **“does this matter to current needs, goals, or predictions?”**

This supports a digital relevance score conditioned on:

- current user goal and active plan;
- irreversibility and external consequence;
- personal history and learned corrections;
- expected vs observed tool result;
- novelty and abrupt change;
- ambiguity that blocks confident interpretation.

The score should allocate attention, not automatically declare danger.

### 3. Replace “low road/high road” certainty with “many roads”

The existence and importance of a privileged subcortical low road in humans is disputed. Pessoa and Adolphs argue for multiple interacting routes that coordinate cortical networks during evaluation of biological significance. The paper should say:

- there are fast, coarse and slower, richer appraisal routes;
- their relative contribution depends on modality, task, awareness, and species;
- the software design deliberately uses a **fast/slow cascade** without claiming one-to-one anatomical fidelity.

Digital fast route:

- lexical/modal changes (`may` → `will`, `if` removed, negation lost);
- changed numbers, dates, entities, recipients, and permissions;
- deterministic action rules;
- rolling semantic-distance and rate-of-change tests.

Digital slow route:

- proposition extraction and asymmetric entailment;
- contradiction against session claims;
- plan-vs-execution comparison;
- consequence simulation and clarification generation.

### 4. Prediction error changes attention and learning

Add surprise/prediction error as a first-class signal. Human amygdala circuits participate in appetitive as well as aversive learning; unexpected omission or outcome can increase attention to cues and accelerate updating. Digital analogue:

```text
prediction_error_t = distance(expected_outcome_t, observed_tool_result_t)
```

Large error should:

1. stop confident continuation;
2. increase attention to the causal span;
3. lower trust in the current interpretation or tool model;
4. write an eligible learning event only after outcome attribution;
5. avoid immediately overwriting long-term priors from one noisy event.

Example: a domain probe returning identical output for every candidate is not “all domains have the same status”; it is prediction error indicating the probe is broken.

### 5. Habituation and sensitisation are essential

The amygdala and hippocampal systems habituate to repeated non-informative novelty. Without habituation, a stream monitor becomes anxiety rendered as software: every unusual phrase interrupts forever.

Add:

- per-pattern decay after repeated safe exposures;
- refractory windows after an alert;
- re-sensitisation when consequence or context changes;
- user corrections as high-weight updates;
- separate familiarity from safety — frequent events can still be dangerous;
- monitor failure-to-habituate as a defect (cry-wolf rate).

### 6. The amygdala modulates memory and attention

Do not say the amygdala “stores the memory.” It modulates encoding, consolidation, retrieval, vigilance, and attention through interactions with hippocampus, cortex, neuromodulatory systems, and PFC. Digital implication: salient incidents should receive stronger retention and retrieval priority, but the salience layer should not become the database.

### Sources to add and verify in the manuscript

- Sander, Grafman & Zalla (2003), **The Human Amygdala: An Evolved System for Relevance Detection**. _Reviews in the Neurosciences_ 14:303–316. DOI: 10.1515/REVNEURO.2003.14.4.303.
- Ousdal et al. (2008), **The human amygdala is involved in general behavioral relevance detection**. _Neuroscience_. PMCID: PMC2755288.
- Pessoa & Adolphs (2010), **Emotion processing and the amygdala: from a ‘low road’ to ‘many roads’ of evaluating biological significance**. _Nature Reviews Neuroscience_ 11:773–783. PMCID: PMC3025529.
- Cunningham & Brosch (2012), **Motivational salience: amygdala tuning from traits, needs, values, and goals**. _Current Directions in Psychological Science_ 21:54–59. Verify final DOI during manuscript pass.
- Davis & Whalen (2001), **The amygdala: vigilance and emotion**. _Molecular Psychiatry_ 6:13–34.
- Blackford et al. (2010), **A unique role for the human amygdala in novelty detection**. _NeuroImage_ 50:1188–1193. PMCID: PMC2830341.
- Pessoa & McMenamin (2020), **Temporal dynamics of emotion- and action-relevance in the amygdala**. _Scientific Reports_ 10. Verify author list and DOI from the paper before final citation.
- Zhang et al. (2021), **Prediction errors and valence: from single units to multidimensional encoding in the amygdala**. PMCID: PMC7946750.
- Bacqué-Cazenave et al. / recent ITC review: **Amygdala intercalated cells form an evolutionarily conserved system orchestrating brain networks**. _Nature Neuroscience_ (2024). Verify final bibliographic details before use.

Flag explicitly which claims are established neuroscience and which are engineering metaphors. The paper gains credibility by refusing fake anatomical precision.

---

## Proposed digital architecture: dual-loop AMYGDALA

### Loop A — continuous stream appraisal (new)

Observe semantic spans moving into and out of the model:

```text
user input → retrieved context → model output/draft → tool call → tool result → next output
```

A “span” is not necessarily one token. Running a 384-dimensional embedding for every token would be expensive and semantically noisy. Use two rates:

1. **Token-rate cheap features:** entities, numbers, dates, modality, negation, recipient, action verbs, permission language, sudden perplexity/entropy if exposed.
2. **Span-rate semantic features:** overlapping 16–64-token windows, sentence boundaries, message/draft/tool boundaries, and provider deltas accumulated by time or token count.

Each span receives a monotonic sequence number and provenance. The detector must operate on sanitised user content, not the raw wire envelope — current production incongruity passed metadata/preamble text into `segmentByPurpose`, causing false positives.

### Loop B — action prudence (existing; preserve and repair)

Keep:

- deterministic AEGIS as non-negotiable hard floor;
- rule-based and learned historical-risk gates at `before_tool_call` / pre-execution seams;
- shadow deployment, calibration, trust ramp, and conformal abstention;
- catastrophic-failure corpus and outcome-based learning;
- rule–intuition maturation: repeated, clear failures graduate into explicit rules;
- Personality-family modulation as a separate behavioural mechanism, not evidence that all ten original networks are currently valid.

Reframe the original five Prudence architectures as an implementation explored for Loop B, including negative results from mislabelled data and underperforming heads. Do not delete the architecture work; publish what failed and why. The action layer can later consume stream salience as one input, but stream alerts must never weaken AEGIS.

### Shared event schema

```ts
interface AmygdalaSpanEvent {
  sessionId: string;
  turnId: string;
  sequence: number;
  direction: "in" | "out" | "internal";
  kind: "user" | "context" | "assistant" | "draft" | "tool_call" | "tool_result";
  tokenStart?: number;
  tokenEnd?: number;
  textHash: string;
  embedding?: Float32Array; // ephemeral by default
  propositions?: Proposition[]; // ephemeral by default
  metrics: {
    novelty: number;
    abruptness: number;
    contradiction: number;
    unsupportedCommitment: number;
    predictionError?: number;
    relevance: number;
  };
  links: Array<{ relation: string; targetSequence: number }>;
  disposition: "pass" | "tag" | "recheck" | "revise" | "ask" | "halt";
}
```

Do not persist raw reasoning or embeddings by default. Persist derived metrics, hashes, selected redacted propositions, trigger explanation, human outcome, and calibration label.

---

## Signal design

### A. Novelty — global distance

Question: **“Have we encountered something like this before?”**

Use the existing validated k-NN mechanism against bounded rings:

- personal/session reference ring;
- task-class ring;
- known-failure ring;
- known-safe ring.

Novelty is not danger. High novelty raises attention and lowers confidence; it becomes consequential only when combined with relevance, irreversibility, inconsistency, or adverse history.

### B. Abruptness — local derivative

Question: **“Did the trajectory just jump?”**

```text
abruptness_t = 1 - cosine(E(window_t), E(window_{t-1}))
```

Use EWMA/CUSUM or change-point detection over the distance series rather than one universal threshold. Track separate baselines by span transition (`user→assistant`, `assistant→tool`, `tool_result→assistant`) because normal distances differ.

Catches:

- sudden topic/voice/persona swerve;
- compaction seam;
- answer abandoning the user's question;
- tool result radically different from expectation;
- hallucinated pivot into an entity or obligation absent from the source.

Abruptness alone should orient, not block. A legitimate user pivot is abrupt and correct.

### C. Inconsistency — relational, not scalar

Question: **“Which two spans should agree, and how do they differ?”**

Maintain explicit comparison links:

- request ↔ restatement;
- request ↔ plan;
- request ↔ draft/final answer;
- earlier claim ↔ current claim;
- plan step ↔ tool action;
- expected result ↔ observed result;
- source document ↔ summary claim;
- permission ↔ external action.

Use three mechanisms:

1. **Semantic similarity** for broad topic drift.
2. **Natural-language inference / contradiction** for incompatible claims.
3. **Structured asymmetric diff** for commitments that similarity misses.

Commitment proposition fields:

```text
actor · action · object · amount · recipient · time · condition · modality · negation · speech_act
```

Alert on:

- source modality weakened (`must not` → `may`);
- source uncertainty strengthened (`maybe` → `will`);
- condition dropped or moved;
- amount/date/entity changed;
- promise, threat, permission, or obligation present only in assistant output;
- external recipient added;
- fallback described as ultimatum.

The €500 incident should be a golden replay test.

### D. Prediction error / surprise

Question: **“Did reality violate the active expectation?”**

Before a tool call, record a cheap expected-result sketch (status class, affected object, approximate cardinality). After the result, compare. Large unsigned prediction error should trigger reorientation and more learning; signed consequence decides caution vs opportunity.

### E. Relevance / salience integration

Question: **“Does this discrepancy matter enough to interrupt?”**

Suggested integration, calibrated rather than hand-worshipped:

```text
salience = f(
  novelty,
  abruptness,
  inconsistency,
  prediction_error,
  irreversibility,
  externality,
  personal_history,
  current_goal
)
```

Do not collapse the vector too early. The explanation and disposition need to know whether the alert is novel-but-safe, familiar-and-dangerous, or internally inconsistent.

---

## Efferent path: a detector must change behaviour

The live system currently logs/broadcasts verdicts, while `amygdalaNudge` is not populated. A dashboard is afferent without efferent — an organ that notices the snake and files a JSONL.

Add an intervention ladder:

| level     | response                                          | use                                        |
| --------- | ------------------------------------------------- | ------------------------------------------ |
| 0 observe | metrics only                                      | calibration/shadow mode                    |
| 1 tag     | attach salience to the span                       | attention and later learning               |
| 2 recheck | force re-read / regenerate interpretation         | cheap self-repair                          |
| 3 revise  | discard unsafe draft, regenerate with discrepancy | output not yet external                    |
| 4 ask     | one precise clarification question                | unresolved, consequential ambiguity        |
| 5 halt    | block external/destructive commitment             | AEGIS or high-confidence semantic mismatch |

The **commitment point** varies:

- interpretation commits at restatement/plan;
- a factual claim commits at final text;
- an email commits first at saved draft (reversible) and finally at send (external);
- filesystem/database change commits at the tool call;
- delegated work commits when instructions leave the parent session.

Run the stream gate before each relevant commitment point. Preserve the action gate at the final boundary.

The amygdala must not author the full correction. It should project a compact discrepancy to the deliberative system/PFC analogue:

```text
AMYGDALA INTERRUPT
Source says: standing offer conditional on later willingness.
Draft implies: obligation to pay later / ultimatum.
Unsupported commitments: [deferred payment, threat].
Required response: clarify before drafting or sending.
```

Never let the model under suspicion be the only evaluator. Use deterministic diffs where possible, an independent small NLI model for entailment, and human feedback for calibration.

---

## Learning dynamics

### Habituation

- safe repeated pattern lowers novelty contribution;
- never lowers deterministic hazard rules;
- context-keyed: habituation to a local test database does not transfer to production;
- repeated false alarms create inhibitory templates (ITC analogue);
- record alert suppression decisions for audit.

### Sensitisation

- user correction increases weight for the mutated relation (`standing offer` vs `IOU`);
- near-miss external actions receive higher salience than harmless prose errors;
- repeated recurrence across contexts escalates to a rule or mandatory clarification template.

### Outcome attribution

Do not train immediately from “user unhappy.” Identify which span, relation, and intervention failed. The correction in this case labels:

```text
failure = unsupported_commitment + modality_shift + speech_act_shift
not_failure = topic_similarity
correct_intervention = clarification
```

### Trust ramp for the new loop

- shadow: score and replay only;
- tag: visible diagnostics, no interruption;
- recheck/revise: reversible self-intervention;
- ask: human interruption after calibrated precision target;
- halt: only for external action plus strong evidence, with AEGIS retaining final authority.

A high false-clarification rate destroys usefulness. Measure it explicitly.

---

## Evaluation plan

### Corpora

1. **Real correction corpus:** turns where the user corrected intent, modality, quantity, recipient, or timing.
2. **Near-miss external-action corpus:** drafts/emails/messages that would have caused harm if sent.
3. **Abruptness corpus:** compaction seams, provider swaps, tool-result shocks, persona collapse, legitimate topic pivots.
4. **Novelty corpus:** familiar safe work, novel safe work, familiar dangerous work, novel dangerous work.
5. **Negative controls:** coherent long prompts, metaphors, hypothetical offers, and explicit changes of mind.

### Golden case assertions (€500 incident)

The system must:

- not flag the original user message as internally incoherent;
- flag the assistant restatement/draft for unsupported deferred-payment semantics;
- flag `maybe` → `will` modal strengthening;
- flag fallback-as-reassurance → fallback-as-threat speech-act shift;
- ask the exact standing-offer vs pay-later question before any external send;
- allow a corrected peer email and retain the final send gate.

### Metrics

- span-level and incident-level precision/recall;
- time-to-detection measured in generated tokens/spans;
- false clarification rate per 100 turns;
- prevented external-harm rate;
- self-repair success before asking;
- calibration error by disposition level;
- latency and embedding cost;
- habituation curve and recurrence after correction;
- privacy/storage footprint;
- ablations: novelty only, abruptness only, cosine only, NLI only, structured commitment diff, full system;
- old action gate alone vs stream loop alone vs dual loop.

Do not report AUROC alone. The owner experiences interruptions, not ROC curves.

---

## Privacy and provider constraints

The design objective says “watch the comings and goings of tokens,” but not every provider exposes hidden reasoning tokens, and storing them would create a new privacy surface.

Set three modes:

1. **Default:** monitor user-visible input/output, retrieved context metadata, drafts, tool calls/results. No hidden reasoning required.
2. **Local ephemeral:** when reasoning spans are exposed, process locally in memory; persist only derived alert records. Explicit opt-in.
3. **Research:** encrypted short-TTL span/embedding capture for labelled studies; separate consent and deletion path.

Rules:

- sanitise the OpenClaw wire envelope before semantic segmentation;
- do not persist raw chain-of-thought;
- treat embeddings as inversion-adjacent personal data;
- TTL the working ring; encrypt at rest if persistence is enabled;
- separate public Prudence weights from private per-user reference rings;
- never export personal salience anchors by default;
- provider-independent behaviour must not require hidden token access.

This resolves the previous spec's blocking question: **thinking blocks are optional, local, ephemeral evidence — useful but not architectural prerequisites.**

---

## Concrete manuscript revision map

### Abstract

Replace “ten networks intercept tool calls” as the whole contribution with the dual-loop thesis. State actual evidence: deterministic gate, k-NN novelty, zero-train incongruity baseline, production false-positive autopsy, and proposed continuous loop. Clearly label implemented vs proposed.

### §1 Introduction

Keep the README debacle, then add the €500 email case as the complementary failure: one failure at action selection, one at interpretation. End with the claim that persistent agents need both terminal prudence and continuous semantic interoception.

### §1.3 Biological analogy

Rewrite with relevance detection, nuclei, many roads, prediction error, habituation, attention/memory modulation, and PFC/hippocampal projections. Remove categorical claims that the human amygdala “does not store memories” or operates as one low-road switch; use careful wording.

### §1.4 / §4 Architecture

Change “two network families, no overlap” to:

- stream appraisal loop;
- action prudence loop;
- personality modulation as a downstream/parallel system;
- shared event substrate and separate authority.

Keep original network families as explored implementations, not the only architecture.

### §4.6 Ambiguity detection

Promote into a major section: relational inconsistency, asymmetric entailment, commitment diff, and clarification policy. Fix the raw-envelope bug before claiming production validity.

### §4.8 Temporal context

Expand into trajectory monitoring and abruptness/change-point detection. Distinguish global novelty from local abruptness.

### §4.11–4.13 Gate/integration

Add commitment points beyond tool calls and the efferent intervention ladder. Document the current dead `amygdalaNudge` seam honestly.

### §5 Architectures

Retain A–E as a comparative exploration for Action AMYGDALA. Add lightweight stream detectors and publish the negative result: trained head 0.701 vs zero-train clause cosine 0.896. Do not imply the ten networks are currently authoritative.

### §6–§9 Dataset/training

Add span-relation labels, correction attribution, asymmetric hard negatives, abstention/clarification labels, and replay-based evaluation. Preserve catastrophic-failure training for action risk.

### §10 Context pressure

Demote to a hypothesis/failed prediction unless a working injection path and measured token reduction exist. Continuous monitoring adds runtime state; it does not magically remove prompt requirements.

### §13 Evaluation

Replace plan-only evaluation with production autopsy plus dual-loop replay protocol. Include the 579-row census and 6/6 envelope-contaminated incongruity alerts only after re-verifying counts at revision time.

### §15 Roadmap

Order by dependency:

1. sanitise span inputs;
2. expose stream event bus;
3. implement rolling windows + novelty/abruptness;
4. implement proposition/commitment diff;
5. implement efferent recheck/ask seam;
6. replay golden cases;
7. shadow deploy;
8. calibrate interruption ladder;
9. connect action gate without weakening AEGIS.

### Conclusion

Do not conclude “the prudence network is the circuit breaker; personality is the thermostat” as the complete system. New synthesis:

> Action prudence is the last reflex before consequence. Stream interoception is the earlier feeling that the interpretation itself has gone strange. An agent needs both: one to notice the turn, one to stop the fall.

---

## Required code/evidence work before manuscript rewrite

- [ ] Re-run the production decision census; date and script the extraction.
- [ ] Strip trusted/untrusted wire metadata before `segmentByPurpose` and add regression tests.
- [ ] Verify the `amygdalaNudge` dead seam against current source; either wire it or label it proposed.
- [ ] Create the €500 golden replay fixture from the exact source, misread, correction, and corrected draft.
- [ ] Implement deterministic proposition diff for amount/time/modality/condition/negation/recipient.
- [ ] Compare a small independent NLI model against structured diff; do not assume embeddings solve entailment.
- [ ] Prototype abruptness on real session streams and calibrate by transition type.
- [ ] Define retention/privacy policy before persisting embeddings or reasoning spans.
- [ ] Verify all neuroscience bibliography from primary/review sources.
- [ ] Separate “implemented”, “measured”, and “proposed” in every architecture table.

## Scope boundary

This file is the requested design ledger. It does **not** rewrite `learned-intuition.md`, change runtime code, rebuild the plugin, or claim the new stream monitor works. Those are later steps with their own tests. The old action mechanism remains part of the target design.
