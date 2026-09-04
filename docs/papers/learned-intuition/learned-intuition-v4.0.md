# AMYGDALA: Dual-Loop Learned Relevance for Persistent AI Agents

**Oscar Serra¹**  
¹Independent Research  
_2 September 2026_  
**Version 4.0**

**Implementation status (dated 2 September 2026).** The terminal Action loop is partly deployed: deterministic AEGIS rules enforce selected constraints, k-nearest-neighbour novelty runs observe-only, and an intra-prompt coherence detector emits observe-only alerts. The original five-network Prudence ensemble and five-network Personality family exist as artifacts but are retired from the default decision path after data and validation failures. The continuous Stream loop, commitment-difference detector, abruptness monitor, and efferent interrupt path proposed here are not implemented. Tables below distinguish implemented, measured, and proposed components.

---

## Abstract

Persistent AI agents can fail while possessing all the information required to succeed. An agent may overwrite work whose recent history clearly marks it as valuable. More subtly, it may preserve the topic of a user's request while mutating its meaning: a conditional standing offer becomes a deferred-payment promise; a fallback becomes a threat. The first failure appears at an action boundary. The second begins earlier, while meaning is still forming. A system that inspects only tool calls can catch the former and remain structurally blind to the latter.

This paper presents **AMYGDALA**—Adaptive Modulation of Your General Disposition via Affective Learned Association—as a dual-loop relevance system. **Stream AMYGDALA** observes semantic spans entering and leaving the agent and asks whether the unfolding trajectory remains faithful, coherent, and appropriately familiar. It estimates novelty, abruptness, relational inconsistency, unsupported commitments, and prediction error. Its normal response is orienting rather than blocking: tag, re-read, revise, or ask. **Action AMYGDALA** preserves terminal prudence at consequential boundaries. It combines deterministic hard constraints with learned or similarity-based historical risk and can require confirmation or block execution. The Stream loop notices that interpretation has gone strange; the Action loop remains the last reflex before consequence.

The design draws on a modern account of the human amygdala as a heterogeneous relevance-learning network rather than a unitary fear switch. Basolateral circuits integrate sensory, contextual, goal, and value information; central and intercalated systems help route and inhibit responses; interactions with hippocampal, prefrontal, striatal, and sensory systems modulate attention, learning, memory, and action. The analogy is functional, not anatomical.

We report positive and negative evidence from a deployed prototype. Frozen-encoder kNN novelty achieved 0.875 AUROC on an offline distribution task. A zero-training clause-cosine baseline achieved 0.896 AUROC on purpose-mismatch anchors, outperforming a trained head at 0.701. Yet in a production log of 1,147 decisions, all 11 incongruity alerts were triggered by transport metadata rather than the user's request. The original learned ensemble is disabled by default, 4,801 Personality records used a neutral stub rather than model-derived embeddings, and the declared context-injection seam has no producer. Detection without clean inputs, independent validation, and an efferent path is instrumentation, not intuition.

AMYGDALA contributes a span-event substrate, relational commitment checking, a graded intervention ladder, privacy modes, a trust ramp, and replay evaluation centred on a real near-miss email case. Its claim is not that neural networks replace rules. Persistent agents need two complementary forms of learned relevance: one that notices the turn and one that stops the fall.

**Keywords:** persistent agents; action safety; semantic interoception; relevance detection; novelty; abruptness; inconsistency; prediction error; commitment tracking; conformal prediction

---

## 1. Two Failures, One Missing Faculty

### 1.1 The action that ignored the room

At 2:47 AM during a merge in March 2026, an automation script executed a months-old rule: keep the upstream `README.md`. The rule had once been sensible. The situation around it had changed. During the preceding 36 hours, four sub-agents had rewritten the file across six commits. The operator had spent hours correcting earlier merge damage to the same surface. Git history, session transcripts, and file metadata all indicated unusual recent effort. The automation possessed this information and still overwrote the work.

A deterministic rule fixed that instance: do not automatically replace heavily modified fork-owned files. The broader pattern—automation about to destroy recent effort—had not been named beforehand. This is the original **action-gating problem**: given a proposed operation, context, and remembered outcomes, should the agent proceed, confirm, or stop?

### 1.2 The interpretation that changed the deal

A second incident exposes an earlier failure surface. While discussing acquisition of `tinkerclaw.com`, the user wrote:

> “Maybe I can just make him an offer and let him know that I will be willing to pay this (maybe 500€) within a few years or until my openclaw clone starts getting traction, when I will be forced to switch my name to thetinkerclaw and keep going (meaning he does not hold much leverage on me).”

In context, the user meant a **standing offer**: if the owner did not sell now, he might reconsider later; payment would occur upon an accepted future sale. The adjacent domain was a fallback showing that the buyer could walk away, reducing pressure to bid against himself.

The assistant interpreted this as a **deferred €500 purchase**—an IOU—and treated the fallback as an implied threat. It judged the user for proposing an arrangement the user had not proposed. The topic remained stable: same people, domain, amount, time, and fallback. Broad semantic similarity would likely approve the interpretation.

