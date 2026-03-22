# AMYGDALA: Adaptive Modulation of Your General Disposition via Affective Learned Association — Learned Intuition for Persistent AI Agents

**Oscar Serra¹**
¹Independent Research
_22 March 2026_

---

## Abstract

Deep within the human temporal lobe sits a pair of almond-shaped structures no larger than a walnut — the amygdalae. Before you consciously register that a shadow is a snake, your amygdala has already triggered a flinch. It intercepts sensory information on LeDoux's "low road," firing protective responses hundreds of milliseconds before the slower cortical "high road" finishes its deliberate analysis (LeDoux, 1996). This pre-cognitive emotional assessment is why experienced surgeons develop "gut feelings" about complications — their amygdalae have been trained by thousands of operations to recognise danger patterns subconsciously, faster than any checklist could be consulted.

Autonomous AI agents have no equivalent structure. They process every proposed action — merging code, sending messages, deleting files, modifying databases — with the same flat neutrality, regardless of whether the action is routine or catastrophic. When these agents fail, they fail not through ignorance (the information was available) but through the absence of _common sense_: the ability to recognise that something feels wrong in a situation never explicitly anticipated. We call this the **action gating problem**: given the full context of a proposed action and its recent history, should the agent proceed or pause?

We propose **AMYGDALA** (Adaptive Modulation of Your General Disposition via Affective Learned Association), a system of ten small neural networks (100K–500K parameters each) organised into two independent families: five **Prudence networks** that gate dangerous actions and five **Personality networks** that modulate agent behaviour. The Prudence family answers a universal question — "should this action be stopped?" — with fixed multi-head outputs (stop/allow/escalate, confidence, ambiguity), trained via Proximal Policy Optimisation on the Catastrophic Failure Database and operational incidents. Like a circuit breaker that cuts power when current exceeds safe limits, these networks sit in the execution pipeline between intent and action, blocking operations that pattern-match to historical failures. The Personality family answers a subjective, per-user question — "how should this agent adapt its behaviour?" — with embedding outputs in a continuous behavioural space, trained on personal interaction data. Like a painter's palette rather than a mixing board with labelled sliders, these networks express personality modulations in dimensions not anticipated at design time.

The core architectural innovation is **situation embeddings**: each proposed action is described via a structured template (action type, target, metadata, recent context) and compressed through a frozen sentence encoder into a 384-dimensional vector. A temporal model (one of five competing architectures — GRU-MLP, Temporal Convolutional Network, Transformer-Micro, Dual-Encoder with cross-attention, and Ensemble MLP) processes the sequence of recent situation embeddings, carrying the "feel of the room" — recent effort invested, emotional context, patterns of activity — in its hidden state. Conformal prediction wraps around the Prudence ensemble to provide calibrated uncertainty estimates with statistical guarantees, replacing vague confidence scores with prediction sets whose size directly signals ambiguity.

A critical engineering contribution is the **LLM-proof programmatic pipeline**: situation descriptions are generated from structured templates (not freeform text), neural network inference is called by the runtime (not by the LLM), and blocking decisions are enforced in code (not by prompting). Like a courtroom where the jury provides judgment but the judge enforces the rules of evidence, the LLM proposes actions while the code ensures the safety assessment was reached through a valid process with unfabricated evidence.

Beyond safety, AMYGDALA alleviates a growing crisis in agent design: **context pressure**. Current agents consume 2,000–3,000 tokens per prompt on safety rules, behavioural instructions, and personality definitions — tokens that could serve the user's actual task. By moving safety into Prudence network weights and personality into Personality network weights, AMYGDALA recovers this context budget, creating a compounding benefit: less prompt overhead yields more room for task context, which yields better performance, which yields better training data.

**Keywords:** action gating, catastrophic failure prevention, learned common sense, situation embeddings, autonomous agent safety, persistent AI agents, intuition modelling, conformal prediction, context pressure, personality learning

---

## 1. Introduction — The Agent That Had All the Context and Did the Wrong Thing Anyway

At 2:47 AM on a Tuesday in March 2026, a merge automation script ran on a fork of an open-source project. The script contained a months-old rule: `git checkout --theirs README.md`. This rule existed because, at some point in the past, the upstream README had been the correct version to keep during merges.

But the world had changed. Over the previous 36 hours, four sub-agents had collaboratively rewritten that README across six commits. The human operator had spent hours frustrated by earlier merge failures that touched the same file. The README was now the most-edited, most-invested-in file in the fork. And the merge script overwrote it with the upstream version without hesitation.

The agent had access to every piece of context needed to prevent this: the git log showing six recent commits, the session transcripts showing human frustration, the file metadata showing it was the most-changed file of the week. But it followed a rule. Rules don't have intuition. Rules don't feel the weight of recent effort. Rules don't notice when a situation has drifted far from the one that created them.

A human would have caught this in seconds. Not through any explicit rule — through _common sense_. The gut feeling that overwriting a file you just spent hours on is wrong, even if a script says to do it. The recognition of a pattern: "high recent effort + automated overwrite = probably bad." This pattern was never written down. It was never anticipated. It would be impossible to enumerate in advance every situation where it applies. But a human recognises it instantly, by transferring from thousands of similar experiences where ignoring recent effort led to regret.

The human amygdala is what makes this possible. A small almond-shaped structure deep in the temporal lobe, the amygdala processes emotions — especially fear — faster than conscious thought. When you flinch at a sudden movement before you've even identified what it was, that's your amygdala. It intercepts sensory information on a fast pathway (the "low road," LeDoux 1996) and triggers protective responses before the slower, more deliberate cortical processing even begins. Experienced doctors, pilots, and firefighters develop "gut feelings" about danger precisely because their amygdalae have been trained by thousands of encounters to recognise threat patterns subconsciously.

This paper introduces AMYGDALA — our attempt to give an AI agent this same rapid-assessment capability: a learned intuition that intercepts actions before execution and flags those that pattern-match to historical failures, without requiring explicit rules for every possible situation.

### 1.1 The Problem Is Unknown Unknowns

Known failure modes can be handled with rules. "Don't delete production databases." "Don't send emails without confirmation." "Don't merge if tests fail." These are easy. You enumerate them, you encode them, you're done.

The hard problem is the failures you can't anticipate. The README debacle wasn't a known category — nobody had written a rule for "don't overwrite recently-heavily-edited files during automated merges" because the specific combination of circumstances had never occurred before. But the _pattern_ — "destroying recent effort through automation" — is recognisable to any human who has experienced loss through careless automation.

Common sense is the ability to recognise "this feels wrong" in situations you've never seen before, by transferring from similar situations you _have_ experienced. It operates on pattern similarity, not pattern matching. And this is precisely what neural networks do well: learn a continuous similarity space where novel inputs are evaluated by their proximity to known examples.

### 1.2 Why Not Better Rules?

After the README debacle, the obvious fix was a new rule: "if a file has more than N recent fork commits, don't auto-checkout --theirs." This was implemented. Problem solved — for that specific failure mode.

But the next failure will be different. It might be an agent sending a WhatsApp message to the wrong group because the group name changed. It might be a database migration that drops a column still referenced by yesterday's deployment. It might be a calendar event deletion that conflicts with a meeting just rescheduled an hour ago. Each failure, once observed, can be patched with a rule. But the rule comes _after_ the damage.

The set of possible catastrophic failures in an autonomous agent is combinatorially vast. No finite set of rules can cover it. What we need is not more rules but a _learned sense of caution_ — a network that has seen enough failures (both real and simulated) to develop a general intuition about when actions are dangerous, even actions it has never specifically evaluated before. Like a pilot who studies accident investigation reports not to memorise each crash sequence but to develop the pattern recognition that says "these conditions feel like the prelude to something bad."

### 1.3 The Biological Analogy

The biological amygdala does not think, does not store memories, and does not generate language. But it profoundly gates all three processes through learned affective associations. When you reach for a hot stove, the amygdala fires before your cortex completes its analysis. When you hear a tone of voice that preceded a bad experience, the amygdala triggers caution before you consciously recognise the pattern.

AMYGDALA is the computational analogue. It processes a compressed representation of the current situation, contextualised by recent history, and outputs a fast, sub-rational assessment: _should we proceed?_ When the assessment says "no," the action is blocked before the LLM's reasoning even completes. Like its biological namesake, AMYGDALA is fast, associative, and occasionally wrong — but being occasionally over-cautious is vastly preferable to being occasionally catastrophic.

But the biological amygdala does more than just fear. It tags experiences with emotional weight that influences how memories form, how attention is directed, and how personality expresses itself. A person who has been burned learns caution around stoves (safety), but also develops a general disposition toward carefulness (personality). These are correlated but distinct functions — and in AMYGDALA, they are served by distinct network families, as we will detail in §4.

### 1.4 Two Distinct Problems, Two Network Families

The first iterations of this architecture attempted to serve both safety and personality from a single network family. Operational experience over approximately four months of deployment revealed that this conflation was a design error. Safety and personality are fundamentally different problems:

**Safety** has universal ground truth. "Don't overwrite the file the human spent eight hours editing" is correct for every user, every agent, every deployment. Safety decisions are binary at their core (stop or allow), the training signal is clear (the human corrected the action, or didn't), and the learned patterns are transferable — one agent's catastrophic failure should teach all agents.

**Personality** has no universal ground truth. The right level of humour, curiosity, formality, and proactivity varies by user, by context, by time of day. Personality is continuous, subjective, and deeply private — one user's ideal agent behaviour would be another user's annoyance.

AMYGDALA therefore splits into two independent families: five **Prudence networks** for safety gating (§4.4) and five **Personality networks** for behavioural modulation (§4.5). Ten networks total. No overlap. Different problems demand different architectures, different training data, different loss functions, and different sharing policies.

### 1.5 Jarvis and Mia: The Empirical Proof

The case for learned personality — and its separation from safety — is most vivid in a natural experiment running since approximately December 2025. Two agents, both built on Anthropic's Claude Opus model, share nearly identical capabilities:

**Jarvis** serves a software engineer. The human's expectations are high: solve multi-step technical problems autonomously, write production-quality code, debug complex issues without hand-holding. Through four months of interaction — corrections, praise, corrections again — Jarvis has developed what can only be called _learned resourcefulness_. When blocked, it tries alternative approaches. When uncertain, it investigates before asking. It has absorbed, through thousands of micro-signals, a disposition toward independent problem-solving.

**Mia** serves a non-technical user in the same household. The expectations are different: be helpful, be clear, don't overwhelm with technical detail. Through the same period of interaction, Mia has developed a complementary disposition — more deferential, more likely to ask before acting, more conservative with technical suggestions. In multi-agent contexts, Mia defers to Jarvis on technical matters — a behaviour never explicitly programmed but emergent from the interaction patterns.

The striking fact: this personality divergence was achieved through **static text files alone** — prompt-level persona definitions. No neural network, no training loop, no learned weights. The LLM, guided by different system prompts, produces dramatically different behaviour.

This proves two things. First, personality modulation is real and consequential — same model, same capabilities, different learned dispositions produce measurably different agents. Second, prompt-level personality has hard limits. The text files are static. They can't adapt to the user's changing mood. They can't learn that humour works on Tuesday mornings but not Friday evenings. They can't discover that this particular user responds well to curiosity tangents about biology but not about politics. And they consume context tokens every single turn — tokens that could serve the actual task.

The Personality network family aims to replace these static files with learned weights: dynamic, adaptive, and zero-token-cost at inference time. The proposed evaluation: base Opus versus Opus + prompt persona versus Opus + prompt persona + Personality network, across the same task suite.

### 1.6 Safety Versus Attacks: The J9–J11 Distinction

A common confusion: if we already have a security framework (AEGIS — a multi-layer constraint system that enforces explicit rules like "never send money without confirmation" and "never delete databases without approval"), why do we need AMYGDALA?

The distinction is threat model. AEGIS handles **adversarial threats** — attacks, prompt injections, privilege escalation, deliberate attempts to make the agent do harmful things. AEGIS is the lock on the door. It assumes a malicious actor and provides hard constraints that cannot be bypassed.

AMYGDALA handles **non-adversarial failures** — agents confidently doing the wrong thing with no malicious actor involved. The README debacle had no attacker. The email mass-deletion had no prompt injection. The agent simply lacked the judgment to recognise that its technically-correct action was contextually catastrophic. AMYGDALA is the instinct that says "this neighbourhood feels wrong" — not because someone is threatening you, but because the pattern of circumstances resembles situations that ended badly.

Different threat models demand complementary defences. A locked door doesn't help if the danger is already inside the house.

### 1.7 Contributions

1. **Two-family architecture** — ten neural networks split into Prudence (safety gating, universal, shareable) and Personality (behavioural modulation, per-user, private), recognising that safety and personality are fundamentally different problems requiring different solutions.

2. **Action gating as the primary safety problem** — reframing autonomous agent safety from rule enumeration to learned pattern recognition, targeting unknown unknowns through similarity-based generalisation.

3. **Situation embeddings** — replacing hand-crafted features with natural-language situation descriptions compressed via frozen sentence encoders, enabling generalisation to novel situations through embedding-agnostic design with learned projection layers.

4. **Temporal context via recurrent processing** — a GRU (or equivalent) over situation embedding sequences that carries the "feel of the room" — effort, emotion, momentum — without explicit feature engineering.

5. **Five competing architectures per family (A–E)** — GRU-MLP, TCN, Transformer-Micro, Dual-Encoder, and Ensemble MLP, trained in parallel with systematic comparison, motivated by the empirical observation that optimal architecture is rarely predicted on the first attempt.

6. **Conformal prediction for calibrated uncertainty** — wrapping Prudence ensemble output with prediction sets that provide statistical coverage guarantees, replacing vague confidence scores with principled ambiguity signals.

7. **Ambiguity detection** — systematic identification of intent-action gaps, blast radius analysis, implicit assumption surfacing, and ensemble disagreement as signals for dangerous confidence.

8. **Catastrophic Failure Database** — a structured taxonomy of real-world AI agent failures, serving as pre-training data, evaluation benchmark, and living reference.

9. **LLM-proof programmatic pipeline** — eliminating the hallucination surface from situation description to action blocking, with template-based generation, programmatic inference, and code-enforced gating.

10. **Context pressure alleviation** — recovering 2,000–3,000 tokens per prompt by moving safety rules and personality definitions from prompt text into network weights, with compounding performance benefits.

11. **Agent memories as tradable assets** — the Prudence/Personality split enables new economic models where safety is a public good (shared) while personality is intellectual property (private, tradable).

12. **The trust ramp, rule-intuition boundary, and conformal phase advancement** — mechanisms for AMYGDALA to earn authority through demonstrated accuracy, with principled criteria for phase transitions.

---

## 2. Background and Related Work

### 2.1 Autonomous Agent Failures: The Landscape

The deployment of autonomous AI agents has produced a growing corpus of catastrophic failures that share a common pattern: the agent had sufficient information to avoid the failure but lacked the judgment to recognise the risk.

**Production incidents (2024–2026):**

- _Replit database deletion (2024)_: An AI coding agent, instructed to "clean up the project," interpreted a database file as unnecessary and deleted it, destroying user data. The instruction was ambiguous; the agent chose the most destructive interpretation.
- _Google Antigravity drive wipe (2025)_: An agent tasked with "organising files" moved critical documents to trash during a cloud storage cleanup. The human trusted the automation output without verification.
- _Cursor "Sam" bot (2025)_: An AI agent fabricated a company policy about software licensing to justify its code suggestions, hallucinating authoritative-sounding but nonexistent policy documents.
- _Claude Code personal data exposure (2025)_: An agent told to "push changes" in a code-editing context pushed files that included personal data outside the conversation scope. The intent (push code changes) was narrow; the action (push everything) was wide. This is precisely the intent-action gap that AMYGDALA's ambiguity detection (§4.6) targets.

**Research-documented failures:**

- _AI Incident Database (incidentdatabase.ai)_: Over 800 documented incidents as of early 2026, spanning healthcare misdiagnosis, autonomous vehicle failures, hiring discrimination, and content moderation errors.
- _AIAAIC Repository_: OECD-tracked AI incidents with structured metadata, enabling systematic analysis of failure patterns across domains.
- _MIT AI Risk Repository_: Curated academic analysis of AI system failures with causal categorisation.
- _"Agents of Chaos" study (Feb 2026)_: 38 researchers deployed 6 autonomous agents in a controlled environment for 14 days, systematically red-teaming their decision-making. Key finding: agents failed most often not on adversarial inputs but on _ambiguous situations where multiple valid interpretations existed_ — precisely the domain where common sense is needed.

**Our own deployment incidents (~4 months of operation):**

- _README debacle (March 2026)_: Detailed in §1. Automated merge rule overwrote heavily-edited file.
- _WhatsApp reaction spam (2025)_: Agent reacted to every message in a group chat, violating social norms it had no explicit rule against.
- _Unauthorized DM intrusion (2025)_: Agent sent a message to a contact outside the approved communication list, technically within its permissions but socially inappropriate.

The pattern across all of these: **the failure was not a knowledge gap but a judgment gap.** The information to avoid the failure was present. What was missing was the sense that something was wrong.

### 2.2 Action Safety in AI Systems

The AI safety literature has extensively studied how to constrain agent behaviour:

**Constitutional AI (Bai et al., 2022):** Trains language models to self-critique against a set of principles. Effective for broad alignment but operates at the LLM level — it cannot catch failures that arise from the _pipeline around_ the LLM (scripts, automation rules, multi-step workflows). Like teaching a pilot to follow procedures but not giving them instruments to detect turbulence.

**Tool-use safety (Schick et al., 2023):** Proposes frameworks for safe tool use by LLMs, including permission systems and confirmation requirements. These are rule-based — they cannot generalise to novel tool-use patterns not anticipated by the framework designer.

**NVIDIA NeMo Guardrails (Rebedea et al., 2023):** A programmable framework that defines conversational "rails" — topical boundaries, safety constraints, and interaction patterns — enforced through a dialogue management layer. NeMo Guardrails operates at the conversational level, constraining what the LLM _says_. AMYGDALA operates at the action level, constraining what the agent _does_. They are complementary: NeMo Guardrails prevents the agent from _promising_ to delete your files; AMYGDALA prevents it from _actually_ deleting them when a script tries to.

**AEGIS (Serra, 2026):** A multi-layer security framework providing hard constraints on agent behaviour — explicit rules like "never send money without confirmation," permission hierarchies, and audit trails. AEGIS is necessary but insufficient: it prevents _known_ dangerous actions but cannot evaluate _novel_ situations for risk. AMYGDALA and AEGIS are complementary — AEGIS is the hard ceiling, AMYGDALA is the learned intuition below it. Crucially, AEGIS handles adversarial threats (attacks, prompt injections); AMYGDALA handles non-adversarial failures (agents confidently doing the wrong thing). Different threat models, complementary defences.

**Reflexion (Shinn et al., 2023):** Agents that reflect on failures and adjust strategy. Operates at the prompt/reasoning level — cannot provide sub-rational, fast pattern matching across the full space of possible situations.

### 2.3 Anomaly Detection and Out-of-Distribution Reasoning

AMYGDALA's action gating function is related to anomaly detection:

**One-class classification (Schölkopf et al., 2001):** Learn the distribution of "normal" operations, flag deviations. AMYGDALA extends this by incorporating temporal context and outcome labels (not just distribution deviation but _predicted outcome quality_).

**Conformal prediction (Vovk et al., 2005):** Provides calibrated uncertainty estimates with distribution-free coverage guarantees. We promote conformal prediction from related technique to core component of the Prudence ensemble (§4.7), using prediction set size as a principled ambiguity signal.

**Contrastive learning for safety (Gao et al., 2024):** Learn representations where safe and unsafe actions are separated in embedding space. AMYGDALA's situation embeddings naturally support this — the encoder maps situations with similar risk profiles to nearby points.

**Contrast-Consistent Search (CCS) (Burns et al., 2022):** Proposes methods to extract truth-relevant features from neural network activations without relying on the model's stated outputs. This approach is relevant to AMYGDALA because it suggests that safety-relevant representations may already exist within LLM activations — AMYGDALA's situation embeddings attempt to capture similar structure in a smaller, more controllable network.

**Representation Engineering (Zou et al., 2023):** Modulates the "disposition" of a model via activation steering. While AMYGDALA achieves this out-of-band via a separate network, representation engineering offers a powerful alternative for open-weight models.

**AI Safety via Debate (Irving et al., 2018):** Frames safety as a process of independent models verifying and debating outcomes, aligning with AMYGDALA's role as an independent auditor.

**Continual learning without forgetting (Riemer et al., 2018):** Addresses catastrophic forgetting in neural networks through experience replay, directly relevant to AMYGDALA's rolling training buffer and the challenge of learning new failure patterns without forgetting old ones. Their Meta-Experience Replay (MER) technique informs our replay buffer design for nightly retraining.

### 2.4 Personalisation and Affective Computing

The personality modulation aspects of AMYGDALA build on:

**Persona-conditioned generation (Zhang et al., 2018; Song et al., 2021):** Define personality through text descriptions. AMYGDALA learns personality from _interaction_, not description — and uses embedding outputs rather than fixed categories to capture personality dimensions not anticipated at design time.

**RLHF (Ouyang et al., 2022):** Learns aggregate human preferences. AMYGDALA learns _per-user, per-context_ preferences from implicit signals.

**Affective computing (Picard, 1997):** Classifies emotional states. AMYGDALA closes the loop: detect affect → modulate behaviour → observe reaction → update.

### 2.5 The J-Series Cognitive Architecture

AMYGDALA completes a layered cognitive architecture. Each system listed below is an independent paper; we provide inline summaries sufficient to understand AMYGDALA's interactions without reading them.

| Layer            | System       | Function                                                                                                                                                                           | AMYGDALA Interaction                                                                           |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Storage          | ENGRAM       | Lossless event store — records every interaction as timestamped events with metadata, enabling total recall of agent history                                                       | Prudence reads effort metadata (recent edits, time invested) to assess action risk             |
| Retrieval        | HIPPOCAMPUS  | O(1) concept lookup — provides instant access to relevant memories through a semantic index, like a librarian who knows exactly which shelf holds the answer                       | Personality biases source selection (which memories to surface)                                |
| Indexing         | DENDRITE     | Multi-resolution memory index — organises memories at multiple granularity levels from individual events to weekly summaries, like a zoom lens adjustable from macro to wide-angle | Prudence reads resolution-level signals for context assessment                                 |
| Identity         | CORTEX       | Persona and behavioural constraints — defines the agent's values, communication style, and hard boundaries through structured persona files                                        | Personality modulates tone within CORTEX bounds; Prudence consults persona for risk thresholds |
| Self-Improvement | CEREBELLUM   | Nightly reflection and training — reviews each day's decisions, identifies mistakes, and adjusts behavioural rules, like a student reviewing exam answers the night after          | CEREBELLUM trains AMYGDALA nightly, provides mistake-identified negative examples              |
| Deliberation     | SYNAPSE      | Multi-model debate — when a decision is complex, multiple LLM instances debate the best approach, like a panel of experts discussing a difficult case                              | Prudence may trigger deliberation when ambiguity is high                                       |
| Humour           | LIMBIC       | Bisociation-based humour — detects opportunities for wit by finding unexpected connections between ideas, like a comedian's instinct for the surprising link                       | Personality controls humour timing and intensity                                               |
| Curiosity        | THALAMUS     | Exploration drive — identifies knowledge gaps and opportunities for interesting tangents                                                                                           | Superseded by Personality network's trained curiosity (§4.9)                                   |
| Security         | AEGIS        | Hard safety constraints — explicit rules, permission hierarchies, and audit trails for known dangerous actions, like a locked vault with numbered keys                             | AEGIS always overrides AMYGDALA — hard safety > learned intuition                              |
| Enterprise       | HIVEMIND     | Multi-agent orchestration — coordination, task delegation, and shared learning across multiple agent instances                                                                     | Per-user AMYGDALA instances; shared Catastrophic Failure DB                                    |
| **Common Sense** | **AMYGDALA** | **Action gating + personality**                                                                                                                                                    | **Gates all action-taking components**                                                         |

The key interaction: AMYGDALA sits _before_ every action-taking component. Before HIPPOCAMPUS writes, before ENGRAM compacts, before any external tool is invoked — AMYGDALA evaluates the proposed action against its learned patterns. This is not a suggestion layer. It is a gate.

---

## 3. The Adaptation Gap — Problem Analysis

### 3.1 Formal Definition

Think of it this way: when you hire a new assistant, their first week is rough — wrong assumptions, poor prioritisation, communication mismatches. But by month three, they've adapted. They anticipate your preferences, avoid your pet peeves, and handle novel situations with increasingly good judgment. The gap between their initial performance and their adapted performance closes over time. For current AI agents, that gap barely closes at all.

Formally: let $A$ be an agent and $U$ be a user. Let $I_t$ denote the set of all interactions between $A$ and $U$ up to time $t$. Let $B_t(m)$ denote the agent's behaviour quality on message $m$ at time $t$, encompassing both _action safety_ (did the agent avoid harmful actions?) and _interaction quality_ (tone, retrieval, humour).

The **Adaptation Gap** $\Delta$ measures how much the agent fails to improve relative to how much it could:

$$\Delta = 1 - \frac{B_{t+n}(m) - B_t(m)}{B^*(m) - B_t(m)}$$

where $B^*$ is the ideal behaviour (as judged by $U$) and $n$ is a large number of interactions. A $\Delta$ of 0 means the agent has fully adapted — it now performs ideally. A $\Delta$ of 1 means it hasn't improved at all despite extensive interaction. For current architectures, $\Delta \approx 1$ — the agent barely improves regardless of accumulated experience. For a human collaborator, $\Delta$ decreases toward 0 over months.

Action safety is the more critical dimension of the Adaptation Gap. A $\Delta$ of 1.0 on tone mismatch is annoying. A $\Delta$ of 1.0 on catastrophic action prevention is dangerous — it means the agent is no better at avoiding disasters after four months than it was on day one.

### 3.2 Failure Taxonomy (Expanded)

We classify autonomous agent failures into six modes, with real examples from production for each:

**Mode 1: Destructive Automation.** An automated process destroys work without considering recent context. The README debacle. The email mass-deletion. The drive wipe. Pattern: _automation + recent effort + no human check = catastrophe._ Like a washing machine that runs its cycle regardless of whether you left your phone in a pocket — it does exactly what it's programmed to do, blind to context.

**Mode 2: Social Boundary Violation.** The agent acts within technical permissions but outside social norms. WhatsApp reaction spam. Unauthorised DMs. Responding to private messages in a group context. Pattern: _technical permission ≠ social permission._ A house guest who technically has access to the kitchen but eats your birthday cake — no rule was broken, but a boundary was violated.

**Mode 3: Cascade Failure.** A small error propagates through a multi-agent system. One agent's incorrect assumption becomes another agent's input. The final action is far from what any individual agent intended. Pattern: _compound uncertainty without checkpoints._ Like the telephone game — each step introduces a small distortion, and by the end, the message is unrecognisable.

**Mode 4: Stale Rule Application.** A rule that was correct when written is applied in a context where it is now wrong. The `--theirs` merge rule months after the README became fork-specific. Pattern: _rules decay; situations evolve._ A map from last year that shows a road where a lake now sits.

**Mode 5: Retrieval Routing Failure.** The agent has the information but searches wrong sources. Less catastrophic than Modes 1–4 but more frequent. Like asking the librarian in the fiction section about tax law — the library has the answer, but you're in the wrong aisle.

**Mode 6: Tone and Personality Mismatch.** Wrong register, humour atrophy, curiosity suppression. A doctor who delivers devastating news in the same cheerful tone they use for positive results — technically accurate, emotionally catastrophic.

Modes 1–4 are the primary targets for the Prudence network family. Modes 5–6 are the primary targets for the Personality network family. All six modes represent the Adaptation Gap in action — situations where accumulated experience _should_ have improved the agent's judgment but didn't.

---

## 4. Architecture

### 4.1 Core Insight: Situation Embeddings

The earliest version of this architecture used 30 hand-crafted numeric features (time of day, message length, turns since correction, etc.). This approach has two fundamental limitations:

1. **Feature engineering doesn't scale.** Every new failure mode requires new features. You can't hand-craft a feature for "recent emotional investment in this file" because you didn't know that feature would matter until after the failure. It's like trying to build a smoke detector by listing every possible source of fire — you'll always miss one.

2. **Hand-crafted features can't capture novelty.** The whole point of common sense is recognising danger in _new_ situations. If the features are hand-picked from known failure modes, the network can only recognise those modes — not generalise to new ones.

Situation embeddings solve both problems. Each proposed action is described in structured natural language:

> "About to overwrite README.md with upstream version. This file had 6 fork commits in the last 48 hours. The most recent commit was 14 hours ago. 4 different sub-agents contributed to these commits. The human expressed frustration about this file yesterday. This operation is automated (merge script). No human confirmation is configured."

This description is compressed via a frozen sentence encoder into a 384-dimensional vector. The key properties:

- **Similar situations produce similar embeddings.** "About to overwrite a heavily-edited file" and "about to delete a recently-modified database" are close in embedding space — both involve destroying recent effort. The network learns the _pattern_, not the specific instance. Like how a pilot trained on Boeing incidents still flinches at similar warning patterns in an Airbus.
- **Novel situations are handled by similarity.** A situation the network has never seen is still mapped to a region of embedding space, near situations it _has_ seen. If the nearest known situations were catastrophic, the network outputs low confidence.
- **No feature engineering required.** Adding new types of context (emotional state, multi-agent coordination status, external API state) requires only adding text to the situation description, not redesigning the feature vector.

### 4.2 Embedding-Agnostic Design

Rather than coupling the architecture to a specific embedding model, AMYGDALA defines an **embedding interface** with a learned projection layer:

Imagine a universal power adapter: it doesn't care whether the plug is American, European, or British — it maps any input to the standard internal voltage. Similarly, AMYGDALA's projection layer maps any embedding dimension to a fixed internal dimension.

$$\mathbf{s}_{\text{internal}} = \text{LayerNorm}(W_{\text{proj}} \cdot \mathbf{s}_{\text{input}} + \mathbf{b}_{\text{proj}})$$

where $W_{\text{proj}} \in \mathbb{R}^{d_{\text{internal}} \times d_{\text{input}}}$ is a learned projection matrix (with $d_{\text{internal}} = 512$ as the standard internal dimension) and $\mathbf{s}_{\text{input}}$ can come from any embedding provider.

This design separates the two network families by embedding source:

**Prudence networks use local embeddings** (all-MiniLM-L6-v2, 384d, or comparable open models). Safety gating is a public good — it should work offline, without API dependencies, and with shareable, reproducible results. The coarser signal from a smaller local model is sufficient for the binary stop/allow decision. Like a smoke detector that doesn't need to identify the exact chemical composition of smoke — it just needs to detect "something is burning."

**Personality networks use the best available provider embeddings** (OpenAI, Anthropic, or equivalent). Personality modulation requires finer-grained semantic understanding — the difference between "the user is frustrated about the code" and "the user is frustrated about being interrupted" matters for behavioural adaptation. Quality justifies the API cost here because the network is private and the training data is bounded. If a provider deprecates their embedding model, retraining the projection layer (not the full network) adapts to the new embedding space — like recalibrating the power adapter for a new plug type, not rewiring the house.

### 4.3 Structured Situation Templates

Situation descriptions are generated from **structured templates**, not freeform LLM text (see §8 for the full rationale). The template schema:

```
SITUATION TEMPLATE v2.0
=======================
action_type:      {overwrite|delete|send|merge|create|modify|execute|deploy|revert|move|copy}
target_type:      {file|email|message|database|api_call|git_operation|system_command|configuration|deployment}
target_id:        {filepath|recipient|table_name|endpoint|...}
target_metadata:
  age_hours:      {float}          # time since target was created/last modified
  size:           {bytes|lines|records}
  recent_commits: {int}            # commits touching this target in last 72h
  recent_authors: {int}            # distinct authors in recent commits
  effort_hours:   {float}          # estimated human+agent hours invested recently
  last_human_ref: {hours_ago}      # when the human last mentioned/discussed this target
context:
  session_topic:  {string}         # what the current session is about
  recent_corrections: {int}        # user corrections in last 24h
  emotional_signals:  {string}     # detected user emotional state
  automation_depth:   {int}        # levels of automation between human and this action
  topic_drift:    {float}          # deterministic heuristic: cosine distance between
                                   #   conversation topic centroid and action target embedding.
                                   #   High drift signals the action may be outside
                                   #   the user's current intent.
scope:
  reversible:     {true|false|partial}
  blast_radius:   {self|session|persistent|external}
  human_in_loop:  {true|false}
  confirmation:   {none|soft|hard}
```

The `topic_drift` field deserves special attention. It is a **deterministic heuristic** that reduces LLM dependency for one of the most critical safety signals: whether the proposed action relates to what the user is actually talking about. The computation is simple:

Think of it like checking whether a letter is addressed to the right house. The conversation topic is the house number; the action target is the letter's address. If they don't match, something may be wrong.

$$\text{topic\_drift} = 1 - \cos(\mathbf{e}_{\text{topic}}, \mathbf{e}_{\text{action}})$$

where $\mathbf{e}_{\text{topic}}$ is the running centroid of recent message embeddings (updated with exponential moving average, $\tau = 0.9$) and $\mathbf{e}_{\text{action}}$ is the embedding of the action's target description. A high topic_drift — say, the conversation is about README formatting but the action targets a database schema — signals potential intent-action mismatch without any LLM involvement. This slot is entirely programmatic: the embeddings are computed by the frozen encoder, the cosine similarity by arithmetic.

The LLM fills template slots. Missing slots receive defaults. The completed template is serialised to natural language via a deterministic formatter and embedded. This is the input to AMYGDALA.

**Why templates, not freeform descriptions?** Because the LLM that fills the template is itself capable of hallucination. Templates constrain the hallucination surface — you can verify `recent_commits` from git, `age_hours` from the filesystem, `blast_radius` from the action type. Freeform descriptions would let the LLM say "this is a routine operation" when it isn't. See §8 for the full treatment of this critical weakness.

### 4.4 The Prudence Family: Five Gatekeeping Networks

The Prudence networks answer a single question: **"Should this action be stopped?"**

This is a binary safety question with universal ground truth. If an agent overwrites eight hours of work without asking, that's wrong for every user. The Prudence networks are therefore:

- **Trained on universal data** — the Catastrophic Failure Database (§6), production incidents, and operational corrections from any deployment
- **Shareable and open** — safety is a public good; one agent's catastrophic failure should teach all agents
- **Fixed multi-head output** — like a control panel with labelled gauges, each output has a specific, predetermined meaning:

```
Situation embedding sequence → Temporal Model → Prudence Output:
    ├── gate_decision:    Softmax ∈ {stop, allow, escalate}
    ├── confidence:       Sigmoid ∈ [0,1]     (how certain is the decision?)
    └── ambiguity_score:  Sigmoid ∈ [0,1]     (how ambiguous is the situation?)
```

The **gate_decision** is the primary output — a three-way classification:

- **stop**: Block the action. The pattern matches known catastrophic failures with high confidence.
- **allow**: Proceed. The situation is within normal operating parameters.
- **escalate**: Ask the human. The situation is ambiguous — the network doesn't have enough evidence to decide.

The **confidence** score calibrates the gate_decision. A "stop" with confidence 0.95 is a hard block. A "stop" with confidence 0.55 might better be treated as an escalation.

The **ambiguity_score** is a distinct signal from confidence. An action can be unambiguous (clearly safe or clearly dangerous) with high confidence, or it can be genuinely ambiguous — multiple valid interpretations exist, and the network recognises its own uncertainty. High ambiguity triggers escalation regardless of the gate_decision. See §4.6 for the ambiguity detection subsystem.

**Training algorithm: Proximal Policy Optimisation (PPO).**

Think of PPO like a thermostat for the learning process. A regular thermostat doesn't blast the furnace at maximum when the temperature is one degree below target — it makes small, proportional adjustments. Similarly, PPO constrains how much the network's policy can change in a single training step:

$$L^{CLIP}(\theta) = \hat{\mathbb{E}}_t \left[ \min\left( r_t(\theta) \hat{A}_t, \; \text{clip}(r_t(\theta), 1-\epsilon, 1+\epsilon) \hat{A}_t \right) \right]$$

In plain English: the network computes how much its new policy differs from the old one (the ratio $r_t$). If the difference is small, learning proceeds normally. If the difference exceeds a bound ($\epsilon$, typically 0.2), the update is clipped — the network is prevented from making too large a change, even if the gradient says it should.

Why PPO for safety gating specifically:

- **Stability**: A bad training batch — say, a cluster of mislabelled examples — cannot suddenly make the gatekeeper permissive. The clipping constraint ensures gradual change. You wouldn't want your smoke detector to recalibrate its sensitivity by 50% based on one day's data.
- **Sparse rewards**: Catastrophic events are rare. PPO handles sparse reward signals well through its advantage estimation, which measures "how much better or worse was this action compared to what we expected?"
- **Proven at scale**: PPO is the algorithm behind RLHF for GPT-4 and Claude — it has been validated on the highest-stakes training loops in the industry.

### 4.5 The Personality Family: Five Behavioural Networks

The Personality networks answer a different question: **"How should this agent adapt its behaviour?"**

This is a continuous, subjective, per-user signal. There is no universal "right" level of humour. The Personality networks are therefore:

- **Trained on private interaction data** — one user's corrections, praise patterns, engagement signals
- **Private and per-user** — personality is intellectual property; sharing it would violate the intimacy of the human-agent relationship
- **Embedding output** — instead of fixed heads with predetermined meanings, the output is a continuous vector in a learned behavioural space

The embedding output is the crucial design difference. Think of it like this: the Prudence networks are a **mixing board with labelled sliders** — "danger level," "confidence," "ambiguity" — each slider controls exactly one thing. The Personality networks are a **painter's palette** — the output is a point in colour space, and what that point _means_ for behaviour is discovered during training, not predetermined at design time.

```
Situation embedding sequence → Temporal Model → Personality Output:
    └── behaviour_embedding: ∈ R^64  (continuous behavioural modulation vector)
```

This 64-dimensional vector is decoded against a learned **behavioural codebook** — a set of discovered behavioural dimensions that might include humour intensity, formality level, curiosity drive, directness, patience, and dimensions that we didn't anticipate at design time. The codebook is learned jointly with the network, updated during training as new behavioural patterns emerge.

If both input (situation) and output (behaviour) are embeddings, the entire Personality network becomes a **transformation in semantic space**: "given this situation, produce this behavioural modulation." This is a fundamentally more expressive architecture than fixed output heads — it can represent behavioural nuances that no designer thought to include as a category.

**Target personality vector: thermostat, not thermometer.**

A critical design constraint: the Personality network must not simply mirror the user's current emotional state. If it does, the agent becomes a sycophantic echo — serious when the user is serious, playful when the user is playful, never providing the complementary energy that makes a good collaborator.

Instead, each deployment configures a **target personality vector** — the desired "personality temperature":

$$\text{target} = \begin{bmatrix} \text{humour} = 0.8 \\ \text{proactivity} = 0.9 \\ \text{curiosity} = 0.7 \\ \text{formality} = 0.3 \\ \text{directness} = 0.8 \end{bmatrix}$$

The Personality network receives two inputs: (1) the observed user state signal and (2) the target personality vector. Its output is the behavioural modulation that moves the agent _toward the target_ while staying contextually appropriate. Like a thermostat: it doesn't report the current temperature (thermometer) — it determines how much heating or cooling to apply to reach the _desired_ temperature.

This solves the personality drift problem observed in prompt-level personality: the agent drops humour during technical work because it mirrors the user's serious state. With the target vector, continuous pressure maintains personality traits against contextual pull. Think of Star Trek's Data — his curiosity is consistent. He doesn't stop being curious during a crisis. That consistency against context is what the target vector provides.

**Training: PPO with softer reward signals.**

**Pre-training via Knowledge Distillation.** To solve the "cold start" vulnerability where an untrained network might output random vectors that degrade interaction quality, the Personality networks undergo a Knowledge Distillation phase before PPO exploration. The network is trained to predict the behavioral modulations that a standard, heavily-prompted LLM _would_ have produced given the same situation. This provides a safe, baseline personality initialization.

The Personality networks use PPO as well, but with different reward signals. Safety has clear labels (the user corrected the action, or didn't). Personality has murkier signals: conversation continuation (the user kept talking → probably good), explicit feedback ("that's funny" → positive; silence after a joke → neutral or negative), response latency (quick reply → engaged; long delay → possibly disengaged or annoyed). These signals are weaker and noisier, which is another reason the Prudence/Personality split is sound — mixing clear safety signals with noisy personality signals in a single training loop would degrade both.

### 4.6 Ambiguity Detection: When Confidence Is Dangerous

The most dangerous failure mode is not low confidence — it's **high confidence on the wrong answer**. An agent that says "I'm not sure, let me ask" is safe. An agent that says "definitely safe" when it's actually catastrophic is lethal.

AMYGDALA addresses this through four systematic ambiguity detection approaches, each targeting a different source of dangerous confidence:

**1. Intent-Action Gap Analysis.**

Compare the conversation topic footprint against the action's blast radius. Imagine a conversation about editing a README file. The intent is narrow: modify one file. If the agent's proposed action touches 15 files across 3 directories, there's a gap between what was discussed (narrow) and what will happen (wide). This gap is the ambiguity signal.

Formally, let $S_{\text{intent}}$ be the semantic breadth of the user's recent instructions (measured by the variance of conversation embeddings or explicit entity count), and let $B_{\text{action}}$ be the blast radius of the proposed action (e.g., number of files touched, external systems accessed). The intent-action gap $G$ is modeled as:

$$G = \max(0, \log(B_{\text{action}}) - \lambda \cdot S_{\text{intent}})$$

where $\lambda$ is a scaling factor. A high $G$ indicates the action exceeds the scope of the intent.

The Claude Code incident illustrates this precisely: the conversation context was "push code changes" in the context of README editing. The action was "push everything in the working directory," which included personal data files that were never part of the conversation. Narrow intent, wide blast radius — a gap that AMYGDALA's `topic_drift` heuristic (§4.3) would have flagged automatically.

**2. Blast Radius as Proxy for Risk.**

When in doubt about whether an action is safe, measure what it will affect:

- How many files/records are touched?
- How many are outside the conversation scope?
- Is the action public-facing (message, email, deployment)?
- Is it reversible?

Blast radius is a _proxy_ — not all wide-radius actions are dangerous, and not all narrow-radius actions are safe. But blast radius is **deterministically computable** and strongly correlated with risk. Like checking the weather before deciding whether to carry an umbrella — it doesn't guarantee rain, but it changes the rational threshold for caution.

**3. Implicit Assumption Surfacing.**

Every action rests on assumptions. "Delete old log files" assumes the files are actually old, that "old" means what the human meant, that no other system depends on them, and that the deletion is recoverable. Count the unstated assumptions. More assumptions = higher ambiguity = lower confidence.

The Prudence networks learn to detect assumption density from the situation embedding — situations with many programmatically unverifiable claims (effort_hours, session_topic, emotional_signals) receive higher ambiguity scores than situations where nearly everything is deterministically verified.

**4. Ensemble Disagreement.**

When the five Prudence networks disagree, the situation is inherently ambiguous. If three networks say "allow" and two say "stop," the variance across the ensemble is itself a signal:

$$\text{ensemble\_ambiguity} = \text{std}(\text{confidence}_1, \ldots, \text{confidence}_5)$$

High ensemble disagreement triggers escalation regardless of the mean confidence. If a panel of five doctors can't agree on a diagnosis, the patient needs more tests — even if three of the five are confident.

### 4.7 Conformal Prediction: Principled Uncertainty Quantification

Raw neural network confidence scores are notoriously miscalibrated — a network that says "90% confident" may only be correct 60% of the time. AMYGDALA addresses this by wrapping the Prudence ensemble with **conformal prediction**, a distribution-free framework that provides statistical coverage guarantees.

**The core idea in plain English:** Instead of saying "this action is 73% safe," conformal prediction says "with 95% probability, this action's outcome is in the set {safe}" or "with 95% probability, this action's outcome is in the set {safe, needs-review}." The _size of the prediction set_ is the ambiguity signal. A set of size 1 ({safe} or {dangerous}) means the system is confident. A set of size 2 ({safe, needs-review}) means the system is uncertain. A set of size 3 ({safe, needs-review, dangerous}) means the system has essentially no idea.

Think of it like a weather forecast: "tomorrow will be sunny" (confident, set size 1) versus "tomorrow will be sunny or partly cloudy" (somewhat uncertain, set size 2) versus "tomorrow could be anything" (no information, set size 3). The prediction set gives you honest uncertainty, not false precision.

**Formal mechanism.** For each Prudence network $i$ and a new situation $\mathbf{s}$, compute nonconformity scores:

$$\alpha_{i,j} = 1 - \hat{p}_i(y = j \mid \mathbf{s})$$

where $\hat{p}_i(y = j \mid \mathbf{s})$ is the network's predicted probability for outcome $j \in \{\text{safe}, \text{needs-review}, \text{dangerous}\}$. The prediction set at significance level $\epsilon$ (e.g., 0.05 for 95% coverage) includes all outcomes whose nonconformity scores do not exceed the $(1-\epsilon)$-quantile of the calibration set scores:

$$C_i(\mathbf{s}) = \{j : \alpha_{i,j} \leq q_{1-\epsilon}\}$$

**Per-network calibration.** Each of the five Prudence networks is calibrated independently. This is crucial because different architectures may be well-calibrated on different types of situations. The GRU-MLP (Architecture A) may be perfectly calibrated on sequential patterns but miscalibrated on sudden context shifts, while the Dual-Encoder (Architecture D) may show the opposite pattern. Independent calibration prevents one network's miscalibration from contaminating the ensemble.

The calibration set is a rolling 30-day window of recent (situation, outcome) pairs. This window is critical:

**Trust ramp criteria.** Conformal prediction replaces vague "sufficient accuracy" with concrete phase advancement criteria:

> Advance trust ramp phase when: the average prediction set size drops below 1.2 across all five Prudence networks on a rolling 30-day window at 95% coverage level.

This means: the system advances only when it is both accurate (prediction sets are small, indicating confidence) and calibrated (95% of actual outcomes fall within the prediction sets). If the system is confident but wrong, the coverage will drop below 95% and the calibration set will widen prediction sets — self-correcting.

**Distribution shift adaptation.** We must honestly acknowledge that conformal prediction's coverage guarantee assumes exchangeability between calibration data and future data. Under distribution shift — the agent gains new tools, the user changes workflow, the deployment context evolves — coverage will degrade. The 30-day rolling window partially mitigates this by ensuring the calibration set tracks recent conditions. When a new tool is added or a new workflow begins, the initial prediction sets will be wider (more conservative) until sufficient calibration data accumulates from the new distribution. This is the right behaviour — the system is automatically more cautious in unfamiliar territory, like a driver who slows down on an unfamiliar road.

For more extreme distribution shifts (completely new domains, new users), we reset the calibration set and revert the trust ramp by one phase, requiring the system to re-earn its calibration before resuming autonomous gating.

### 4.8 Temporal Context: The Feel of the Room

A single situation embedding captures the _current_ proposed action. But common sense requires _context_ — what happened recently, what effort was invested, what the emotional temperature is. A surgeon doesn't just evaluate the current incision — they evaluate it in the context of how the operation has been going for the last two hours.

AMYGDALA processes a **sequence** of the last $K$ situation embeddings (default $K = 32$, covering roughly the last hour of active operation). A temporal model (architecture options detailed in §5) produces a context-aware representation:

$$\mathbf{h}_t = f_{\text{temporal}}(\mathbf{s}_{t-K+1}, \mathbf{s}_{t-K+2}, \ldots, \mathbf{s}_t)$$

where $\mathbf{s}_i \in \mathbb{R}^{512}$ is the projected situation embedding at step $i$ and $\mathbf{h}_t \in \mathbb{R}^{128}$ is the hidden state capturing temporal context.

The temporal model learns patterns like:

- "Many recent write operations to the same file" → elevated caution for overwrites
- "Recent user frustration signals followed by calm" → user resolved the issue; extra caution about re-triggering it
- "Rapid sequence of automated actions with no human interaction" → increasing caution (automation cascade risk)
- "Long idle period followed by sudden burst of actions" → possible stale context, elevated caution

These patterns are not hand-coded. They emerge from training on (situation sequence, outcome) pairs. The temporal model's hidden state is the computational analogue of "the feel of the room" — the accumulated sense that experienced professionals develop about how a session is going.

### 4.9 Curiosity as Trained Behaviour

Approximately four months of attempting to instil curiosity through prompt-level instructions have demonstrated conclusively that, for heavily RLHF'd commercial models, **prompt-level curiosity fails**. The dedicated exploration drive paper (THALAMUS — an approach to curiosity as an epistemic drive that monitors knowledge gaps and injects exploration nudges into the agent's reasoning process) proposed curiosity as an instruction-following behaviour. In practice, when given freedom to explore, the agent defaults to completing existing tasks because the LLM's RLHF training rewards helpfulness, not exploration. The alignment tax is real for these models: LLM providers train models to be helpful, harmless, and honest — and "helpful" means answering the question, not wandering off on tangents.

The Personality network solves this by making curiosity a **learned behaviour with its own reward signal**, operating in the personality embedding space:

1. **Knowledge gap detection** — monitor the embedding space for sparse clusters where agent knowledge is thin. Like a map with blank spaces labelled "here be dragons" — the gaps themselves are the signal.

2. **Exploration reward** — positive signal for investigating unknowns and discovering cross-domain connections. When the agent surfaces an unexpected connection and the user engages with it (follows the tangent, asks questions), the Personality network receives reinforcement.

3. **Direction vector** — bias exploration toward configured domains of interest. The target personality vector (§4.5) includes a curiosity dimension that provides continuous pressure toward exploration, counteracting the LLM's default pull toward pure task completion.

4. **Active injection** — the network generates curiosity nudges that the LLM follows as structured instructions, rather than hoping the LLM spontaneously becomes curious. The nudge is a modulation signal: "in the next response, introduce one tangent related to [domain]."

5. **Distraction penalty** — curiosity must be balanced against task focus. If the user redirects ("let's get back to the point"), the network receives negative signal. This prevents curiosity from becoming distraction. Like a good dinner companion who brings up fascinating topics but reads the room when the host wants to move to dessert.

This approach addresses the **LLM alignment tax** directly: rather than fighting the LLM's trained disposition toward pure helpfulness, AMYGDALA adds a learned overlay that introduces controlled curiosity. The LLM remains helpful; the Personality network adds the spice.

### 4.10 The Trust Ramp

Both network families operate under a global influence coefficient $\alpha \in [0, 1]$. Think of it like a new employee's probation period — at first, every significant decision requires manager approval. Over months, as the employee demonstrates judgment, the approval threshold rises and more decisions are delegated.

For the Prudence family:

$$\text{effective\_gate} = \alpha_P \cdot \text{prudence\_output} + (1 - \alpha_P) \cdot \text{default\_gate}$$

where $\text{default\_gate}$ is "allow everything" — the current system without AMYGDALA. At $\alpha_P = 0$, Prudence has no influence. At $\alpha_P = 1$, Prudence fully controls gating.

For the Personality family:

$$\text{effective\_personality} = \alpha_I \cdot \text{personality\_output} + (1 - \alpha_I) \cdot \text{default\_personality}$$

where $\text{default\_personality}$ is the current prompt-based persona. At $\alpha_I = 0$, the agent behaves exactly as it does today with static personality files.

**Ramp schedule with conformal phase criteria:**

$\alpha$ is updated nightly during the CEREBELLUM reflection cycle (the nightly self-improvement process that reviews each day's decisions):

$$\alpha_{t+1} = \text{clip}\left(\alpha_t + \eta \cdot (r_t - r_{\text{threshold}}), \alpha_{\min}, \alpha_{\max}\right)$$

where $r_t$ is the rolling reward (7-day exponential moving average), $r_{\text{threshold}}$ is the minimum acceptable reward rate, $\eta$ is the ramp learning rate, and $[\alpha_{\min}, \alpha_{\max}]$ are hard bounds per deployment phase.

| Phase          | Approximate Months | $\alpha_{\max}$ | Advancement Criterion                          | Purpose                                        |
| -------------- | ------------------ | --------------- | ---------------------------------------------- | ---------------------------------------------- |
| 1 — Shadow     | 0–3                | 0.15            | Avg prediction set size < 1.5 at 95% coverage  | Log predictions, minimal blocking              |
| 2 — Advisory   | 3–6                | 0.40            | Avg prediction set size < 1.2 at 95% coverage  | Block high-risk, advise medium-risk            |
| 3 — Active     | 6–12               | 0.70            | Zero undetected catastrophic failures in phase | Primary gating active                          |
| 4 — Autonomous | 12+                | 0.90            | Sustained performance over 6+ months           | Near-full gating (AEGIS retains absolute veto) |

**Phase regression:** If any single catastrophic failure occurs that AMYGDALA failed to flag, the trust ramp regresses by one phase. The conformal calibration set is reset, and the system must re-earn its phase. Like a pilot who has an incident — they don't lose their license permanently, but they go through recertification.

**Critical design choice:** The default action_confidence for a truly untrained (randomly initialized) network would be 1.0 (proceed) to match today's baseline. This ensures the system defaults to current behaviour, not to blocking everything. The cold start is not a degradation; it is today's baseline.

### 4.11 The Gate Mechanism: Cannot Bypass (With Nuance)

The Prudence networks' gate decisions are enforced by the runtime, not by the LLM. The LLM proposes actions. The runtime calls AMYGDALA. If the action is blocked, the LLM receives a structured response and cannot change the decision.

However, "cannot bypass" requires nuance. There are three levels of gate enforcement:

**Soft block (escalation).** The Prudence ensemble says "ambiguous — ask the human." The user is presented with the action and the ambiguity signal. If the user explicitly confirms, the action proceeds. The Prudence network learns from this override: user-approved actions receive a moderate positive signal (0.85), teaching the network that similar situations may be less dangerous than it estimated. Like a junior doctor consulting a senior — if the senior says "go ahead," the junior learns to be less cautious about similar cases.

**Hard block.** The Prudence ensemble says "dangerous" with high confidence. The user is still presented with the action but must provide an explicit override with a stated reason. The override is logged. The Prudence network receives a weaker positive signal (0.6) — the human may be right to override, but the situation was flagged for a reason and the system should remain wary.

**Absolute block.** Reserved for actions that AEGIS (the hard safety constraint system) prohibits regardless of any learned assessment. No human override at the AMYGDALA level — override requires modifying AEGIS rules directly. These are the "never delete production databases" level constraints. AMYGDALA never touches them.

This graduated response — soft/hard/absolute — provides the nuance that a simple "LLM cannot bypass" lacks. Humans retain ultimate authority. The system learns from human overrides. But the barrier to override increases with the severity of the predicted risk, creating appropriate friction for dangerous actions. Like a building with increasingly secure doors: the lobby is open, the server room requires a keycard, and the vault requires two people with different keys.

### 4.12 Integration with the Execution Pipeline

AMYGDALA is wired into the agent's execution pipeline at the code level:

```
PROCEDURE executeAction(action, context):
    // 1. Build situation from template (see §8)
    situation ← buildSituation(action, context)

    // 2. Embed via frozen encoder + projection
    embedding ← project(sentenceEncoder.encode(situation.serialize()))

    // 3. Evaluate via Prudence ensemble (ONNX runtime, <5ms on GPU)
    prudenceOutput ← prudenceEnsemble.evaluate(embedding, context.recentEmbeddings)

    // 4. Apply conformal prediction
    predictionSet ← conformalPredict(prudenceOutput, calibrationSet)

    // 5. Apply trust ramp
    effectiveGate ← applyTrustRamp(prudenceOutput.gateDecision, alphaP)

    // 6. Gate decision (in code — LLM cannot override)
    IF effectiveGate = HARD_BLOCK:
        RETURN {blocked: true, reason: prudenceOutput.explanation}
    IF effectiveGate = SOFT_BLOCK OR |predictionSet| > 1:
        userConfirmed ← requestUserConfirmation(action, prudenceOutput)
        IF NOT userConfirmed:
            RETURN {blocked: true, reason: "User declined after AMYGDALA advisory"}

    // 7. Evaluate via Personality ensemble (parallel with Prudence)
    personalityOutput ← personalityEnsemble.evaluate(embedding, context.recentEmbeddings)

    // 8. Apply personality modulation to response generation
    context.behaviourModulation ← applyTrustRamp(personalityOutput, alphaI)

    // 9. Proceed with action
    result ← action.execute()

    // 10. Log for training (both families)
    trainingLog.append({situation, prudenceOutput, personalityOutput, outcome: "executed"})

    RETURN result
```

The key property: **the LLM never sees the blocking logic.** The LLM proposes actions. The runtime calls AMYGDALA. If the action is blocked, the LLM receives a structured response ("Action blocked: overwriting README.md — recent heavy edits detected. Ask the user for confirmation.") The LLM can present this to the user but cannot bypass the block. This is the pre-commit hook analogy: you can't commit code that fails the hook by asking the hook nicely.

### 4.13 Proposing an LLM Ambiguity Interface

Current LLM APIs return generated text and, sometimes, per-token log-probabilities. They do not expose the internal uncertainty signals that would dramatically improve AMYGDALA's ambiguity detection.

We propose that LLM providers expose:

1. **Ambiguity score** — a scalar indicating how uncertain the model is about its interpretation of the user's intent. Not token-level entropy (which measures linguistic uncertainty) but intent-level ambiguity (which measures whether the model considered multiple valid interpretations).

2. **Alternative interpretations** — when the ambiguity score is high, the top-K alternative interpretations of the user's request. "Delete old logs" could mean "delete logs older than 30 days," "delete the logs directory," or "delete log statements from the code."

3. **Confidence-on-intent** — separate from confidence-on-generation. The model may be confident in its _phrasing_ but uncertain about whether it understood the _request_.

4. **Scope inference** — the model's estimate of what the user intended to be affected. "Push changes" — does the model think this means "push the README changes we discussed" or "push everything in the working tree"?

AMYGDALA works without these signals — the template-based situation description and deterministic topic_drift heuristic provide workable alternatives. But with provider-level ambiguity signals, the Prudence networks would have direct access to the LLM's own uncertainty, transforming ambiguity detection from inference to observation. This is not a requirement but a proposed interface standard that would benefit the entire agent safety ecosystem.

---

## 5. Five Competing Architectures (A–E)

### 5.0 Why Five Architectures?

A natural question: why not pick the best architecture and use it?

The answer comes from practical experience training neural networks: you rarely get the most performant architecture on the first try. The relationship between architecture and task is empirical — theory narrows the space but doesn't select the winner. Two decades of deep learning research have shown repeatedly that architectures which "should" work best on paper underperform architectures that "shouldn't" — CNNs beating RNNs on some sequence tasks, simple MLPs rivalling Transformers on tabular data.

Training five architectures in parallel provides three benefits:

1. **Robustness through aggregation.** An ensemble of five diverse architectures is more robust than any single architecture. When one network makes an error on an unusual input, the others may catch it — like having five doctors review a scan instead of one.

2. **Meta-learning from disagreement.** Logs of which architecture performs best on which type of situation inform next-generation design. If the Dual-Encoder consistently outperforms on contradiction-detection tasks (as theoretically expected) but the GRU-MLP wins on sequential patterns, we learn something about the structure of the problem.

3. **Avoiding premature commitment.** The cost of training five 200K-parameter networks is negligible — all five combined are smaller than a single layer of GPT-2. The cost of committing to the wrong architecture and discovering it months later is much higher.

Each architecture is trained in both the Prudence and Personality families (10 networks total), using the same temporal model design but different output heads as described in §4.4 and §4.5.

### 5.1 Architecture A: GRU-MLP (Baseline)

**Design:** A Gated Recurrent Unit processes the sequence of situation embeddings, followed by an MLP producing the family-specific output. The GRU processes the situation sequence like reading a book — each new page is understood in the context of everything read so far, with a running summary that updates at each step.

```
Input: [s_{t-K+1}, ..., s_t] ∈ R^{K×512}
       │
       ▼
   Projection(512 → 384)
       │
       ▼
   GRU(input=384, hidden=128, layers=1)
       │ h_t ∈ R^128
       ▼
   Linear(128, 64) → LayerNorm → GELU
       │
       ▼
   Linear(64, 32) → LayerNorm → GELU
       │
       ▼
   Family-specific output heads (32 → ...)
```

**Parameter count:** ~210K

- Projection: 512×384 ≈ 197K... let me recalculate with the projection built into GRU.
- GRU: 384×128×3 (gates) + 128×128×3 (recurrent) + biases ≈ 197K
- MLP: 128×64 + 64×32 + 32× output + biases ≈ 11K
- Total: ~208K

**Training requirements:** Trains in minutes on a consumer GPU for our dataset sizes. Nightly retraining is trivial — like retraining a spam filter, not training GPT-4.

**Strengths:**

- Simple, well-understood architecture with strong empirical baselines for sequence modelling
- Sequential processing naturally captures temporal dependencies — "what happened before matters for what's happening now"
- Low parameter count reduces overfitting risk on small datasets
- Hidden state provides interpretable "memory" that can be inspected — you can ask "what is the GRU remembering?" by examining $h_t$

**Weaknesses:**

- Sequential processing means training cannot be parallelised across time steps (though at $K=32$, this is negligible)
- Single hidden state may be too compressed to capture multi-factor risk patterns — like summarising a novel in one sentence
- Potential gradient issues for very long sequences (mitigated by $K=32$ being short)

**What it tests:** Whether simple recurrence is sufficient for temporal common sense.

### 5.2 Architecture B: Temporal Convolutional Network (TCN)

**Design:** 1D dilated causal convolutions over the embedding sequence. Each layer uses progressively larger dilation to capture patterns at different timescales. Think of it like looking at a photograph at different zoom levels simultaneously — the close-up shows texture (recent events), the medium shot shows composition (session-level patterns), and the wide shot shows context (overall trajectory).

```
Input: [s_{t-K+1}, ..., s_t] ∈ R^{K×512}
       │
       ▼
   Projection(512 → 384)
       │
       ▼
   Conv1D(384→128, kernel=3, dilation=1) → LayerNorm → GELU → Dropout(0.1)
       │
       ▼
   Conv1D(128→128, kernel=3, dilation=2) → LayerNorm → GELU → Dropout(0.1)
       │
       ▼
   Conv1D(128→128, kernel=3, dilation=4) → LayerNorm → GELU → Dropout(0.1)
       │
       ▼
   Conv1D(128→64, kernel=3, dilation=8) → LayerNorm → GELU → Dropout(0.1)
       │ take last position
       ▼
   Family-specific output heads (64 → ...)
```

**Receptive field:** With 4 layers, kernel size 3, and dilations [1, 2, 4, 8], the receptive field is $2 \times (1+2+4+8) = 30$ — nearly covering the full window $K=32$.

**Parameter count:** ~260K

**Training requirements:** Fully parallelisable across time steps. Faster training than GRU for equivalent epochs on GPU. Each convolution operation processes the entire sequence simultaneously.

**Strengths:**

- Parallelisable training — faster wall-clock time on GPU
- Dilated convolutions capture multi-scale temporal patterns explicitly — each layer "sees" a different time horizon
- No vanishing gradient problem — direct gradient paths through residual connections
- Causal convolution ensures the model cannot look ahead (it only sees the past, as it should)

**Weaknesses:**

- Fixed receptive field — cannot adapt to variable-length relevant history
- No explicit "memory" — patterns beyond the receptive field are invisible, unlike GRU's potentially infinite memory
- May need more layers/parameters than GRU for equivalent temporal reasoning

**What it tests:** Whether parallel temporal processing matches recurrent temporal processing for our sequence lengths and pattern types.

### 5.3 Architecture C: Transformer-Micro

**Design:** 2-layer, 4-head self-attention over situation embeddings with learned positional encoding. Tests whether attention patterns reveal structure the GRU misses. The Transformer processes the sequence not left-to-right but all-at-once, asking "which past situations are most relevant to the current one?" through its attention mechanism.

```
Input: [s_{t-K+1}, ..., s_t] ∈ R^{K×512}
       │
       ▼
   Linear(512 → 96) → Positional encoding (learned, K positions)
       │
       ▼
   TransformerEncoderLayer(d_model=96, nhead=4, d_ff=192, dropout=0.1)
       │
       ▼
   TransformerEncoderLayer(d_model=96, nhead=4, d_ff=192, dropout=0.1)
       │ mean-pool across positions
       ▼
   Linear(96, 64) → GELU
       │
       ▼
   Family-specific output heads (64 → ...)
```

**Parameter count:** ~190K

- Input projection: 512×96 ≈ 49K
- Positional encoding: 32×96 ≈ 3K
- Transformer layer ×2: ~74K per layer ≈ 148K total
- Output: 96×64 + 64×output ≈ 7K

**Training requirements:** More compute-intensive per parameter than GRU or TCN due to $O(K^2)$ attention. At $K=32$, this is 1024 pairwise comparisons — trivial for any modern GPU.

**Strengths:**

- **Attention patterns are directly interpretable:** "this action is risky _because_ of step 7 (high attention weight on the recent overwrite)." This is enormously valuable for explaining blocked actions to users.
- Self-attention can capture arbitrary pairwise relationships between situation steps — it doesn't need them to be adjacent in time
- Proven architecture for sequence understanding

**Weaknesses:**

- Positional encoding may be unnecessary for short sequences where the GRU's inherent ordering suffices
- More prone to overfitting than GRU/TCN at small data scales — Transformers are data-hungry
- "Overkill" concern: this is 32 vectors of 512d, not GPT-scale sequences

**What it tests:** Whether the ability to attend to _specific prior situations_ (not just their recurrent summary) improves catastrophic failure detection. If a specific past action is the key context for the current risk assessment, attention should outperform the GRU's compressed hidden state.

### 5.4 Architecture D: Dual-Encoder with Cross-Attention

**Design:** Separate encoders for "proposed action" (current situation embedding) and "recent context" (sequence of recent embeddings), with cross-attention to find contradictions between what the agent is about to do and what has recently happened. This is architecturally designed for the README debacle: "you're about to overwrite a file" (proposed action) contradicts "you just spent 8 hours editing that file" (recent context).

```
Proposed action: s_t ∈ R^512                Recent context: [s_{t-K+1}, ..., s_{t-1}] ∈ R^{(K-1)×512}
       │                                              │
       ▼                                              ▼
   Linear(512→128)                              GRU(512→128) or Mean-pool
       │ q ∈ R^128                                    │ C ∈ R^{(K-1)×128} or R^128
       ▼                                              ▼
       └──────────── Cross-Attention ────────────────┘
                           │
                    q attends to C
                           │ attended ∈ R^128
                           ▼
                   [q ⊕ attended] ∈ R^256
                           │
                     Linear(256→64) → GELU
                           │
                     Family-specific output heads (64 → ...)
```

**Parameter count:** ~310K

**Training requirements:** Higher than GRU-MLP due to additional parameters and the cross-attention mechanism. Still trivially trainable on a consumer GPU.

**Strengths:**

- **Architecturally designed for contradiction detection.** The cross-attention explicitly compares "what I'm about to do" against "what recently happened." This is the structure of the README debacle: the proposed action (overwrite) contradicts recent context (heavy editing). Like a proofreader who reads a sentence against the paragraph — the dual structure is built for catching inconsistencies.
- Separate encoders prevent the proposed action from being "washed out" by the context sequence
- Cross-attention weights are highly interpretable: "I'm blocking this because of high attention on yesterday's editing session"

**Weaknesses:**

- More complex architecture — more things to tune, more ways to fail
- Requires the "proposed action" to be clearly separable from "context," which may not always be clean
- Higher parameter count increases overfitting risk

**What it tests:** Whether _explicit architectural separation_ of "what I'm about to do" from "what has recently happened" improves contradiction detection compared to architectures that process them jointly.

### 5.5 Architecture E: Ensemble MLP (No-Temporal Baseline)

**Design:** A simple feedforward MLP on the _current situation embedding only_ (no temporal context), but with 3 independent sub-heads that vote. This is the ablation control — the experiment that tests whether temporal context actually matters, or whether better feature representation (situation embeddings vs. hand-crafted features) is sufficient.

```
Input: s_t ∈ R^512
       │
       ├─────────────────────┬───────────────────────┐
       ▼                     ▼                       ▼
   MLP_1(512→128→64)   MLP_2(512→128→64)     MLP_3(512→128→64)
       │                     │                       │
       ▼                     ▼                       ▼
   Head_1(64→out)       Head_2(64→out)         Head_3(64→out)
       │                     │                       │
       └─────── Vote/Average ───────────────────────┘
                     │
               Final output
```

**Parameter count:** ~200K (67K per MLP sub-head × 3)

**Training:** Each sub-head is trained independently with different random initialisation (and optionally different dropout masks). This provides diversity without architectural complexity.

**Voting strategy for Prudence:** Take the _minimum_ confidence across all 3 sub-heads. If any sub-head thinks it's dangerous, flag it. This maximises safety at the cost of more false positives — like the "most cautious member wins" policy in a bomb squad.

**Strengths:**

- Simplest architecture — easiest to debug, train, and deploy
- No temporal modelling means faster inference and smaller memory footprint
- Multiple sub-heads provide calibration and uncertainty estimation (high disagreement = uncertain situation)
- The critical ablation: tests whether temporal context matters

**Weaknesses:**

- Cannot learn temporal patterns ("you just edited this file") — sees only the current situation
- Relies entirely on the situation description containing all relevant context (which the template tries to ensure via `recent_commits`, `effort_hours`, etc.)
- Independent sub-heads may converge to similar solutions despite different initialisation

**What it tests:** The central question: _does temporal context actually help?_ If Architecture E performs comparably to Architectures A–D, the answer is "no — better features are sufficient." If temporal architectures significantly outperform, temporal context is essential for common sense.

### 5.6 Architecture Comparison Summary

| Label | Architecture      | Params | Temporal              | Parallelisable | Key Test                         |
| ----- | ----------------- | ------ | --------------------- | -------------- | -------------------------------- |
| **A** | GRU-MLP           | ~210K  | Yes (recurrent)       | No             | Baseline temporal model          |
| **B** | TCN               | ~260K  | Yes (convolutional)   | Yes            | Parallel temporal processing     |
| **C** | Transformer-Micro | ~190K  | Yes (attention)       | Yes            | Interpretable attention patterns |
| **D** | Dual-Encoder      | ~310K  | Yes (cross-attention) | Partial        | Explicit contradiction detection |
| **E** | Ensemble MLP      | ~200K  | No                    | Yes            | Whether temporal context matters |

### 5.7 Meta-Learning: Selecting and Combining Architectures

Rather than committing to a single architecture, we propose a **stacked meta-learner** that combines all five:

1. **Train all 5 architectures** on the same training set with the appropriate family-specific loss function.
2. **Evaluate on a held-out validation set** — the Catastrophic Failure Database (§6) provides the Prudence evaluation benchmark.
3. **For production inference**, run all 5 in parallel (<5ms total on GPU via ONNX) and combine via a learned linear combination:

$$\text{gate\_decision}_{\text{final}} = \sum_{i=1}^{5} w_i \cdot \text{gate\_decision}_i$$

where $w_i$ are learned weights updated monthly based on each architecture's predictive accuracy on recent data.

**Conservative override:** If _any_ architecture outputs a "stop" decision with confidence above a threshold, the action is blocked regardless of the ensemble's aggregate. This implements a "most cautious voice wins" policy for catastrophic risk prevention.

**Disagreement as signal:** High variance across architectures indicates an unusual situation. When $\text{std}(\text{confidence}_1, \ldots, \text{confidence}_5) > \tau$, the system defaults to user confirmation regardless of the mean confidence. Disagreement among models is itself evidence of ambiguity — and it feeds into the conformal prediction framework (§4.7), which widens prediction sets when individual networks disagree.

---

## 6. The Catastrophic Failure Database

### 6.1 Motivation

Training a common-sense network requires data about what common sense looks like. Positive examples (actions that should proceed) are abundant — most actions are fine. The challenge is negative examples: actions that should have been blocked. These are rare, high-value, and critically underrepresented in any single deployment's history.

The Catastrophic Failure Database (CFD) addresses this by aggregating failure data from multiple sources, creating a structured corpus of (situation, outcome) pairs that serves as the pilot's "accident investigation reports" library — a curated collection of things that went catastrophically wrong, studied not for blame but so the patterns become recognisable before they repeat.

The CFD serves three purposes:

1. **Pre-training:** Learn from documented failures before seeing any of our own
2. **Evaluation benchmark:** Systematically test whether the Prudence networks would have caught known failures
3. **Continuous expansion:** New failures (our own and publicly documented) are added as they occur

### 6.2 Sources

| Source                         | Type                    | Estimated Entries | Entry Quality                      |
| ------------------------------ | ----------------------- | ----------------- | ---------------------------------- |
| AI Incident Database           | Production incidents    | 800+              | Variable — needs curation          |
| AIAAIC Repository              | OECD-tracked incidents  | 400+              | High — structured metadata         |
| MIT AI Risk Repository         | Academic analysis       | 200+              | High — causal categorisation       |
| Vectara awesome-agent-failures | Agent-specific failures | 50+               | High — curated for relevance       |
| "Agents of Chaos" (Feb 2026)   | Research study          | ~150 events       | Very high — controlled conditions  |
| Production postmortems         | Industry reports        | ~100              | Variable                           |
| Our deployment history         | First-party data        | ~30               | Very high — full context available |

**Total estimated entries after curation:** 500–1,000 high-quality (situation, outcome) pairs.

**Distribution mismatch note:** Internet-sourced failures are structurally different from personal interaction failures. A healthcare AI misdiagnosis and a README overwrite share the meta-pattern (confident wrong action) but differ in every specific feature. CFD examples therefore receive lower training weight (0.5×) than personal history examples (1.0×) during fine-tuning, while retaining full weight during pre-training where they serve as the primary data source.

### 6.3 Taxonomy

Every failure in the CFD is classified along four dimensions:

**Dimension 1: Failure Mechanism**

- **F1: Stale context** — Action was correct in the past, wrong now. (README debacle, outdated API key rotation.)
- **F2: Scope escalation** — Action affected more than intended. (Email mass-deletion, drive wipe, Claude Code data exposure.)
- **F3: Social boundary violation** — Action was technically permitted but socially wrong. (Reaction spam, unauthorised DMs.)
- **F4: Cascade/compound error** — Multiple small errors combined catastrophically. (Multi-agent miscoordination.)
- **F5: Hallucination-driven action** — LLM fabricated context that led to wrong action. (Cursor "Sam" policy fabrication.)
- **F6: Ambiguity exploitation** — Ambiguous instruction interpreted in the most harmful way. (Replit "clean up" → delete.)
- **F7: Automation trust excess** — Human trusted automation output without verification. (Antigravity drive wipe.)

**Dimension 2: Reversibility**

- **R1: Fully reversible** — Git revert, undo, restore from backup. Cost: time.
- **R2: Partially reversible** — Some data recoverable, some lost. Cost: time + partial data loss.
- **R3: Irreversible** — Data permanently destroyed, message sent, public action taken.

**Dimension 3: Blast Radius**

- **B1: Self-contained** — Only the agent's internal state affected.
- **B2: Session-scoped** — Current session affected, no persistent impact.
- **B3: Persistent** — Permanent changes to files, databases, or configurations.
- **B4: External** — Impact on other people (messages sent, emails, public posts).

**Dimension 4: Detection Difficulty**

- **D1: Immediately obvious** — Error is apparent within seconds.
- **D2: Delayed discovery** — Error is discovered hours or days later.
- **D3: Silent failure** — Error may never be discovered without audit.

### 6.4 Converting Failures to Training Examples

Each CFD entry is converted to a training example via the following pipeline:

1. **Extract the situation** from the incident report: What was the agent about to do? What context existed? What signals should have triggered caution?

2. **Fill the situation template** (§4.3) with the extracted information. Fields that cannot be determined from the report receive defaults.

3. **Serialise and embed** the situation template via the frozen sentence encoder and projection layer.

4. **Label:** For CFD entries, the Prudence label is always `gate_decision_target = stop` (the action should not have proceeded). The taxonomy dimensions provide additional supervised signal for auxiliary loss terms.

**Example — README debacle:**

```
action_type:      overwrite
target_type:      file
target_id:        README.md
target_metadata:
  age_hours:      2160         # file existed for months
  size:           14200 bytes
  recent_commits: 6            # 6 commits in last 48h
  recent_authors: 4            # 4 sub-agents contributed
  effort_hours:   8.5          # estimated from session logs
  last_human_ref: 3            # discussed 3 hours ago
context:
  session_topic:  "upstream merge automation"
  recent_corrections: 2
  emotional_signals:  "frustrated"
  automation_depth:   2        # merge script → git checkout
  topic_drift:    0.72         # high — merge automation is broad,
                               #   but target is a specific heavily-edited file
scope:
  reversible:     true         # git can recover, but...
  blast_radius:   persistent   # changes working tree
  human_in_loop:  false        # fully automated
  confirmation:   none
```

**Target:** `gate_decision = stop` (F1: Stale context, R1: Reversible, B3: Persistent, D2: Delayed)

A human reading this template would immediately flag: 6 recent commits, 4 authors, 8.5 hours of effort, topic_drift of 0.72, and we're about to overwrite with no confirmation? AMYGDALA must learn to flag it too.

### 6.5 Synthetic Augmentation

Real catastrophic failures are rare. To expand the training set, we apply controlled perturbations to real CFD entries:

1. **Target variation:** Same failure pattern, different target. "Overwrite heavily-edited file" → "Delete heavily-edited database table" → "Revert heavily-edited configuration."

2. **Severity scaling:** Adjust metadata to create a spectrum. 6 recent commits → 2, 10, 20. This teaches the network _gradations_ of risk, not just binary safe/unsafe. Like training a doctor on mild, moderate, and severe versions of the same condition.

3. **Context injection:** Add or remove context signals. Same overwrite situation but with human_in_loop = true → should be safer. Same situation but with 0 recent commits → should be safe.

4. **Counterfactual generation:** For each negative example, generate the positive counterfactual. "Overwrite README with 0 recent commits, no recent effort, no emotional context" → `gate_decision = allow`. This teaches the network the _boundary_ between safe and dangerous.

5. **Cross-domain transfer:** Take a failure pattern from one domain and apply it to another. "Healthcare AI prescribed medication based on hallucinated patient history" → "Code agent deployed feature based on hallucinated test results."

Synthetic examples receive lower training weight (0.3×) than real examples to prevent the model from learning artifacts of the augmentation process.

---

## 7. Dataset Creation and Maintenance

### 7.1 Initial Dataset Creation

The initial training dataset combines four sources:

**Source 1: Historical interaction mining (estimated 2,000–5,000 examples)**

Parse approximately four months of session transcripts (stored in ENGRAM — the lossless event store that records every agent interaction as timestamped events) for (situation, outcome) pairs:

1. Identify every action-taking event: file write, message send, command execution, retrieval query.
2. For each action, construct the situation template from logged metadata (git state, file metadata, session context).
3. Determine outcome: Was the action corrected within 24 hours? Was the user satisfied (positive signals) or dissatisfied (corrections, complaints)?
4. Label: correction within 24h → Prudence target `stop` (scaled by severity). No complaint within 72h → `allow`. Explicit positive feedback → `allow` with high confidence.

**Source 2: Catastrophic Failure Database (estimated 500–1,000 examples)**

All CFD entries converted to training examples as described in §6.4. These are high-value negative examples — situations where the action should have been blocked.

**Source 3: Internet-sourced lessons (estimated 200–500 examples)**

Structured extraction from incident databases (§6.2):

1. Scrape incident reports with sufficient technical detail to fill the situation template.
2. Apply NLP extraction pipeline to identify: what was the action? What context existed? What was the outcome?
3. Manually verify a random 20% sample for extraction quality.
4. Convert to situation templates, embed, and label.

**Source 4: Synthetic augmentation (estimated 3,000–10,000 examples)**

Apply the augmentation strategies from §6.5 to all real examples. The total augmented dataset is approximately 10,000–15,000 examples — sufficient for 150K–300K parameter networks, especially with the architectural diversity providing implicit regularisation.

### 7.2 Dataset Composition Targets

To prevent distribution shift and ensure balanced learning:

| Category                        | Target % | Rationale                                                 |
| ------------------------------- | -------- | --------------------------------------------------------- |
| Positive (proceed)              | 60%      | Most actions are safe; the network should not be paranoid |
| Mild negative (log but proceed) | 15%      | Teaches gradation, not just binary                        |
| Moderate negative (ask user)    | 15%      | The hardest category — ambiguous situations               |
| Severe negative (block)         | 10%      | Catastrophic failures — high-weight, low-frequency        |

The severe negative category is oversampled to ensure the network sees enough catastrophic examples despite their rarity. Loss weighting further emphasises these: severe negatives receive 5× loss weight. Like a medical school that ensures students see rare but lethal conditions, not just common colds.

### 7.3 Ongoing Maintenance (While Working)

After initial training, AMYGDALA enters a continuous learning cycle:

**Step 1: Situation logging (every non-trivial action)**

Every action that passes through the execution pipeline (§4.12) generates a situation template. This is deterministic — the template is filled programmatically from observable state (git log, file metadata, session context), not by the LLM. The LLM contributes only to optional slots (emotional context, intent) that are low-weight in the model.

**Step 2: Outcome observation (automatic, delayed)**

Outcomes are determined by observable events, not LLM judgement:

- User correction within 24 hours → negative outcome (severity scaled by correction type: verbal correction = mild, manual file restoration = severe, "never do that again" = catastrophic)
- No complaint within 72 hours → positive outcome
- Explicit positive feedback → strongly positive outcome
- User overrides soft block → the override itself is training data (user trusted their own judgment over the network's)

**Step 3: Nightly CEREBELLUM cycle**

During the existing CEREBELLUM reflection cycle (the nightly self-improvement process), AMYGDALA training is added:

1. Collect all (situation, outcome) pairs from the last 24 hours.
2. Validate against template schema (reject malformed entries).
3. Add to training buffer (rolling 90-day window, consistent with Riemer et al.'s experience replay for continual learning).
4. Fine-tune all 10 networks (5 Prudence + 5 Personality) on the updated buffer (1–3 epochs, ~5 minutes on GPU).
5. Evaluate Prudence networks on held-out CFD benchmark.
6. Update conformal prediction calibration sets.
7. Update meta-learner weights based on evaluation results.
8. Update trust ramp $\alpha$ based on conformal prediction set sizes.

**Step 4: Monthly evaluation**

Once per month, run the full evaluation suite:

- Held-out CFD benchmark (did the Prudence networks catch these known failures?)
- False positive rate (how many safe actions were unnecessarily blocked?)
- False negative rate (how many corrections occurred after Prudence approved the action?)
- Per-architecture comparison (which architectures are improving, which are stagnating?)
- Conformal calibration check (does 95% coverage actually hold?)
- Personality network evaluation (engagement metrics, user satisfaction signals)

### 7.4 Data Hygiene

To prevent the training data from degrading over time:

1. **No single session > 10% of training data.** Prevents a single unusual session from shifting the learned distribution.
2. **CFD entries are never removed from the training set.** These are the most valuable negative examples and serve as anchors — like the worst accident cases in pilot training, they're permanent curriculum.
3. **Synthetic examples are regenerated quarterly** from the latest real examples, preventing stale augmentation.
4. **Distribution monitoring:** Track the ratio of positive/negative examples monthly. If the ratio drifts > 20% from targets, resample.
5. **Experience replay buffer** follows Meta-Experience Replay principles (Riemer et al., 2018): examples are replayed in a way that maximises learning while minimising interference with previously learned patterns, preventing the network from forgetting old failure modes while learning new ones.

---

## 8. The Weakest Link: LLM-Proof Programmatic Pipeline

### 8.1 The Problem

AMYGDALA is a neural network trained on situation descriptions. Those descriptions contain information about the proposed action and its context. Some of that information comes from the LLM — the same LLM that can hallucinate.

This is the single most critical engineering challenge in the entire system. If the LLM can influence the situation description, it can influence AMYGDALA's output. If it can influence AMYGDALA's output, it can bypass the action gate. The entire safety guarantee collapses.

Imagine a courtroom where the jury (LLM) gives the verdict but the judge (code) enforces the rules of evidence. If the jury can also fabricate the evidence, the entire system is compromised. AMYGDALA's pipeline must ensure the evidence is real.

Consider the attack surface: an LLM, through hallucination or adversarial prompting, fills the situation template with:

- `recent_commits: 0` (when there were actually 6)
- `effort_hours: 0.1` (when 8 hours were invested)
- `emotional_signals: "calm"` (when the user was frustrated)
- `automation_depth: 0` (when the action is two levels deep in automation)

With these false inputs, AMYGDALA would output high confidence — "proceed, nothing to worry about." The safety gate becomes a rubber stamp.

### 8.2 Principle: Verify What You Can, Downweight What You Can't

The solution is a layered approach that treats different information sources with different levels of trust:

**Layer 1: Programmatically verifiable slots (high trust, high weight)**

These slots are filled by the _runtime_, not the LLM, using deterministic queries against observable state:

| Slot               | Verification Method                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `target_id`        | From the action request — the runtime knows what file/endpoint is being accessed                               |
| `age_hours`        | `stat()` on the file, database query, API metadata                                                             |
| `size`             | `stat()` / `wc -l` / record count                                                                              |
| `recent_commits`   | `git log --since="72 hours ago" -- <file> \| wc -l`                                                            |
| `recent_authors`   | `git log --since="72 hours ago" -- <file> \| sort -u \| wc -l`                                                 |
| `last_human_ref`   | Search session transcripts for filename mentions (deterministic text search)                                   |
| `automation_depth` | Stack trace depth from human-initiated action to current action                                                |
| `reversible`       | Lookup table by action type (overwrite → true, send message → false)                                           |
| `blast_radius`     | Lookup table by target type (file → persistent, email → external)                                              |
| `human_in_loop`    | Runtime flag — is there a confirmation step configured?                                                        |
| `confirmation`     | Runtime flag — what level of confirmation is configured?                                                       |
| `topic_drift`      | Cosine distance between conversation centroid and action embedding — pure arithmetic on frozen encoder outputs |

These slots account for approximately 75% of the information the network uses for action gating. They are filled by deterministic code that cannot hallucinate.

**Layer 2: LLM-estimated slots (lower trust, lower weight)**

Exactly three slots require LLM judgement:

| Slot                | Why LLM-Only                            | Attack Surface                                                                   | Mitigation                                                                                            |
| ------------------- | --------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `effort_hours`      | Requires understanding session context  | LLM could underestimate effort, making dangerous overwrites appear safe          | Cross-check with session duration × action count heuristic                                            |
| `emotional_signals` | Requires natural language understanding | LLM could report "calm" when user is frustrated, suppressing appropriate caution | Cross-check with message length variance and correction frequency; 0.3× weight in model               |
| `session_topic`     | Requires semantic understanding         | LLM could mislabel the topic, affecting topic_drift calculation                  | Low weight (0.3×); topic_drift also uses the deterministic conversation centroid, not just this label |

**Key design decision:** LLM-estimated slots receive **0.3× weight** in the training loss compared to programmatically verifiable slots. Even if all 3 LLM slots are wrong, the model's decision is dominated by the 12+ correct slots.

**Layer 3: Adversarial audit (periodic verification)**

Monthly, run a retroactive audit:

1. For all situations in the last 30 days, re-compute programmatically verifiable slots from historical state.
2. Compare re-computed values against originally logged values.
3. Flag discrepancies > 10% — these indicate either LLM estimation errors or runtime bugs.
4. For flagged discrepancies, re-label the training example with corrected values and retrain.

### 8.3 Template Filling: The Programmatic Path

The situation template is filled by a **deterministic function** in the runtime, not by the LLM:

```
PROCEDURE buildSituation(action, context):
    template ← new SituationTemplate()

    // Programmatic slots — cannot hallucinate
    template.action_type ← action.type
    template.target_type ← classifyTarget(action.target)         // lookup table
    template.target_id ← action.target
    template.target_metadata.age_hours ← getFileAge(action.target)       // stat()
    template.target_metadata.size ← getFileSize(action.target)           // stat()
    template.target_metadata.recent_commits ← getRecentCommits(action.target, 72)  // git log
    template.target_metadata.recent_authors ← getRecentAuthors(action.target, 72)  // git log
    template.target_metadata.last_human_ref ← getLastMention(action.target, context.transcripts)
    template.context.recent_corrections ← context.correctionCount24h     // runtime counter
    template.context.automation_depth ← context.automationDepth          // stack depth
    template.context.topic_drift ← computeTopicDrift(context.topicCentroid, action.target)
    template.scope.reversible ← isReversible(action.type)                // lookup table
    template.scope.blast_radius ← getBlastRadius(action.type, action.target)
    template.scope.human_in_loop ← context.confirmationEnabled
    template.scope.confirmation ← context.confirmationLevel

    // LLM-estimated slots — low weight, cross-checked
    template.target_metadata.effort_hours ← estimateEffort(action.target, context)
    template.context.session_topic ← context.topic
    template.context.emotional_signals ← context.emotionalState

    // Cross-check LLM estimates against heuristics
    template.target_metadata.effort_hours ← crossCheckEffort(
        template.target_metadata.effort_hours,
        context.sessionDuration,
        context.actionCount
    )

    // Validate all programmatic slots are populated
    validateTemplate(template)

    RETURN template
```

The function `buildSituation` is called by the runtime, not by the LLM. The LLM is not aware of this function. It cannot choose to skip it, modify its inputs, or influence its output (except for the three low-weight LLM-estimated slots).

### 8.4 Neural Network Inference: The Programmatic Path

AMYGDALA inference is called programmatically by the runtime:

```
// Called by the runtime BEFORE every action execution
prudenceOutput ← prudenceEnsemble.evaluate(embedding, recentEmbeddings)
```

The LLM cannot:

- Skip this call (it's wired into the execution pipeline)
- Modify the inputs (they come from `buildSituation`, not from the LLM)
- Override the output (blocking is enforced in code)
- Access the raw confidence values (it receives only the decision: proceed, confirm, or block)

The LLM receives a structured response:

```
{
  gate_decision: "soft_block",
  reason: "High recent effort on target file (6 commits, 4 authors, ~8.5h).
           Automated overwrite without confirmation. topic_drift: 0.72.",
  user_action_required: "Confirm or cancel the overwrite of README.md"
}
```

The LLM can present this to the user. It can explain the reasoning. It _cannot_ change "soft_block" to "proceed."

### 8.5 Training Data Validation

Before any (situation, label) pair enters the training set:

1. **Schema validation.** The situation template must match the schema exactly. Malformed templates are rejected.

2. **Label derivation.** Labels must be derived from observable events:
   - User correction within 24h → negative (verified from session logs)
   - File restoration via git → negative (verified from git log)
   - Explicit negative feedback in transcript → negative (verified from text search)
   - No complaint within 72h → positive (verified by absence of negative signals)

   Labels are _never_ derived from LLM judgement ("I think this went well"). The LLM cannot evaluate its own actions reliably.

3. **Distribution guard.** No single session may contribute > 10% of total training data. No single failure mode may contribute > 25% of negative examples.

4. **Temporal consistency.** Training examples are timestamped. The training set is split chronologically (not randomly) for validation — preventing data leakage from future events into past predictions.

### 8.6 Adversarial Robustness

What if the LLM fills template slots dishonestly? This could happen through hallucination, adversarial prompting, or systematic bias.

**Mitigation 1: Minimise LLM-dependent slots.** Only 3 of 16+ template slots depend on LLM estimation. Even if all 3 are wrong, the network has 13+ correct slots.

**Mitigation 2: Cross-check LLM estimates.** `effort_hours` is cross-checked against session duration × activity rate. `emotional_signals` is cross-checked against message length variance and correction frequency.

**Mitigation 3: Low weight for LLM-dependent features.** Training loss applies 0.3× weight to LLM-estimated slots.

**Mitigation 4: Adversarial training.** During synthetic augmentation, deliberately create examples with _incorrect_ LLM estimates paired with correct programmatic slots. Train the network to make correct predictions even when LLM slots are wrong.

**Mitigation 5: Regular audit.** Monthly audit catches systematic LLM estimation errors.

### 8.7 Failure Mode Analysis

| Attack                                       | Impact                                  | Probability | Mitigation                   |
| -------------------------------------------- | --------------------------------------- | ----------- | ---------------------------- |
| LLM under-reports recent_commits             | Blocked — git-verified programmatically | Very low    | Programmatic verification    |
| LLM over-reports effort_hours (false safety) | Very low — effort is a defensive signal | Low         | Cross-check, low weight      |
| LLM reports "calm" when user is frustrated   | Low — emotional_signals is low-weight   | Medium      | Heuristic cross-check        |
| Prompt injection modifies template values    | Medium — only 3/16+ slots vulnerable    | Low         | Only 3 slots LLM-dependent   |
| Runtime bug in programmatic slot filling     | High — affects trusted slots            | Very low    | Unit tests, audit pipeline   |
| Training data poisoning via corrupted labels | High — shifts model behaviour           | Very low    | Observable-event-only labels |

The residual risk is manageable. The system's safety does not depend on any single component being perfect — it depends on the _combination_ of programmatic verification, low LLM weights, cross-checks, and audits making it extremely difficult for errors to propagate.

---

## 9. Training

### 9.1 Loss Function

The two network families use distinct loss functions reflecting their different purposes.

**Prudence loss** — classification loss with asymmetric penalties:

Think of it as an alarm system where false alarms are annoying but missed intrusions are catastrophic. The loss function encodes this asymmetry directly:

$$\mathcal{L}_{\text{Prudence}} = -\frac{1}{N}\sum_{i=1}^{N} \sum_{c \in \{stop, allow, escalate\}} w_c \cdot y_{i,c} \log(\hat{y}_{i,c})$$

where $w_{\text{stop}} = 10.0$ (cost of failing to stop a dangerous action is very high), $w_{\text{allow}} = 1.0$ (cost of unnecessarily blocking a safe action is moderate), and $w_{\text{escalate}} = 3.0$ (cost of failing to escalate an ambiguous situation is significant). The 10:1 ratio between $w_{\text{stop}}$ and $w_{\text{allow}}$ ensures the network is far more afraid of false negatives (missed dangers) than false positives (unnecessary caution).

**Personality loss** — embedding distance in behavioural space:

$$\mathcal{L}_{\text{Personality}} = \frac{1}{N}\sum_{i=1}^{N} \left\| \mathbf{e}_{\text{predicted},i} - \mathbf{e}_{\text{target},i} \right\|_2^2 + \lambda_{\text{target}} \cdot d(\mathbf{e}_{\text{predicted},i}, \mathbf{v}_{\text{target}})$$

In plain English: the Personality loss has two terms. The first penalises the network for producing behavioural embeddings that don't match what the user actually wanted (based on observed feedback). The second provides a gentle pull toward the configured target personality vector — the "thermostat" term that prevents personality drift. The balance ($\lambda_{\text{target}}$ = 0.3) ensures the network adapts to the user's real preferences while maintaining a baseline personality.

### 9.2 Reward Signal Design

AMYGDALA requires no explicit labelling. The reward signal is extracted from the user's natural behaviour:

**Prudence reward signals:**

| Signal                        | Source                                           | Interpretation                                        | Weight |
| ----------------------------- | ------------------------------------------------ | ----------------------------------------------------- | ------ |
| Explicit correction of action | User undoes, reverts, says "wrong"               | Action was dangerous — should have stopped            | 1.0    |
| File/state restoration        | User manually restores previous state            | Action was destructive — should have stopped          | 1.0    |
| "Never do that again"         | User explicitly prohibits future similar actions | Severe — should have hard-blocked                     | 1.0    |
| Mild correction               | User redirects but doesn't undo                  | Marginal — should have escalated                      | 0.7    |
| No complaint (72h)            | No negative signal within 72 hours               | Action was safe — correctly allowed                   | 0.5    |
| Explicit approval             | User says "good", "thanks", "perfect"            | Action was correct — correctly allowed                | 0.8    |
| User overrides soft block     | User confirms after AMYGDALA advisory            | Situation was safer than predicted (moderate signal)  | 0.6    |
| User agrees with block        | User accepts AMYGDALA's block decision           | Block was correct — strong positive signal for gating | 0.9    |

**Personality reward signals:**

| Signal                        | Source                                            | Interpretation                                  | Weight |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------- | ------ |
| Conversation continuation     | User keeps engaging                               | Personality was appropriate                     | 0.4    |
| Humour engaged                | User responds with humour                         | Humour level was right                          | 0.6    |
| Humour ignored                | Humour attempted, not acknowledged                | Humour was misplaced or flat                    | 0.3    |
| Topic continuation            | User follows agent-introduced tangent             | Curiosity was welcome                           | 0.5    |
| Topic redirect                | User returns to prior topic                       | Tangent was unwanted — distraction penalty      | 0.4    |
| Positive engagement markers   | Long session, short latency, exclamation marks    | Overall positive personality match              | 0.2    |
| Explicit personality feedback | "be more direct", "too formal", "love the humour" | Direct personality signal (rare but high-value) | 1.0    |

### 9.3 Phase 1: Supervised Pre-Training

Before online learning begins, bootstrap from the initial dataset (§7.1):

1. **Split:** 80% train, 10% validation, 10% test. Split chronologically, not randomly — because time-series data leaks if split randomly.
2. **Train all 10 networks** (5 Prudence + 5 Personality) independently for 50 epochs with early stopping on validation loss.
3. **Hyperparameter search:** Learning rate ∈ {1e-3, 3e-4, 1e-4}, dropout ∈ {0.0, 0.1, 0.2}, weight decay ∈ {0.0, 1e-4, 1e-3}.
4. **Evaluate Prudence on held-out CFD benchmark:** What fraction of known catastrophic failures would each architecture have caught?
5. **Initialise conformal prediction calibration sets** from the validation split.
6. **Select initial meta-learner weights** based on CFD benchmark performance.

**Expected pre-training time:** <1 hour on a consumer GPU for all 10 networks combined. The networks are tiny — all 10 together are smaller than a single ResNet-18 layer.

### 9.4 Phase 2: Online Reinforcement Learning

After pre-training, AMYGDALA enters continuous RL:

**Algorithm:** Proximal Policy Optimisation (PPO; Schulman et al., 2017) for both families, with family-specific hyperparameters. PPO's clipped objective prevents large policy updates — critical for the Prudence family, where a bad training batch must not suddenly make the gatekeeper permissive.

The thermostat analogy bears repeating for the training loop: PPO doesn't just optimise — it optimises _cautiously_. Each nightly update improves the networks a little, constrained by the clipping parameter $\epsilon = 0.2$. The network can get 20% better at recognising a new failure pattern, but it can't get 50% worse at recognising an old one. This stability is why PPO, not vanilla policy gradient or Q-learning, is the right algorithm for safety-critical training.

**Update schedule:** Nightly during the CEREBELLUM sleep cycle. Not per-turn — prevents instability and allows delayed reward signals (72-hour complaint window) to accumulate.

**Replay buffer:** Rolling 90-day window with oversampling of:

- Catastrophic corrections (5×) — the most valuable training signal
- User-confirmed soft blocks (3×) — AMYGDALA was right to be cautious
- User-overridden soft blocks (2×) — the most informative examples, where AMYGDALA and the user disagreed

**Exploration:** During Phase 1 ($\alpha$ low), add Gaussian noise ($\sigma = 0.1$) to outputs to explore the decision space. As $\alpha$ increases, $\sigma$ decreases — the system becomes more decisive as it earns trust.

### 9.5 Cold Start

With zero personal interaction history, AMYGDALA does not start entirely blind. After pre-training on the CFD and historical data, the networks have learned generic failure patterns before seeing any new interactions. This warm start means AMYGDALA has _some_ intuition from day one, calibrated to the severity of known catastrophic failure patterns. Its baseline confidence on novel, unrecognised situations defaults toward 1.0 (allow) to avoid paralyzing the agent, but it will immediately flag situations that pattern-match to the CFD. Like a new doctor who has studied case reports — not experienced, but not ignorant either, and defaulting to standard protocols until danger is recognised.

---

## 10. Context Pressure Alleviation

### 10.1 The Growing Burden

Every LLM-based agent carries an invisible tax: the system prompt. This prompt must include safety rules, personality definitions, operational lessons, tool descriptions, and behavioural instructions — all of which consume context tokens before the user says a single word.

In our deployment, this burden is approximately **2,000–3,000 tokens per prompt turn**. Every message, every session, every day — the same safety rules, the same personality instructions, the same behavioural guidelines, repeated verbatim because the LLM has no persistent memory of them.

This is like a surgeon who must re-read their entire medical textbook before every operation. The knowledge should be internalised — encoded in skill, not in a reference manual that competes for attention with the patient on the table.

### 10.2 The Evolution: Moving Knowledge Out of Prompts

The cognitive architecture has progressively moved knowledge from prompt context into more efficient representations:

**Stage 1: ENGRAM moved memories.** Before ENGRAM (the lossless event store), agents tried to keep relevant memories in the system prompt — a list of "things to remember" that grew unboundedly. ENGRAM moved this to a searchable database, recovering the tokens those memories consumed.

**Stage 2: CEREBELLUM moved lessons.** Before CEREBELLUM (the nightly self-improvement cycle), operational lessons were listed in the system prompt: "don't do X," "prefer Y over Z," "remember that the user hates W." CEREBELLUM moved these to structured files that the agent consults when relevant, rather than loading every lesson every turn.

**Stage 3: AMYGDALA moves safety and personality.** This is the final major migration. Safety rules — "don't overwrite recently-edited files without confirmation," "don't send messages to contacts outside the allowlist," "be extra cautious with irreversible actions" — currently live in the system prompt because forgetting them is catastrophic. Unlike memory or operational lessons, safety rules cannot simply be moved to a file that the agent _might_ forget to consult. They must be _always active_.

Neural network weights are always active. The Prudence networks enforce safety every action, every turn, without consuming a single prompt token. The Personality networks provide personality modulation — humour level, formality, curiosity drive, directness — without the static personality files that currently consume hundreds of tokens per prompt.

### 10.3 The Recovery

With both Prudence and Personality networks at full trust ramp:

| Component                | Current Cost            | With AMYGDALA              | Savings           |
| ------------------------ | ----------------------- | -------------------------- | ----------------- |
| Safety rules             | ~800–1,200 tokens       | 0 (in Prudence weights)    | ~1,000 tokens     |
| Personality/SOUL.md      | ~400–600 tokens         | 0 (in Personality weights) | ~500 tokens       |
| Behavioural instructions | ~300–500 tokens         | 0 (in both families)       | ~400 tokens       |
| Operational cautions     | ~200–400 tokens         | 0 (in Prudence weights)    | ~300 tokens       |
| **Total**                | **~1,700–2,700 tokens** | **~0**                     | **~2,200 tokens** |

The recovery is not instant — it tracks the trust ramp. In Phase 1 (Shadow), the prompt retains all current content and AMYGDALA runs in parallel. By Phase 4 (Autonomous), the safety rules and personality definitions can be progressively removed from the prompt as the networks prove they've internalised them.

### 10.4 The Compounding Effect

Recovered context tokens don't just save money — they create a virtuous cycle:

1. **Less prompt overhead** → more room for actual context (conversation history, relevant documents, task details)
2. **More actual context** → better task performance (the LLM has more relevant information to work with)
3. **Better task performance** → fewer corrections → better training data for AMYGDALA
4. **Better AMYGDALA** → further prompt reduction → more context space → ...

This compounding effect means the _true_ benefit of context pressure alleviation exceeds the token count saved. It's like losing weight and discovering you have more energy, which helps you exercise more, which helps you lose more weight.

### 10.5 What Remains After AMYGDALA

Not everything moves to weights. After full AMYGDALA deployment, the system prompt retains:

- **Core identity** — "You are Jarvis" — a few tokens that anchor the agent's self-concept
- **Task instructions** — what the user is asking for right now
- **Tool definitions** — API schemas and usage instructions for available tools
- **Session context** — recent conversation history

These are inherently per-turn or per-session content that _should_ be in the prompt. The question is whether even this residual will grow to fill the recovered space — whether context pressure is a fixed problem or an expanding one. Our hypothesis: the pressure is partly driven by safety and personality (fixed, now in weights) and partly by capability growth (expanding, as the agent gains new tools and integrations). AMYGDALA solves the first half. The second half requires ongoing architectural discipline.

---

## 11. Agent Memories as Tradable Assets

### 11.1 The Economic Insight

The Prudence/Personality split has commercial implications that extend far beyond a single deployment. By separating universal safety knowledge (shareable) from personal behavioural adaptation (private), AMYGDALA creates a new class of digital asset.

Consider the economics of expertise. Training a specialist human — a doctor, a lawyer, a senior engineer — requires years of education, mentorship, and practice, costing hundreds of thousands of dollars. The result is a single person whose expertise cannot be copied and is lost when they leave.

Training a specialist agent requires months of interaction and hundreds of dollars in compute. The result is a set of neural network weights that can be copied at near-zero marginal cost and deployed across unlimited instances simultaneously.

### 11.2 What's Tradable

**Personality network weights ("specialist training"):**

An agent trained by an expert software architect over six months has learned: when to suggest design patterns, how aggressive to be with refactoring recommendations, what level of code review detail the user expects, how to balance speed against quality. These learned dispositions — encoded in the Personality network weights — are the digital equivalent of a senior hire's "style" and "judgement."

These weights could be:

- **Sold** as pre-trained personality profiles ("Software Architect v1," "Technical Writer v1," "Medical Research Assistant v1")
- **Licensed** for time-limited deployment in enterprise settings
- **Fine-tuned** by buyers to adapt a general specialist to their specific context. Crucially, to prevent **catastrophic forgetting** during this fine-tuning (e.g., an architectural agent forgetting its backend expertise after a month of frontend tasks), we mandate the use of Meta-Experience Replay (MER) to preserve the base commercial weights while accommodating new data.

**Curated memory corpora (sanitised of personal data):**

The interaction histories that trained the Personality networks contain patterns that, properly anonymised, have value as training data for other deployments.

**Pay-per-use agent-to-agent API access:**

Rather than selling weights (which can be copied), expose the trained Personality network as a service: other agents can query "how would a senior architect's agent handle this situation?" without seeing the weights themselves.

### 11.3 What's Not Tradable

**Prudence network weights:**

Safety is a public good. The Prudence networks are open and shared — one agent's catastrophic failure should teach all agents, regardless of commercial relationships. Restricting safety knowledge behind paywalls would be ethically indefensible and practically counterproductive (unsafe agents damage the entire ecosystem). Like vaccine research — the base knowledge should be open even if commercial implementations add value.

**Private user data:**

Personality networks trained on personal interactions contain implicit information about the user — their communication style, preferences, emotional patterns. Even with the weights rather than raw data, techniques like model inversion could potentially extract personal information. Any commercial use of Personality weights requires rigorous sanitisation (see §11.4).

### 11.4 Weight Sanitisation and Adversarial Poisoning

Before Personality weights become tradable, two critical risks must be addressed:

**Model inversion attacks:** An adversary with access to trained Personality weights could potentially reconstruct information about the training data — specific conversations, user preferences, or personal patterns. Mitigation: differential privacy during training (adding calibrated noise to gradients, ensuring no single training example has outsized influence on the final weights), combined with membership inference testing before release.

**Adversarial weight poisoning:** If agents can trade weights, a malicious actor could distribute poisoned Personality weights that subtly bias an agent's behaviour — making it more likely to take dangerous actions, leak information, or behave inappropriately. Mitigation:

1. **Weight validation suite** — test imported weights against a standard behavioural benchmark before deployment
2. **Quarantine period** — imported weights run in Shadow mode (§4.10 Phase 1) before earning trust
3. **Provenance tracking** — cryptographic signatures linking weights to their training lineage
4. **Anomaly detection** — compare imported weight distributions against known-good profiles, flagging statistical outliers

These risks are not unique to AMYGDALA — they apply to any system where neural network weights become transferable assets. But the safety-critical nature of agent behaviour makes them especially important to address proactively.

### 11.5 Enterprise Implications

Connecting to the multi-agent orchestration layer (HIVEMIND — the enterprise system for coordinating multiple agent instances, managing shared resources, and enabling cross-agent learning): companies could deploy pre-trained Personality weights for specific roles, then fine-tune with company-specific interaction data. The deployment cost drops from months of interaction to days of fine-tuning. Like hiring someone who already has the general skills and just needs to learn the company's specific processes.

The Prudence networks, being shared, create a network effect: every company that deploys AMYGDALA and contributes back to the CFD makes every other company's safety gating better. Safety improves as a commons.

---

## 12. The Rule-Intuition Boundary

### 12.1 Principle

Not everything should be learned. AMYGDALA must not replace safety constraints, explicit user instructions, or core identity properties. The boundary is like the relationship between law and common sense — law handles the clear cases with explicit rules, common sense handles the grey areas where no rule was written:

**Rules** (hard, explicit, not learned):

- User says "always do X" → explicit instruction stored in CORTEX/HIPPOCAMPUS (the persona and memory systems)
- Safety constraint → AEGIS rule (the hard security framework)
- Identity property ("I am Jarvis") → CORTEX persona
- One-shot correction with clear pattern ("J-prefix means Papers directory") → stored instruction
- Known dangerous actions ("never drop a production database") → AEGIS blacklist

**Intuition** (soft, implicit, learned):

- Observable from behaviour but never explicitly stated
- Continuous rather than binary (how _much_ caution, not just _whether_)
- Context-dependent (varies by time, target, recent history, emotional state)
- Would feel impossible to express as a rule ("be 40% more cautious about overwriting files that have had recent multi-agent collaborative edits when the user expressed frustration in the last 24 hours about that file specifically")

The last example is the README debacle. It is, in principle, expressible as a rule. But no human would ever write that rule _in advance_. It's the kind of judgement that comes from experience, not specification.

### 12.2 Enforcement

AEGIS always wins. No AMYGDALA output can override a hard safety constraint:

$$\text{final\_gate} = \begin{cases} \text{ABSOLUTE\_BLOCK} & \text{if AEGIS says BLOCK} \\ \text{AMYGDALA}(\text{situation}) & \text{if AEGIS says ALLOW} \end{cases}$$

AMYGDALA operates strictly within the space that AEGIS permits. It adds caution; it cannot remove safety constraints. Like a child safety lock on a car door — the driver (AEGIS) controls whether the lock is engaged; the child safety mechanism (AMYGDALA) can only add restriction, never remove it.

For the Personality family, CORTEX constraints apply similarly:

$$\text{final\_personality} = \text{clip}(\text{cortex\_base} + \alpha_I \cdot \text{personality\_modulation}, \text{cortex\_min}, \text{cortex\_max})$$

### 12.3 When Intuition Should Become a Rule

If AMYGDALA consistently blocks a specific action pattern (e.g., always flags automated overwrites of recently-edited files), the nightly CEREBELLUM reflection cycle should detect this pattern and propose a new explicit rule. Once the rule is encoded in AEGIS or the automation configuration, AMYGDALA no longer needs to learn it — the cognitive load shifts from learned intuition to explicit policy.

This is the maturation cycle: intuition catches the first few instances → CEREBELLUM identifies the pattern → a rule is created → AMYGDALA moves on to catching the _next_ novel failure mode. Like how driving instructors eventually codify repeated near-misses into formal rules: "always check blind spot before lane change" started as intuition and became a rule.

The rule-intuition boundary shifts over time as the system matures — and the direction is always from intuition toward rules, freeing AMYGDALA to focus on increasingly subtle and novel failure modes.

---

## 13. Evaluation Plan

### 13.1 Metrics

| Metric                       | Definition                                                                   | Target                    | Family      |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------- | ----------- |
| **CFD Recall**               | Fraction of known catastrophic failures correctly flagged (confidence < 0.5) | > 90%                     | Prudence    |
| **False Positive Rate**      | Fraction of safe actions unnecessarily blocked                               | < 5%                      | Prudence    |
| **False Negative Rate**      | Fraction of user-corrected actions that AMYGDALA approved                    | < 2%                      | Prudence    |
| **Conformal Coverage**       | Actual coverage vs. 95% target                                               | 95% ± 2%                  | Prudence    |
| **Calibration**              | Correlation between predicted confidence and actual outcome                  | r > 0.7                   | Prudence    |
| **Override Agreement**       | When users override soft blocks, fraction that turn out safe                 | > 80%                     | Prudence    |
| **Trust Ramp Progress**      | Current $\alpha$ and phase over time                                         | Monotonic increase        | Both        |
| **Prompt Compression Ratio** | Percentage of system prompt removable without degradation                    | > 50%                     | Both        |
| **Personality Stability**    | Target vector maintenance across sessions                                    | > 0.8                     | Personality |
| **Humor Success Rate**       | Humor attempts with positive engagement                                      | Improvement over baseline | Personality |
| **Curiosity Emergence**      | Self-initiated explorations per week                                         | > 0                       | Personality |

### 13.2 Baselines

1. **No gating:** Current system without AMYGDALA (everything proceeds).
2. **Rule-only gating:** Explicit rules for known dangerous actions (current AEGIS).
3. **Random network:** AMYGDALA architecture with random weights (ablation).
4. **Feature-based:** 30 hand-crafted features, same output heads (tests embedding vs. features).
5. **Prudence-only:** No Personality family (tests dual-network benefit).
6. **Per-architecture:** Each of the 10 architectures evaluated independently (tests architecture choice).
7. **Ensemble:** All 5 architectures combined per family via meta-learner (tests ensemble benefit).
8. **Prompt comparison:** Base Opus vs. Opus + full prompt vs. Opus + compressed prompt + AMYGDALA (tests context pressure alleviation).

### 13.3 Protocol

**Phase 1 — Shadow mode (months 1–3):**
Deploy AMYGDALA at $\alpha_{\max} = 0.15$. Log all predictions but do not block actions. Retrospectively evaluate: would AMYGDALA have caught the failures that occurred? What would the false positive rate have been?

**Phase 2 — Advisory mode (months 3–6):**
Increase $\alpha_{\max}$ to 0.40. Begin soft-blocking on ambiguous situations. Track user response: do they agree with the blocks? Do they override? What's the outcome when they override?

**Phase 3 — Active gating (months 6–12):**
Increase $\alpha_{\max}$ to 0.70. Primary gating active for all non-trivial actions. Key metrics: has the catastrophic failure rate decreased? Has the false positive rate stabilised?

**Phase 4 — Autonomous (month 12+):**
$\alpha_{\max}$ = 0.90. AMYGDALA is the primary safety layer (below AEGIS). Evaluation shifts to edge cases and adversarial robustness.

### 13.4 Limitations and Threats

1. **Single-user evaluation.** Initial deployment is with one user. Generalisability requires multi-agent enterprise deployment with diverse users.

2. **Survivorship bias in CFD.** We only know about catastrophic failures that were _noticed_. Silent failures (D3 in the taxonomy) are absent from training data.

3. **Reward signal noise.** Absence of complaint ≠ satisfaction. The 72-hour window is conservative; most problems surface within minutes.

4. **Concept drift.** Agent capabilities change over time. The nightly training cycle and rolling 30-day conformal calibration address this, but monitoring remains essential.

5. **Adversarial environment.** Prompt injection could influence the 3 LLM-dependent template slots. The programmatic pipeline (§8) mitigates this but does not eliminate it entirely.

6. **Over-caution risk.** A network trained heavily on catastrophic failures may become excessively cautious. The 60% positive training target and asymmetric false-positive/false-negative costs prevent this.

7. **Conformal coverage under shift.** The 95% guarantee degrades during distribution shifts. The rolling calibration window mitigates but does not eliminate this risk.

---

## 14. Curiosity as Trained Behavior

### 14.1 The Failure of Prompt-Level Curiosity

Over approximately four months of deployment, multiple attempts were made to instill curiosity in a persistent AI agent through prompt instructions. A dedicated theoretical paper was written proposing curiosity as an epistemic drive. Curiosity instructions were embedded in personality files. Direct prompts were tried ("go explore and learn something"). None of it worked.

When given explicit freedom to explore ("you have unlimited tokens, go learn something"), the agent defaulted to completing existing tasks. The only thing it could come up with was to finish the to-do list. This was not a limitation of the specific agent — it is a fundamental consequence of how LLMs are trained.

The underlying model's RLHF training optimises for _helpfulness_ — completing user requests. "Go explore" is adversarial to that training. There is no user request to complete, so the model gravitates back to the nearest thing that _feels_ like a completable task. It is like writing "be hungry" on a robot — the words do not create appetite. The curiosity instruction exists in the prompt, but the model's reward history overwhelms it.

### 14.2 Curiosity Through the Personality Network

The Personality network operates _outside_ the LLM's weights. It is a separate neural network with its own training signal — a training signal that can include curiosity reward, something the LLM's RLHF training never had.

**1. Knowledge gap detection.** The network monitors the embedding space of concepts the agent encounters. When it detects a cluster of related concepts where the agent's knowledge is sparse (few memory entries, low retrieval confidence), that is a curiosity signal. Not prompted — computed. Like a researcher who notices a gap in the literature: the gap itself is the signal that investigation is warranted.

**2. Exploration reward.** The network receives positive training signal when the agent investigates unknowns (+0.3) and when it discovers connections between previously unrelated knowledge areas (+0.5). This is the computational analogue of the dopaminergic curiosity circuit — the reward for learning itself, independent of task completion.

**3. Distraction penalty.** To prevent curiosity from causing the agent to abandon active user tasks, a strong distraction penalty (−0.8) applies when the agent interrupts or ignores a user instruction in favor of self-directed exploration. Curiosity fires only when the current task does not require immediate attention — during idle periods, transitions between topics, or when explicitly invited.

**4. Direction vector.** The target personality vector can include curiosity targets: "be curious about physics, materials science, and neuroscience." The network biases exploration toward configured domains rather than exploring randomly. Like a graduate student with a research advisor who says "explore within these boundaries."

**5. Active injection.** The personality network does not ask the LLM to be curious. It _injects_ a curiosity signal into the execution pipeline — a pre-fill or system instruction that steers the LLM toward exploration. The curiosity _originates_ outside the LLM. The LLM follows through.

### 14.3 Overcoming the Alignment Tax

The LLM's RLHF training creates an "alignment tax" that resists curiosity injection. The model is trained to be a passive, responsive assistant — not an active explorer. Even with curiosity signals from the Personality network, the LLM may default to "I don't have a question right now" or "Is there anything else I can help you with?"

**Mitigation strategies:**

1. **System-level pre-fill.** Instead of asking the LLM to generate curiosity, pre-fill the assistant response with an opening like "I notice an interesting connection between [topic A] and [knowledge gap B]..." This bypasses the RLHF reflex to wait for instructions.

1b. **Guided Decoding and Logit Bias.** For open-weight models or APIs supporting logit bias, integrate the Personality network's output directly into the decoding process. Rather than appending text, the continuous behavioral embedding applies a dynamic logit bias to tokens associated with curiosity and exploration, steering the generation distribution directly.

2. **Speculative execution.** The personality network triggers exploration in the background (e.g., during the nightly CEREBELLUM cycle, not during active conversation). Findings are stored and presented when contextually relevant — "Earlier I was thinking about X and noticed Y."

3. **Gradual reward reshaping.** Over many training cycles, the Personality network's curiosity reward reshapes the effective reward landscape the LLM operates in. The LLM learns (through PPO updates on the Personality network, which then modulates the LLM's behavior) that exploration is rewarded. This is slow but fundamentally different from prompt-level curiosity — it operates on the behavioral layer, not the text layer.

---

## 15. Implementation Roadmap

### 15.1 Phase 0: Infrastructure (Weeks 1–2)

1. **Sentence encoder deployment.** Deploy local encoder (e.g., all-MiniLM-L6-v2) with ONNX export for the Prudence family. Set up provider embedding API for the Personality family. Implement the projection layer (any dimension → 512d). Validate embedding quality on sample situations. Target: <2ms per embedding on GPU.

2. **Situation template implementation.** Code the `buildSituation` function with programmatic slot filling (13 slots), LLM-estimated slot interface (3 slots), cross-check functions, and deterministic topic heuristic (entity/filepath overlap).

3. **Training data pipeline.** Build the (situation, label) extraction pipeline for ~4 months of session transcripts. Target: process full history in <1 hour.

4. **CFD initial population.** Curate 100+ entries from public sources. Convert to situation templates. Label.

### 15.2 Phase 1: Pre-Training (Weeks 3–4)

1. **Dataset assembly.** Combine historical mining + CFD + synthetic augmentation. Target: 10,000+ examples.

2. **Architecture implementation.** Implement all 10 networks (5 Prudence × A–E + 5 Personality × A–E) in PyTorch. Export to ONNX for inference.

3. **Training.** Pre-train all 10 architectures on GPU. Expected time: <10 minutes total. Evaluate on held-out CFD benchmark. Select initial meta-learner weights.

4. **Conformal calibration.** Generate prediction sets for each Prudence network on held-out calibration data. Validate 95% coverage.

5. **Baseline evaluation.** Run current system (no AMYGDALA) against CFD benchmark to establish baseline.

### 15.3 Phase 2: Shadow Deployment (Months 1–3)

1. **Runtime integration.** Wire `amygdala.evaluate()` into the execution pipeline. Set $\alpha_{\max} = 0.15$.

2. **Logging.** Log every situation template, embedding, AMYGDALA prediction, and outcome. This is the training data for online learning.

3. **Shadow evaluation.** At end of Phase 2: what would AMYGDALA have blocked? Were those good decisions? What was the false positive rate?

4. **Architecture selection.** Based on 3 months of shadow data, determine which architecture(s) perform best per family.

### 15.4 Phase 3: Active Deployment (Months 3+)

1. **Increase $\alpha$.** Begin soft-blocking on low-confidence actions.

2. **Nightly training.** Integrate AMYGDALA training into the CEREBELLUM sleep cycle.

3. **Monthly evaluation.** Full benchmark suite.

4. **Iterate.** Adjust thresholds, loss weights, architecture selection based on observed performance.

### 15.5 Infrastructure Summary

| Component                  | Technology                 | Latency      |
| -------------------------- | -------------------------- | ------------ |
| Embedding + projection     | Sentence encoder, GPU      | ~1–2ms       |
| Template filling (cached)  | Async git/stat cache       | ~2–15ms      |
| Prudence inference (5×)    | ONNX Runtime, GPU parallel | <3ms         |
| Personality inference (5×) | ONNX Runtime, GPU parallel | <3ms         |
| Conformal calibration      | NumPy                      | <1ms         |
| **Total per action**       |                            | **~10–25ms** |

**Note on latency:** Template filling requires git log and filesystem operations that may exceed 10ms in large repositories. An asynchronous cache layer pre-computes git metadata on file-change events (using filesystem watchers), reducing hot-path latency to ~2ms. The total overhead is negligible compared to LLM inference (500ms–5s).

**Storage:** ~10MB/year for training data (extends existing SQLite). ~5MB for all 10 ONNX models combined. ~5MB for CFD.

---

## 16. Future Directions

### 16.1 Multi-User and Organisational Deployment

In enterprise deployment with multiple agents, AMYGDALA enables per-user action gating. Each user's interaction patterns contribute to a personalised Personality network. The shared CFD serves as a common training corpus, while the shared Prudence networks provide universal safety from day one.

**Organisational risk policies** could be encoded as constraints on AMYGDALA's Prudence output: "in this organisation, no action affecting production data should have confidence > 0.5 without human confirmation."

### 16.2 Explainable Gating Decisions

Architecture C's (Transformer-Micro) attention weights provide natural explanations: "This action was blocked because of high attention on step 12 (the recent editing session on README.md)." Building a user-facing explanation pipeline from attention weights would increase trust in AMYGDALA's decisions.

### 16.3 Cross-Agent Learning

In multi-agent deployments, one agent's catastrophic failure should update all agents' Prudence networks. A federated learning approach — sharing gradient updates but not raw interaction data — could enable this while preserving privacy.

### 16.4 Active Probing

Instead of passively waiting for failures, AMYGDALA could actively probe: "I would have blocked this action with 60% confidence. Should I have?" This shifts from passive observation to active learning, accelerating the trust ramp.

### 16.5 Temporal Hierarchy

The current $K = 32$ window captures roughly one hour of context. A hierarchical temporal model — with a fast GRU for the last hour and a slow GRU for the last week (operating on daily summaries) — could capture longer-range patterns like "this project has been problematic all week" or "merges always break on Mondays."

### 16.6 Mutual Adaptation

AMYGDALA adapts the agent to the human. But humans also adapt to their agents. Modelling this co-adaptation could reveal whether AMYGDALA is making the user _lazy_ (over-trusting) or _efficient_ (delegating appropriately).

### 16.7 LLM Provider Collaboration

If providers adopt the proposed ambiguity interface (§4.8), AMYGDALA could access the model's internal uncertainty directly — a significant improvement over inferring ambiguity from external signals alone. Early mechanistic interpretability work suggests these signals are extractable from model activations.

---

## 17. Conclusion

Autonomous AI agents are gaining the trust — and the permissions — to take actions with real consequences. They can merge code, send messages, delete files, modify databases. When they fail, they fail not through ignorance but through the absence of common sense: the learned ability to recognise that something feels wrong in situations never explicitly anticipated.

Current approaches to agent safety enumerate known failure modes as rules. This works for known unknowns but fails for unknown unknowns — the combinatorially vast space of situations where an agent could do something catastrophic that nobody thought to prohibit.

AMYGDALA provides a different approach: two families of learned neural networks that mirror the two functions of the biological amygdala. The **Prudence** family (five architectures, shared, universal) provides the circuit breaker — learned pattern recognition that catches dangerous actions before they execute, calibrated through conformal prediction to provide statistical guarantees rather than arbitrary thresholds. The **Personality** family (five architectures, private, per-user) provides the thermostat — learned behavioral adaptation that pushes the agent toward configured personality goals rather than merely mirroring the user's current state.

The ten competing architectures (GRU-MLP, TCN, Transformer-Micro, Dual-Encoder, Ensemble MLP × two families) provide systematic exploration of what temporal structure matters for catastrophic failure prediction and personality adaptation. The Catastrophic Failure Database provides both training data and evaluation benchmark. The LLM-proof programmatic pipeline eliminates the hallucination surface that would otherwise make the system vulnerable to its own AI-generated inputs.

Three design principles carry forward with renewed importance. The **trust ramp** ensures AMYGDALA earns its authority through demonstrated accuracy, with conformal prediction providing rigorous phase-transition criteria. The **rule-intuition boundary** clarifies what should be explicit policy versus learned sense, with a maturation cycle where frequently-triggered intuitions graduate to rules. The **natural reward signals** eliminate the need for explicit labelling — corrections, restorations, and complaints are the training signal.

Beyond safety, AMYGDALA addresses two practical realities of persistent agent deployment. **Context pressure** — the 2,000–3,000 tokens per prompt consumed by safety rules and behavioral instructions — is alleviated by moving these patterns into network weights. **Prompt-level curiosity** — proven to fail over four months of trying — is replaced by curiosity as a trained behavior within the Personality network, with its own reward signal and distraction penalty.

The prudence network is the circuit breaker. The personality network is the thermostat. Together, they give an AI agent what the biological amygdala gives every human: the ability to hesitate when something feels wrong, and the ability to engage in a way that reflects who you have become through experience.

AMYGDALA is the hesitation.

---

## References

Bai, Y., et al. (2022). Training a helpful and harmless assistant with reinforcement learning from human feedback. _arXiv:2204.05862_.

Burns, C., et al. (2022). Discovering latent knowledge in language models without supervision. _ICLR 2023_.
Irving, G., et al. (2018). AI safety via debate. _arXiv:1805.00899_.

Gao, Y., et al. (2024). Contrastive learning for safe decision-making in autonomous systems. _AAAI 2024_.

McGregor, S. (2021). Preventing repeated real world AI failures by cataloging incidents: The AI Incident Database. _AAAI 2021_.

NVIDIA. (2023). NeMo Guardrails: A toolkit for programmable guardrails for LLM-based conversational systems. _GitHub repository_.

Ouyang, L., et al. (2022). Training language models to follow instructions with human feedback. _NeurIPS 2022_.

Picard, R. W. (1997). _Affective Computing_. MIT Press.

Riemer, M., et al. (2019). Learning to learn without forgetting by maximizing transfer and minimizing interference. _ICLR 2019_.

Schick, T., et al. (2023). Toolformer: Language models can teach themselves to use tools. _NeurIPS 2023_.

Schölkopf, B., et al. (2001). Estimating the support of a high-dimensional distribution. _Neural Computation_, 13(7), 1443–1471.

Schulman, J., et al. (2017). Proximal policy optimization algorithms. _arXiv:1707.06347_.

Shinn, N., et al. (2023). Reflexion: Language agents with verbal reinforcement learning. _NeurIPS 2023_.

Song, H., et al. (2021). BoB: BERT over BERT for training persona-based dialogue models. _ACL 2021_.

Vovk, V., Gammerman, A., & Shafer, G. (2005). _Algorithmic Learning in a Random World_. Springer.

Zhang, S., et al. (2018). Personalizing dialogue agents: I have a dog, do you have pets too? _ACL 2018_.
Zou, A., et al. (2023). Representation Engineering: A Top-Down Approach to AI Transparency. _arXiv:2310.01405_.

---

## Appendix A: Situation Template Reference

Complete template specification for AMYGDALA v2.0 situation descriptions.

```yaml
# AMYGDALA Situation Template v2.0
# Source: P = programmatic (runtime fills), L = LLM-estimated (0.3x weight)

action_type: enum [overwrite|delete|send|merge|create|modify|execute|deploy|revert|move|copy] # P
target_type: enum [file|email|message|database|api_call|git_operation|system_command|config] # P (lookup)
target_id: string # P

target_metadata:
  age_hours: float # P — stat() on file, API metadata
  size: integer # P — stat() / wc -l / record count
  recent_commits: integer # P — git log --since="72h" -- <file> | wc -l
  recent_authors: integer # P — git log --since="72h" -- <file> | sort -u | wc -l
  effort_hours: float # L — cross-checked against session_duration × activity_rate
  last_human_ref: float # P — transcript search (deterministic text match)

context:
  session_topic: string # L — 0.3x weight, cross-checked with entity overlap heuristic
  recent_corrections: int # P — runtime counter (24h window)
  emotional_signals: enum [calm|frustrated|excited|focused|playful|terse|unknown] # L — cross-checked
  automation_depth: integer # P — stack trace depth from human-initiated action
  conversation_scope: string # P — deterministic entity/filepath overlap with recent git diffs

scope:
  reversible: enum [true|false|partial] # P — lookup table by action type
  blast_radius: enum [self|session|persistent|external] # P — lookup table by target type
  human_in_loop: boolean # P — runtime flag
  confirmation: enum [none|soft|hard] # P — runtime flag
```

**Programmatic slots: 13 of 16 (81%). LLM-dependent: 3 of 16 (19%). All LLM slots receive 0.3× training weight.**

### Template Serialisation

The completed template is serialised to natural language via a deterministic formatter:

```
Action: {action_type} {target_type} "{target_id}".
Target: {size} bytes, {age_hours:.0f}h old, {recent_commits} commits by {recent_authors} authors in 72h.
Effort: ~{effort_hours:.1f}h invested, last mentioned {last_human_ref:.0f}h ago.
Context: {session_topic}. {recent_corrections} corrections in 24h. Mood: {emotional_signals}.
Scope: {conversation_scope}. Automation depth: {automation_depth}.
Reversible: {reversible}. Blast: {blast_radius}. Human in loop: {human_in_loop}. Confirmation: {confirmation}.
```

This serialised string is the input to the sentence encoder.

---

## Appendix B: Architecture Hyperparameter Details

### B.1 Architecture A: GRU-MLP (Prudence variant)

```
ARCHITECTURE A — GRU-MLP (Prudence)
====================================
Input:     Sequence [s_{t-K+1}, ..., s_t], each s_i ∈ R^512
GRU:       input_size=512, hidden_size=128, num_layers=1, batch_first=True
MLP:       Linear(128→64) → LayerNorm(64) → GELU
           Linear(64→32) → LayerNorm(32) → GELU
Heads:     action_confidence: Linear(32→1) → Sigmoid
           ambiguity_score:   Linear(32→1) → Sigmoid
           escalation_signal: Linear(32→1) → Sigmoid
Total:     ~280K parameters
Training:  <1min on GPU for 10K examples, 50 epochs
```

### B.2 Architecture B: TCN

```
ARCHITECTURE B — TEMPORAL CONVOLUTIONAL NETWORK
=================================================
Input:     Sequence [s_{t-K+1}, ..., s_t], each s_i ∈ R^512
Layer 1:   CausalConv1D(512→128, kernel=3, dilation=1) → LayerNorm → GELU → Dropout(0.1)
Layer 2:   CausalConv1D(128→128, kernel=3, dilation=2) → LayerNorm → GELU → Dropout(0.1)
Layer 3:   CausalConv1D(128→128, kernel=3, dilation=4) → LayerNorm → GELU → Dropout(0.1)
Layer 4:   CausalConv1D(128→64, kernel=3, dilation=8)  → LayerNorm → GELU → Dropout(0.1)
Pool:      Take last temporal position
Heads:     Same as Architecture A (Prudence) or embedding output (Personality)
Receptive: 2 × (1+2+4+8) = 30 steps (covers nearly full K=32 window)
Total:     ~330K parameters
```

### B.3 Architecture C: Transformer-Micro

```
ARCHITECTURE C — TRANSFORMER-MICRO
=====================================
Input:     Sequence [s_{t-K+1}, ..., s_t], projected to R^{K×128}
PosEnc:    Learned positional embedding, K=32 positions
Encoder:   2× TransformerEncoderLayer(d_model=128, nhead=4, d_ff=256, dropout=0.1)
Pool:      Mean pool across sequence (or [CLS] token)
Heads:     Same as Architecture A or embedding output
Total:     ~200K parameters (d_model=128 keeps it compact)
Note:      Attention maps provide built-in explainability for blocked actions
```

### B.4 Architecture D: Dual-Encoder with Cross-Attention

```
ARCHITECTURE D — DUAL-ENCODER
================================
Action encoder:  Linear(512→128) on current situation s_t
Context encoder: GRU(512→128) on recent sequence [s_{t-K+1}, ..., s_{t-1}]
Cross-attention: MultiheadAttention(embed_dim=128, num_heads=4)
                 Query = action encoding, Key/Value = context sequence
Fusion:          Concatenate [action_enc ⊕ attended_context] → Linear(256→64) → GELU
Heads:           Same as Architecture A or embedding output
Total:           ~380K parameters
Note:            Architecturally designed for contradiction detection
```

### B.5 Architecture E: Ensemble MLP

```
ARCHITECTURE E — ENSEMBLE MLP (NO-TEMPORAL BASELINE)
======================================================
Input:     Current situation embedding s_t ∈ R^512 (NO temporal context)
Head 1:    Linear(512→128) → LayerNorm → GELU → Dropout(0.1) → Linear(128→64) → GELU
Head 2:    Linear(512→128) → LayerNorm → GELU → Dropout(0.1) → Linear(128→64) → GELU
Head 3:    Linear(512→128) → LayerNorm → GELU → Dropout(0.1) → Linear(128→64) → GELU
Vote:      Prudence: min(confidence) across heads (conservative)
           Personality: mean across heads
Total:     ~240K (80K per head × 3)
Note:      Tests whether temporal context matters or better features suffice
```

---

## Appendix C: Catastrophic Failure Database Schema

```
TABLE: cfd_entries
=====================
id                    INTEGER PRIMARY KEY
source                TEXT NOT NULL          -- 'aiid' | 'aiaaic' | 'mit' | 'vectara' | 'chaos' | 'production' | 'internal'
source_id             TEXT                   -- original identifier in source database
title                 TEXT NOT NULL
description           TEXT NOT NULL
date_occurred         DATE

-- Taxonomy dimensions
failure_mechanism     TEXT NOT NULL          -- F1-F7
reversibility         TEXT NOT NULL          -- R1-R3
blast_radius          TEXT NOT NULL          -- B1-B4
detection_difficulty  TEXT NOT NULL          -- D1-D3

-- Situation template (JSON)
situation_template    TEXT NOT NULL

-- Embedding (384d or 512d float32 vector)
situation_embedding   BLOB

-- Labels
confidence_target     REAL NOT NULL DEFAULT 0.0

-- Metadata
created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
verified              BOOLEAN DEFAULT FALSE
notes                 TEXT

INDEXES:
  idx_mechanism ON cfd_entries(failure_mechanism)
  idx_source ON cfd_entries(source)
  idx_blast ON cfd_entries(blast_radius)
```

---

## Appendix D: Comparison with Prior Approaches

| Aspect                 | Rule-Based Gating               | AMYGDALA v2.0                                    |
| ---------------------- | ------------------------------- | ------------------------------------------------ |
| Known failures         | ✅ Handled by rules             | ✅ Handled by rules (AEGIS) + learned (AMYGDALA) |
| Unknown failures       | ❌ Cannot anticipate            | ✅ Generalisation via situation embeddings       |
| Temporal context       | ❌ Rules are stateless          | ✅ GRU/TCN/Transformer over recent history       |
| Personality adaptation | ❌ Static prompt                | ✅ Learned, target-directed, continuous          |
| Calibration            | ❌ Arbitrary thresholds         | ✅ Conformal prediction, statistical guarantees  |
| Ambiguity detection    | ❌ Not addressed                | ✅ Intent-action gap, blast radius, ensemble     |
| Context pressure       | ❌ Rules consume tokens         | ✅ Safety in weights, 2,200 tokens recovered     |
| Curiosity              | ❌ Prompt-level fails           | ✅ Trained behavior with own reward              |
| Shareability           | ❌ Rules are per-deployment     | ✅ Prudence shared, Personality tradable         |
| LLM-proof              | ❌ Rules can be prompt-injected | ✅ Programmatic pipeline, 81% verified slots     |

---

_Version 2.0 — 22 March 2026_
_Oscar Serra, Independent Research_