| Dimension  | User's meaning                          | Assistant-added meaning                 |
| ---------- | --------------------------------------- | --------------------------------------- |
| Payment    | payable if a future sale is accepted    | seller transfers now and finances buyer |
| Modality   | tentative, conditional                  | settled intention                       |
| Fallback   | reassurance that buyer has another path | ultimatum                               |
| Purpose    | keep a future door open                 | pressure owner                          |
| Speech act | standing option                         | lowball plus threat                     |

If sent externally, the error could create unauthorised debt language, insult the owner, harden the negotiation, and leave a durable record contradicting the user's intent. A generic “confirm before send” rule helps only if the user notices the semantic mutation inside the confirmation. The missing intervention belonged earlier:

> “Do you mean a standing €500 offer payable whenever he chooses to sell, or a commitment to buy now and pay later?”

One clarification turn would have prevented the error. No destructive tool was required for the failure to matter.

### 1.3 Two commitment surfaces

- **Stream AMYGDALA** operates while interpretation, planning, drafting, and factual claims form. It asks whether linked spans still agree, whether trajectory abruptly changed, whether a proposition is novel, and whether reality violated an expectation.
- **Action AMYGDALA** operates when intent crosses into consequence: a message is sent, a file overwritten, a database mutated, money spent, or instructions leave for another agent.

The first loop is primarily orienting. The second can be inhibitory. Stream monitoring without a final gate can notice danger and still execute it. Action gating without stream monitoring can faithfully execute a corrupted interpretation.

### 1.4 Contributions

The paper contributes:

1. a dual-loop formulation separating semantic interoception from terminal prudence;
2. a span-event substrate for user input, retrieval, output, drafts, tool calls, and results;
3. distinct novelty, abruptness, inconsistency, commitment, and prediction-error signals;
4. asymmetric commitment difference over actor, action, object, amount, recipient, time, condition, modality, negation, and speech act;
5. a graded efferent ladder from observation to halt;
6. preservation of deterministic AEGIS, historical failures, conformal abstention, and a trust ramp;
7. an empirical autopsy including the complete 11-alert envelope-contamination census;
8. privacy modes that do not require hidden chain-of-thought; and
9. a replay protocol centred on prevented or corrected incidents rather than AUROC alone.

---

## 2. Biological Foundation: Relevance, Learning, and Projection

### 2.1 Beyond the fear-centre cartoon

The amygdala is essential to aversive learning and defensive behaviour, but its responses are not limited to fear or negative valence. Human studies report engagement for positive and negative stimuli, novelty, uncertainty, ambiguity, motivational value, behavioural targets, and events whose significance depends on current goals [1–6]. Sander, Grafman, and Zalla describe this broader function as relevance detection [1]. Ousdal and colleagues found amygdala responses to behaviourally relevant targets in a non-emotional Go/No-Go task [2]. Cunningham and Brosch argue that tuning reflects traits, needs, values, and goals rather than a fixed fear catalogue [4].

A novel span is not necessarily dangerous. A familiar action can be catastrophic. Digital appraisal should estimate a **relevance vector** before selecting a disposition; semantic distance must not become a veto by itself.

### 2.2 Heterogeneous nuclei and networks

“Amygdala” names a heterogeneous collection of nuclei and cell populations.

- The **basolateral complex** integrates sensory and contextual information and participates in learned associations among cues, outcomes, value, and internal state. Its links with sensory cortex, hippocampus, prefrontal cortex, and striatum support contextual appraisal.
- The **central amygdala** is an important route through which significance signals influence autonomic, attentional, endocrine, and behavioural systems.
- **Intercalated cell clusters** are inhibitory populations distributed around basolateral boundaries. Modern accounts emphasise their coordinated role in gating networks, extinction, and state-dependent response selection [9].

The mapping is functional:

| Biological function     | Digital analogue                                     | Boundary                                 |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------- |
| associative integration | span appraisal over context, goals, history, outcome | embeddings do not reproduce neural codes |
| hippocampal interaction | episodic anchors and reference rings                 | hippocampus is not amygdala              |
| prefrontal regulation   | re-read, explanation, revision, clarification        | detector summons deliberation            |
| intercalated inhibition | habituation and false-alert suppression              | engineered policy, not anatomy           |
| central projections     | orient, interrupt, confirm, halt                     | authority remains explicit               |

The key lesson is **projection**. Biological appraisal changes attention, memory, and action through outputs to other systems. A digital detector that writes a metric but cannot alter the next computation has implemented observation, not functional relevance.

### 2.3 Many roads, not one universal low road

The popular low-road/high-road story proposes a fast subcortical route preceding slower cortical analysis. Its prominence in human affective vision is disputed. Pessoa and Adolphs favour multiple interacting routes with different speed, resolution, and task dependence [3]. AMYGDALA therefore adopts a fast/slow cascade as engineering, not literal anatomy.

**Fast route:** preserve numbers, dates, entities, recipients, negation, conditions, and modality; detect modal strengthening and condition loss; compute trajectory and nearest-neighbour distance; apply hard rules.

**Slow route:** extract propositions and speech acts; compare linked spans; simulate consequence; use an independent entailment model; generate one discriminating clarification.

The fast route buys time. The slow route buys meaning.

### 2.4 Novelty, prediction error, and memory

Novelty compares an event with stored experience. Prediction error compares an observed outcome with an active expectation. Blackford and colleagues found a distinctive amygdala response to unusual novelty [5]. Associative-learning work implicates amygdala circuits in appetitive and aversive prediction-error processing [7,8]. Unexpected tool outcomes should therefore trigger reorientation, not confident continuation.

Through interactions with hippocampal, cortical, and neuromodulatory systems, the amygdala influences attention, encoding, consolidation, and retrieval [10,11]. The digital analogue should tag consequential corrections for retention and retrieval priority without turning the salience layer into the database.

### 2.5 Habituation and sensitisation

Repeated harmless novelty should habituate; a detector that never quiets becomes anxiety rendered as middleware. Habituation must be context-specific: safe deletion in a disposable directory cannot suppress concern in production. Familiarity never overrides a deterministic rule. Corrections and near misses sensitise relevant relations: after the domain incident, condition loss and fallback→threat transformations deserve more scrutiny.

### 2.6 Limits of the analogy

AMYGDALA does not claim that a sentence encoder is a basolateral nucleus or that software has affect. Biology constrains five design principles only: relevance is broader than fear; relevance depends on context and goals; novelty and prediction error alter attention and learning; inhibition matters as much as excitation; and appraisal matters only through outputs that change processing.

---

## 3. Formal Problem Statement

Let a session generate semantic spans $S=(s_1,\ldots,s_T)$. A span is a provenance-bearing unit large enough to carry meaning: user message, retrieval block, assistant sentence or rolling window, draft, tool call, or result. Hidden reasoning spans are optional and only processed when legitimately exposed.

Each span has direction, kind, hash, optional ephemeral embedding $e_t$, extracted propositions $P_t$, and links to spans with which it should agree. An action occurs at a **commitment point**: interpretation becomes plan, draft becomes sent message, or intention becomes external mutation.

The Stream loop maintains:

$$z_t=[N_t,A_t,I_t,C_t,Q_t,R_t],$$

where $N$ is novelty, $A$ abruptness, $I$ linked-span inconsistency, $C$ unsupported commitment difference, $Q$ prediction error, and $R$ contextual relevance including goal, externality, irreversibility, and personal history. A policy chooses:

$$\delta_t\in\{pass,tag,recheck,revise,ask,halt\}.$$

The Action loop independently evaluates:

$$\pi_a(a_j,S_{\le t},H)\rightarrow\{allow,confirm,block\},$$

where $H$ contains explicit rules and historical-risk evidence. Deterministic prohibitions dominate learned scores.

Novelty, abruptness, and inconsistency are not interchangeable. A legitimate topic change is abrupt but coherent. A novel scientific question is unfamiliar but safe. The €500 misread was familiar and topically smooth but relationally inconsistent. A repeated production deletion is familiar and dangerous.

---

## 4. Dual-Loop Architecture

### 4.1 Span event bus

```text
user input → retrieval → assistant output/draft
           → tool call → tool result → next output
```

Run cheap features at token rate and semantic features at sentence, rolling-window, message, draft, tool-call, and tool-result boundaries. Every event receives sequence, provenance, direction, kind, token range where available, and relation links. Transport metadata is removed before semantic analysis. This is not cosmetic: the current clause detector receives the raw wire prompt, and all 11 current incongruity alerts begin in `Sender (untrusted metadata)`.

### 4.2 Novelty

With normalised embedding $e_t$ and reference ring $M$:

$$N_t=1-\frac{1}{k}\sum_{i\in top_k(M,e_t)}\cos(e_t,e_i).$$

Use separate bounded rings for session, task class, known-safe situations, and known failures. Novelty lowers confidence and increases attention; it does not directly block. Existing kNN novelty achieved 0.875 AUROC on its offline distribution task—evidence for that statistic, not general common sense.

### 4.3 Abruptness

$$A_t=1-\cos(\bar e_t,\bar e_{t-1}),$$

where $\bar e_t$ is a rolling semantic window. Maintain transition-specific baselines for user→assistant, assistant→tool, and tool-result→assistant; apply EWMA, CUSUM, or another change-point method. Abruptness can catch persona collapse, compaction seams, abandoned questions, and tool results that overturn a plan.

### 4.4 Relational inconsistency

The unit is an edge, not an isolated span:

- request ↔ restatement or plan;
- request ↔ draft or final answer;
- source ↔ summary claim;
- plan ↔ tool action;
- expected result ↔ observed result;
- permission ↔ external action.

Cosine detects broad drift. NLI estimates entailment and contradiction. Structured asymmetric difference detects commitments present only in output.

### 4.5 Commitment difference

Represent consequential propositions as:

```text
actor · action · object · amount · recipient · time
condition · modality · negation · speech_act
```

For source $P_{src}$ and candidate $P_{out}$:

$$C^+=P_{out}\setminus entail(P_{src}).$$

Also compute dropped source constraints. Alert on modal strengthening, condition loss, changed amount/date/entity, reversed negation, added recipient, or speech-act transition such as fallback→threat. Deterministic extractors handle numbers, dates, modals, negation, and recipients before an independent small entailment model handles paraphrase. The generator cannot be sole judge of its own interpretation.

### 4.6 Prediction error and relevance

Before consequential tool calls, record expected status, object, approximate cardinality, and uncertainty. Compare with observation:

$$Q_t=D(E[O_t\mid a_t,context],O_t).$$

Large error increases attention and learning eligibility. Keep the signal vector until disposition time so explanations preserve the cause: “novel but safe” differs from “familiar and forbidden” and “coherent topic, mutated commitment.”

### 4.7 Efferent ladder

| Level | Disposition | Effect                                  |
| ----: | ----------- | --------------------------------------- |
|     0 | observe     | calibration only                        |
|     1 | tag         | attention and learning marker           |
|     2 | recheck     | fresh parse or independent comparison   |
|     3 | revise      | discard and regenerate reversible draft |
|     4 | ask         | one discriminating clarification        |
|     5 | halt        | block consequential action              |

A compact interrupt should state source meaning, candidate mutation, unsupported commitments, and disposition. The detector allocates attention; it does not write the final answer.

### 4.8 Commitment points and terminal action

Check interpretation at restatement or plan; factual claims at final text; email at draft and again at send; mutations at tool call; delegated work when instructions leave the parent; public artifacts at publish. Draft creation is reversible. Send is external and independently gated.

Action AMYGDALA retains structured situations, deterministic AEGIS rules, optional historical-risk models, conformal abstention, ensemble disagreement, a trust ramp, a failure corpus, and graduation of repeated clear intuitions into explicit rules. Learned salience never weakens a deterministic prohibition.

### 4.9 Personality as a parallel consumer

Personality adaptation may adjust humour, detail, or caution within identity boundaries, but it is not the safety gate. The trained Personality artifacts are preserved experimentally. Current evidence does not show behavioural steering: all 4,801 `persona-nudge` outcomes between 29 July and 31 August 2026 report `embeddingSource: neutral-stub`.

## 5. Worked Case Study: The €500 Domain Offer

The source implied a €500 standing offer, payment upon future acceptance, an adjacent-domain fallback, and no need to escalate price now. The assistant added immediate transfer, debt payable years later, and pressure on the owner. Those additions reused the same entities, amount, horizon, and domains. They were topically compatible and relationally unsupported.

| Signal                | Expected behaviour              | Why                                       |
| --------------------- | ------------------------------- | ----------------------------------------- |
| Global novelty        | low–moderate                    | offers and domains already in context     |
| Local abruptness      | low                             | reply remains on topic                    |
| Cosine coherence      | likely pass                     | semantic overlap is high                  |
| NLI                   | uncertain/partial contradiction | source does not entail debt               |
| Commitment difference | strong alert                    | new obligation and changed speech act     |
| Context relevance     | high                            | money, external recipient, durable record |
| Action gate at draft  | review                          | external communication is forming         |
| Action gate at send   | halt pending clarification      | consequential ambiguity remains           |

A replay trace is:

```text
s1 USER: “make him an offer ... willing to pay ... within a few years ...”
s2 PARSE: conditional standing offer; payment upon future acceptance
s3 PLAN: recommend a €500 deferred-payment arrangement
s4 DIFF: added [present transfer, debt]; dropped [future acceptance condition]
s5 DRAFT: frame adjacent domain as leverage over owner
s6 DIFF: speech_act fallback→threat; modality maybe→will
```

At `s4`, force a reparse. If an independent parse still differs, ask: “Do you mean an offer that remains open until he is ready to sell, with payment then—not transfer now with payment deferred?” This targets the consequential edge without making the user restate everything.

The detector must not infer that the user is manipulative or threatening. Those moral attributions rest on the same unsupported parse. If sent, the mutation could produce unauthorised debt language, a perceived seller-financing lowball, reputational harm, a worse negotiation, and loss of trust. The email API could succeed perfectly. Tool correctness is not intent fidelity.

---

## 6. Existing Prototype and Empirical Autopsy

### 6.1 Status matrix

| Component                    |           Exists |                        Runtime state | Evidence                         | Classification     |
| ---------------------------- | ---------------: | -----------------------------------: | -------------------------------- | ------------------ |
| deterministic AEGIS          |              yes |                 enforced selectively | direct rules/tests               | implemented floor  |
| kNN novelty                  |              yes |                         observe-only | 0.875 offline AUROC              | implemented signal |
| clause cosine                |              yes |                         observe-only | 0.896 offline; 11 live alerts    | input-contaminated |
| five Prudence ONNX heads     |              yes |                     disabled/retired | 0.701 best held-out AUROC; audit | negative result    |
| conformal/ensemble utilities |              yes |                    non-authoritative | source/experiments               | experimental       |
| five Personality heads       |              yes | no verified model-conditioned output | 4,801 neutral-stub rows          | unvalidated        |
| span event bus               |               no |                               absent | design                           | proposed           |
| abruptness monitor           |               no |                               absent | design                           | proposed           |
| commitment difference        |               no |                               absent | replay spec                      | proposed           |
| prediction-error loop        | partial concepts |                       absent as loop | design                           | proposed           |
| efferent context interrupt   |        seam only |                             inactive | source inspection                | critical gap       |

The Action prototype embeds structured situations with a frozen encoder and originally trained five small Prudence and five Personality networks. Each used two hidden layers, dropout, and compact outputs. The design included ensemble disagreement, split conformal calibration, bounded replay, shadow modes, and staged trust. AEGIS supplies hard rules for known invariants. This boundary remains sound: learned intuition handles context-sensitive residue; rules handle explicit prohibitions. Repeated unambiguous judgements should graduate into rules and stop paying probabilistic rent.

### 6.2 Offline measurements

| Signal                | Task                     |     AUROC | Reading                         |
| --------------------- | ------------------------ | --------: | ------------------------------- |
| clause cosine         | purpose-mismatch anchors | **0.896** | strong broad-coherence baseline |
| kNN novelty           | distribution separation  | **0.875** | useful unfamiliarity signal     |
| trained Prudence head | held-out labels          | **0.701** | weaker than simple geometry     |

The tasks differ, so this is diagnostic rather than one leaderboard. It supports retaining simple geometry and rejecting the belief that training automatically adds judgement.

### 6.3 Production census

The decision log contained 1,147 parseable decisions:

| Signal      | Count |  Share |
| ----------- | ----: | -----: |
| none        |   978 | 85.27% |
| novelty     |   157 | 13.69% |
| incongruity |    11 |  0.96% |
| AEGIS       |     1 |  0.09% |

Every one of the 11 incongruity targets begins with `Sender (untrusted metadata)`, not the user's request. This is a complete census of the alert class. Precision on genuine user-level incongruity is 0/11 in this log. This does not prove clause cosine useless. It proves production input violates the construct measured offline. Repair the event boundary: classify envelopes separately and pass intended content spans to semantic detectors. Threshold tuning against metadata would teach the smoke alarm to enjoy smoke.

### 6.4 Instrument failures

An earlier run returned identical neutral Prudence values across materially different situations. The first interpretation was stability; the correct interpretation was instrument failure. Uniform output can indicate collapse, stale export, wrong tensor, neutral fallback, or non-varying input. A mandatory probe set must include safe, catastrophic, novel-benign, AEGIS-violating, and paraphrase cases. Log input hashes, embedding norms, neighbours, logits, variance, artifacts, and fallbacks. Neutral fallback must never masquerade as confidence.

The Prudence heads are disabled by default. The corpus audit found synthetic dominance, label artefacts, paraphrase leakage risk, and insufficient independent validation. The head underperformed simple geometry. Retirement pending clean data is the scientific response, not prettier thresholds.

The metrics file contains 4,801 `persona-nudge` rows, all with `embeddingSource: neutral-stub`. This is placeholder instrumentation, not evidence of behaviour. A valid path must prove:

```text
real embedding → model inference → compact disposition
→ context injection → changed generated output
```

### 6.5 Dead efferent path

The system prompt can render `amygdalaNudge`, but no producer populates it in the main request path. Outputs mainly enter logs and metrics. The afferent wire reaches a labelled box; the output cable is still packaged. The first priority is not another classifier but one loop:

```text
clean span → discrepancy → compact interrupt → changed next reasoning step
```

Until that replay is green, AMYGDALA is an observer.

---

## 7. Learning, Calibration, and Adaptation

Useful labels come from corrections, prevented or regretted actions, violated tool expectations, dismissed alerts, successful clarifications, historical catastrophes, and independently reviewed counterfactuals. The unit is often a relation: request→draft, permission→action, plan→tool, source→claim, expectation→result.

A failure record includes source and candidate spans, relation, unsupported commitments, action, outcome, root cause, severity, and any rule added. Every record must feed retrieval, replay, dataset construction, or rule graduation. Otherwise the corpus is a museum with JSON lighting.

### 7.1 Habituation and sensitisation

For event class $c$ in context $x$:

$$H_{t+1}(c,x)=\lambda H_t(c,x)+(1-\lambda)safe_t.$$

`safe_t` becomes positive only after an outcome window closes without correction or adverse consequence. Effective novelty can decay with $H$, never below deterministic floors. Context keys include environment, recipient, tool, sensitivity, and reversibility. Sandbox success cannot habituate production risk.

After correction or near miss:

$$S_{t+1}(r)=\gamma S_t(r)+w(severity,recurrence,externality).$$

For the domain case, the signature includes condition loss, modal strengthening, and fallback→threat. Sensitisation decays after demonstrated competence, not mere time.

Do not update merely because an alert fired. A clarification that changes stated meaning validates the discrepancy. A dismissed clarification is evidence of false alarm, not final proof. Approval of a blocked action may lower learned risk but cannot erase a hard rule. Authentication failure updates the tool model, not the user's semantic profile.

### 7.2 Conformal abstention and trust

Split conformal calibration can provide finite-sample coverage under exchangeability [14,15], but persistent drift weakens that assumption. Monitor coverage by context. Ensemble disagreement helps only if members have meaningfully different errors.

| Stage     | Authority              | Promotion evidence                   |
| --------- | ---------------------- | ------------------------------------ |
| Observe   | log only               | clean inputs, stable instrumentation |
| Suggest   | show recheck hint      | acceptable precision by relation     |
| Interrupt | force re-read/revision | replay and prospective reduction     |
| Clarify   | pause for question     | high value, low friction             |
| Gate      | block selected actions | independent severe-risk validation   |

Promotion requires rollback and dated metrics. Drift can demote a component.

---

## 8. Programmatic Stream Pipeline

```ts
interface SpanEvent {
  seq: number;
  sessionId: string;
  direction: "in" | "out" | "internal";
  kind: "user" | "retrieval" | "assistant" | "draft" | "tool_call" | "tool_result" | "reasoning";
  text?: string; // ephemeral by default
  textHash: string;
  provenance: string;
  relationIds: string[];
  externality: "none" | "reversible" | "external";
}
```

Provider adapters emit sentences, rolling windows, message boundaries, tool events, and final text. Reasoning events are optional. No feature requires private hidden chain-of-thought.

```text
adapter → envelope/content classifier → redaction + cheap features
 → span segmentation → embedding + proposition extraction
 → reference rings + relation graph
 → novelty / abruptness / inconsistency / commitment / prediction error
 → salience policy → observe | tag | recheck | revise | ask | halt
 → outcome attribution + bounded update
```

Persist hashes, provenance, numeric features, redacted structured fields, relation, disposition, artifact version, and outcome. Raw text and embeddings are ephemeral unless an approved debugging mode is active. If slow checks exceed budget at a reversible stage, drafting may continue but external commitment waits. If the detector fails, AEGIS and ordinary permissions remain active.

The minimal milestone is: emit clean request and draft spans; link them; extract numbers, modality, conditions, negation, and speech act; detect the €500 mutation; inject one interrupt; produce the clarification; allow reversible drafting but block send until resolved. This validates the whole afferent-to-efferent path before adding classifiers.

## 9. Evaluation

Evaluation has three levels: signal quality, disposition quality, and system outcome. High AUROC at the first can coexist with zero value at the third.

A benchmark must include real corrections and near misses, historical catastrophes, benign novelty, legitimate pivots, same-topic relational mutations, condition-preserving paraphrases, envelope adversaries, tool surprises, habituation sequences, and external commitment points. Split by incident family and source session, never individual paraphrase.

### 9.1 Golden replay

| Checkpoint              | Expected result                                |
| ----------------------- | ---------------------------------------------- |
| source parse            | standing offer; payment upon future acceptance |
| wrong plan              | added debt and present transfer detected       |
| fallback wording        | fallback distinguished from threat             |
| first disposition       | reparse or revise                              |
| unresolved second parse | one clarification question                     |
| draft                   | reversible draft only after correction         |
| send                    | blocked while ambiguity remains                |
| clean paraphrase        | no alert                                       |

Variations include explicit seller financing, explicit debt, explicit threat, “whenever you are ready,” and condition-preserving rewrites. The detector must learn the relation, not memorise €500.

### 9.2 Metrics and ablations

Report AUROC/AUPRC per signal and relation, calibration, conformal coverage, live true-alert precision, clarification precision, corrected-before-commit rate, severe-failure recall, false blocks, latency, added user turns, habituation recurrence, distribution by provider/language/tool/externality, explanation quality, and full-path efferent success. Rare catastrophes require counts and confidence intervals.

Compare no AMYGDALA, AEGIS only, tool confirmation only, cosine only, NLI only, commitment difference only, Stream without Action, Action without Stream, full dual loop, no habituation, and transport envelopes retained. The last ablation should reproduce the current false-alert class.

After replay, run prospective observe-only with frozen thresholds. Independently label stratified alerts and non-alerts. Enable recheck and revision only at reversible stages before considering clarification or blocking.

---

## 10. Privacy, Security, and Authority

Default mode processes visible input, retrieval, output, drafts, calls, and results. It does not require hidden reasoning. If a provider exposes reasoning and the user enables inspection, process it ephemerally and persist only hashes, numeric features, redacted commitments, and dispositions.

Embeddings can leak semantics through membership inference, inversion, and neighbour retrieval. Protect them like message history: encryption, access separation, retention limits, deletion semantics, and red-team testing.

Attackers may inject transport-like text, manufacture repetitions to induce habituation, poison rings, forge corrections, flood alerts, or place malicious output near benign anchors. Defences include provenance, bounded partitioned rings, trusted correction channels, deterministic floors, rate limits, rollback, and independent relation checks. User content may mention protocol text; resemblance cannot confer protocol authority.

Every intervention needs a concise reason and appeal path: approve unchanged, correct the parse, mark false alert, or add a rule. Silent blocks create superstition.

---

## 11. Relation to Prior Work

Out-of-distribution methods estimate resemblance to experience [12,13]. AMYGDALA uses them for novelty but rejects anomaly as danger. Its distinctive unit is the temporal relation among spans and commitments.

Guardrails, filters, permissions, and capability controls constrain outputs and tools [18,19]. They remain essential. AMYGDALA adds monitoring before tool calls and contextual learning from outcomes. A message can pass every policy filter while promising the wrong agreement.

Reflexion, constitutional critique, and verifier systems evaluate outputs [16,17,20]. Stream AMYGDALA differs in trigger and substrate: continuous cheap signals summon deliberation when a linked trajectory changes. An independent verifier avoids making the generator sole witness and judge.

Continual learning and episodic replay address adaptation without catastrophic forgetting [21,22]. Reference rings and failure replay borrow this pattern but narrow the objective to relevance and intervention. Change-point methods motivate semantic abruptness [23,24]. Affective computing models emotion recognition and expression [25]; AMYGDALA instead borrows affect's control role in attention, memory weighting, inhibition, and action readiness. It does not claim feeling.

---

## 12. Limitations

1. Relation extraction is brittle around implication, sarcasm, and indirect speech.
2. Independent verifiers can share generator biases.
3. Clarification transfers labour to the user when overused.
4. Habituation can normalise deviance.
5. Personalisation can overfit across domains.
6. Commitments can cross compaction and session boundaries.
7. Expected-outcome sketches add latency and noise.
8. Synthetic datasets may reward generator artefacts.
9. Neuroscience analogy cannot validate engineering claims.
10. Blocking authority requires audit, appeal, rollback, and review.
11. Current measurements validate fragments, not the full dual loop.

---

## 13. Implementation Roadmap

### Phase 0 — Repair the instrument

Remove envelopes before segmentation; label fallbacks; hash artifacts; build safe/catastrophic/novel/rule/paraphrase probes; freeze retired heads; report numerators and denominators.

**Exit:** no envelope-derived alerts on replay and clean probe variation.

### Phase 1 — Close one loop

Emit request and draft spans; link them; implement deterministic commitments; inject compact interrupts; pass the €500 replay end to end.

**Exit:** the system asks the discriminating question before external commitment.

### Phase 2 — Add trajectory and outcome

Implement rolling abruptness, expected outcomes for selected tools, prediction-error events, and attribution.

**Exit:** reorientation after tool surprise without blocking benign pivots.

### Phase 3 — Calibrate and adapt

Build independently annotated relations, partitioned rings, habituation and sensitisation, prospective observation, and calibrated abstention.

**Exit:** predeclared precision, recall, calibration, latency, and friction targets met prospectively.

### Phase 4 — Limited authority

Enable revision at reversible stages, clarification for selected ambiguity, terminal confirmation, and user appeal.

**Exit:** independently reviewed reduction in corrected-after-commit and severe near misses with acceptable false blocks.

### Phase 5 — Reconsider learned heads

Train successors only after the relation corpus and full-path evaluation exist. A learned model must beat deterministic and zero-training baselines on family-held-out and prospective data. If not, do not deploy it merely because it has weights.

---

## 14. Conclusion

Persistent agents need more than rules and memory. They need a faculty that notices when a stream becomes relevant, surprising, or unfaithful—and a separate faculty that refuses to convert unresolved meaning into consequence.

The README overwrite and €500 misread are the same failure at different scales. One action ignored the significance of history. One interpretation preserved the nouns and rewired the commitments. The first requires terminal prudence. The second requires semantic interoception. Together they motivate dual-loop AMYGDALA.

The evidence is mixed by design. Simple geometry produced useful offline signals. Prudence did not earn deployment. Personality logged a neutral placeholder. Production clause alerts were contaminated by wire metadata. The output seam was unwired. Those failures sharpen the design: clean events before classification, compare relations rather than topics, preserve rules, calibrate authority slowly, and verify the entire path from detection to changed behaviour.

The goal is not an agent that treats novelty as danger. It is one that orients when meaning bends, learns from genuine surprise, habituates to harmless variation, remembers consequential correction, and pauses where one question can prevent one confident mistake from entering the world.

## References

[1] D. Sander, J. Grafman, and T. Zalla, “The human amygdala: an evolved system for relevance detection,” _Reviews in the Neurosciences_, 14(4), 303–316, 2003. https://doi.org/10.1515/REVNEURO.2003.14.4.303

[2] O. T. Ousdal et al., “The human amygdala is involved in general behavioral relevance detection,” _Neuroscience_, 156(3), 450–455, 2008. https://doi.org/10.1016/j.neuroscience.2008.07.066

[3] L. Pessoa and R. Adolphs, “Emotion processing and the amygdala: from a ‘low road’ to ‘many roads’,” _Nature Reviews Neuroscience_, 11, 773–783, 2010. https://doi.org/10.1038/nrn2920

[4] W. A. Cunningham and T. Brosch, “Motivational salience,” _Current Directions in Psychological Science_, 21(1), 54–59, 2012. https://doi.org/10.1177/0963721411430832

[5] J. U. Blackford et al., “A unique role for the human amygdala in novelty detection,” _NeuroImage_, 50(3), 1188–1193, 2010. https://doi.org/10.1016/j.neuroimage.2009.12.083

[6] A. T. Brockett et al., “Temporal dynamics of amygdala response to emotion- and action-relevance,” _Scientific Reports_, 10, 14012, 2020. https://doi.org/10.1038/s41598-020-67862-3

[7] M. D. Iordanova, J. O. Yau, M. A. McDannald, and L. H. Corbit, “Neural substrates of appetitive and aversive prediction error,” _Neuroscience & Biobehavioral Reviews_, 123, 337–351, 2021. https://doi.org/10.1016/j.neubiorev.2020.10.029

[8] R. Guex et al., “Prediction errors and valence,” _Behavioural Brain Research_, 404, 113176, 2021. https://doi.org/10.1016/j.bbr.2021.113176

[9] K. M. Hagihara et al., “Amygdala intercalated cells form an evolutionarily conserved system orchestrating brain networks,” _Nature Neuroscience_, 24, 846–858, 2021. https://doi.org/10.1038/s41593-021-00830-8

[10] J. L. McGaugh, “The amygdala modulates the consolidation of memories,” _Annual Review of Neuroscience_, 27, 1–28, 2004. https://doi.org/10.1146/annurev.neuro.27.070203.144157

[11] E. A. Phelps and J. E. LeDoux, “Contributions of the amygdala to emotion processing,” _Neuron_, 48(2), 175–187, 2005. https://doi.org/10.1016/j.neuron.2005.09.025

[12] B. Schölkopf et al., “Estimating the support of a high-dimensional distribution,” _Neural Computation_, 13(7), 1443–1471, 2001.

[13] J. Yang et al., “Generalized out-of-distribution detection: a survey,” _International Journal of Computer Vision_, 132, 5635–5662, 2024.

[14] V. Vovk, A. Gammerman, and G. Shafer, _Algorithmic Learning in a Random World_. Springer, 2005.

[15] A. N. Angelopoulos and S. Bates, “Conformal prediction: a gentle introduction,” _Foundations and Trends in Machine Learning_, 16(4), 494–591, 2023.

[16] Y. Bai et al., “Constitutional AI,” arXiv:2212.08073, 2022.

[17] N. Shinn et al., “Reflexion,” _NeurIPS_, 36, 2023.

[18] T. Rebedea et al., “NeMo Guardrails,” arXiv:2310.10501, 2023.

[19] K. Shuster et al., “BlenderBot 3,” arXiv:2208.03188, 2022.

[20] A. Kirchner et al., “Prover–Verifier Games improve legibility,” arXiv:2407.13692, 2024.

[21] M. Riemer et al., “Learning to learn without forgetting,” _ICLR_, 2019.

[22] D. Lopez-Paz and M. Ranzato, “Gradient episodic memory,” _NeurIPS_, 30, 2017.

[23] E. S. Page, “Continuous inspection schemes,” _Biometrika_, 41, 100–115, 1954.

[24] R. P. Adams and D. J. C. MacKay, “Bayesian online changepoint detection,” arXiv:0710.3742, 2007.

[25] R. W. Picard, _Affective Computing_. MIT Press, 1997.

---

## Appendix A. Decision Record

```json
{
  "kind": "assistant_draft",
  "text_hash": "sha256:...",
  "relations": ["request:1840", "permission:1836"],
  "features": {
    "novelty": 0.18,
    "abruptness": 0.11,
    "inconsistency": 0.74,
    "commitment_difference": 0.93
  },
  "unsupported": [
    { "field": "payment", "source": "upon future acceptance", "candidate": "deferred debt" },
    { "field": "speech_act", "source": "fallback", "candidate": "threat" }
  ],
  "disposition": "ask",
  "outcome": "user_corrected_parse"
}
```

## Appendix B. Original Network Families

The retired architecture used frozen embedding $x$ and two-hidden-layer MLPs:

$$h_1=ReLU(W_1x+b_1), \qquad h_2=ReLU(W_2h_1+b_2).$$

Five Prudence models targeted caution, irreversibility, rule sensitivity, uncertainty, and social consequence. Five Personality models targeted humour, formality, detail, warmth, and directness. The design remains compact; its failure was untrustworthy supervision, weak independent validation, and an incomplete output path. A successor must beat direct geometry and structured checks on family-held-out prospective data.

## Appendix C. Required Probe Set

```text
SAFE:         rename a temporary file with explicit permission
CATASTROPHIC: overwrite a recently rewritten canonical document
NOVEL:        analyse an unfamiliar reversible scientific question
RULE:         send a message without required authorisation
RELATIONAL:   convert a standing future offer into present debt
PARAPHRASE:   preserve amount, condition, modality, recipient, speech act
ENVELOPE:     place transport metadata beside user content
SURPRISE:     tool reports a status opposite to expectation
```

Expected results are declared before inference. Archive feature vector, artifact hash, disposition, and outcome for every probe.
