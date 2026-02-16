---
title: "LIMBIC: Laughter from Inverted Memory — Bisociation in Computational Embedding Space"
subtitle: "A Computational Framework for Humor Generation via Inverted Semantic Retrieval"
author: "O. Serra"
date: "February 2026"
version: "v2.2"
abstract: |
  We present a formal computational framework for humor generation that operationalizes Koestler's (1964) bisociation theory as geometric operations in vector embedding spaces. Our central thesis is the *memory-humor correspondence*: humor and memory retrieval are dual operations on the same semantic infrastructure — memory seeks proximity, humor seeks calibrated distance bridged by unexpected coherence. We formalize this correspondence as a precise proposition and define a computable humor potential function $h(A, B, \beta)$ grounded in Suls' (1972) two-stage incongruity-resolution model. We identify a taxonomy of 12 humor-generating semantic patterns organized into five meta-categories, each defined as a specific embedding space operation, and propose humor associations as a first-class relationship type in agent memory architectures. A preliminary computational pilot ($n = 15$ concept triplets) falsifies our initial formulation, revealing that naive coherence (cosine similarity) conflates semantic proximity with comedic validity. This negative result motivates a revised surprise-weighted formulation ($h_{\text{v2}}$) that decomposes bridge quality into independent validity and surprise components. We situate our framework within Attardo and Raskin's (1991) General Theory of Verbal Humor, McGraw and Warren's (2010) Benign Violation Theory, and Hurley, Dennett, and Adams' (2011) inside-jokes computational theory, demonstrating that bisociative embedding operations provide a unifying geometric interpretation. We provide reproducible experimental protocols with power analysis ($N \geq 64$ raters, $\alpha = 0.05$, power $= 0.80$) for validation against human ratings and existing humor corpora, propose cross-embedding-model ablation studies, and discuss limitations including cultural specificity, the delivery gap, embedding model dependence, and the absence of large-scale empirical results.
---

> **Changelog v2.1 → v2.2 (2026-02-16).** Round Table Round 3 fixes: (1) Added recommended threshold ranges for τ*v and τ*σ in Definition 2 (Humor Zone) with calibration guidance. (2) Added engineering-defaults caveat to staleness model parameters (§8.3), consistent with §3.5 callback treatment. (3) Added end-to-end computational complexity summary for h_v2 evaluation (§9.5).

> **Changelog v2.0 → v2.1 (2026-02-16).** Round Table Round 2 fixes: (1) Fixed duplicate §7.1.2 numbering (second instance → §7.1.3). (2) Added forward-reference note in Definition 2 (Humor Zone) pointing to Definition 3 for $v$ and $\sigma$. (3) Cited Ritchie (2004) in §1.4 (was dangling reference). (4) Added $k$-sensitivity analysis to surprise function (§7.1.1). (5) Clarified callback bonus parameter sourcing as engineering defaults, not empirical measurements (§3.5). (6) Specified context vector computation for embedding arithmetic (§6.2). (7) Added infrastructure assumptions to pipeline latency estimates (§6.7).

> **Changelog v1.0 → v2.0 (2026-02-16).** Major revision targeting publication readiness via Round Table consensus (PG, PGem, 2026-02-16). Key changes: (1) **Strengthened formalism**: formalized the memory-humor correspondence as a proposition (§1.2); justified the multiplicative functional form via Suls' two-stage model (§3.2); added formal definitions of the humor zone (Def. 3), bridge quality (Def. 4), and properties of $h$ (Prop. 2); justified the surprise metric as a tractable approximation to information-theoretic surprise (§7.1.1). (2) **Expanded related work** from 24 to 37 references, adding Hurley et al. (2011), Coulson (2001), Kao et al. (2016), Martin (2007), and 9 others. (3) **Clarified pilot study**: $n = 15$ concept triplets (not participants); defined all formula variants (v1–v4) as systematic exploration. (4) **Strengthened validation protocol** with formal power analysis ($N \geq 64$, Cohen's $r = 0.35$), inter-rater reliability target (Krippendorff's $\alpha \geq 0.667$), Latin square stimulus presentation, and cross-embedding-model ablation. (5) **Added embedding model requirements** subsection (§9.2). (6) **Renumbered patterns** 1–12 sequentially within meta-categories. (7) **Updated companion paper cross-references** to ENGRAM, CORTEX, SYNAPSE consistently.

# 1. Introduction

## 1.1 Motivation

Despite remarkable advances in natural language generation, artificial humor remains a largely unsolved problem. Large language models (LLMs) produce text that is syntactically well-formed and semantically coherent, yet rarely genuinely funny. We argue that this failure is not incidental but structural: language models are trained to maximize token-level likelihood, while humor requires _low-probability completions constrained by high coherence_ — precisely the opposite of the training objective (Winters et al., 2021). Hurley, Dennett, and Adams (2011) propose that humor evolved as a reward signal for detecting errors in mental models — a "debugging of belief structures" — suggesting that humor is fundamentally computational, not merely linguistic.

This observation points toward a deeper question: what computational mechanism could _generate_ humor rather than merely _classify_ it? Existing approaches fall into three categories: rule-based template systems (Binsted & Ritchie, 1994), corpus-driven classifiers (Weller & Seppi, 2019; Tian et al., 2022), and fine-tuned language models (Luo et al., 2019). None provides a generalizable, theory-grounded, generative framework that operates without humor-specific training data.

## 1.2 The Memory-Humor Correspondence

Our central insight emerges from an unexpected source: the infrastructure of semantic memory retrieval. Modern AI agents use vector embeddings to retrieve semantically relevant memories — querying an embedding index for vectors _close_ to a query vector. We observe that humor generation requires the _same_ infrastructure with an _inverted_ search strategy: instead of seeking proximity, humor seeks calibrated distance bridged by unexpected coherence.

We formalize this as follows:

**Definition 1 (Memory-Humor Correspondence).** Let $\mathcal{E} = \{e_1, \ldots, e_N\}$ be a set of concept embeddings in $\mathbb{R}^n$ indexed for nearest-neighbor retrieval. Define two operations on $\mathcal{E}$:

- **Memory retrieval**: Given query $q$, return $\arg\min_{e \in \mathcal{E}} d(q, e)$ — the nearest neighbor by cosine distance.
- **Humor retrieval**: Given query $q$, return $\arg\max_{e \in \mathcal{E}} h(q, e, \beta^*(q, e))$ — the concept maximizing humor potential via an optimal bridge $\beta^*$.

Both operations use the same index $\mathcal{E}$, the same distance metric $d$, and the same embedding space. They differ only in the optimization objective: memory minimizes distance; humor maximizes a function of distance, bridge validity, and bridge surprise.

**Proposition 1 (Inverted Optimization).** Memory retrieval and humor generation are operations on the same embedding index with inverted optimization objectives. Formally, if memory solves $\min_e d(q, e)$, humor solves a constrained problem:

$$\max_{e \in \mathcal{E}} \; d(q, e) \cdot v(\beta^*, q, e) \cdot \sigma(\beta^* \mid q, e) \quad \text{subject to} \quad d(q, e) \in [\delta_{\min}, \delta_{\max}]$$

where $v$ is bridge validity, $\sigma$ is bridge surprise, and $[\delta_{\min}, \delta_{\max}]$ is the humor-productive distance range (Section 3.4).

This correspondence is more than an analogy: it implies that any system equipped with a semantic embedding index already possesses the infrastructure for humor generation. The creative challenge reduces to _inverting the retrieval objective_ and _discovering bridge concepts_.

**Status.** Proposition 1 is a conjecture. It holds by construction for the operations as defined; the empirical question is whether the resulting humor potential function correlates with human judgments of funniness. We provide protocols for testing this in Section 7.2.

## 1.3 Contributions

This paper makes five contributions:

1. **Formalization of bisociation as embedding geometry** (Section 3): We define a computable humor potential function $h(A, B, \beta)$ that maps Koestler's (1964) bisociation theory to geometric operations over vector embeddings, with the multiplicative form justified by Suls' (1972) two-stage incongruity-resolution model.

2. **Falsification and revision** (Section 7.1): A computational pilot demonstrates that naive cosine-based coherence fails to predict humor, motivating a surprise-weighted revision that decomposes bridge quality into independent validity and surprise components.

3. **Humor pattern taxonomy** (Section 4): We identify 12 humor-generating semantic patterns, organized into five meta-categories, each defined as a specific embedding space operation, derived from the intersection of GTVH Knowledge Resources and embedding-space operation types.

4. **Bridge discovery algorithms** (Section 6): We propose five complementary methods for finding bridge concepts, with computational complexity analysis and a formal bridge quality criterion.

5. **Humor as agent memory** (Section 8): We propose humor associations as a first-class relationship type in agent memory architectures (connecting to the ENGRAM substrate; Serra, 2026a), enabling personalized humor calibration through reinforcement.

## 1.4 Historical Context

Arthur Koestler (1964) described **bisociation** as the simultaneous mental association of an idea with two habitually incompatible frames of reference. Unlike ordinary association (connecting within a single frame), bisociation connects _across_ frames — producing the cognitive surprise that underlies humor, scientific discovery, and artistic creation. Coulson (2001) provided psycholinguistic evidence for this frame-shifting mechanism through her analysis of "semantic leaps" in joke comprehension, showing that humor processing involves rapid re-mapping of conceptual spaces. Ritchie (2004) further systematized the linguistic analysis of joke structure, identifying formal patterns in how incongruity is set up and resolved — patterns that inform our taxonomy (Section 4). We argue that bisociation is precisely a geometric operation in embedding space: finding two concepts with high vector distance but connected by a coherent bridge concept.

## 1.5 Paper Organization

Section 2 reviews related work in computational humor, humor theory, and embedding-space operations. Section 3 formalizes the humor potential function with formal definitions and properties. Section 4 presents the 12-pattern taxonomy. Section 5 addresses ethical constraints. Section 6 describes bridge discovery algorithms. Section 7 presents empirical methodology, pilot results, and the proposed full validation protocol with power analysis. Section 8 proposes humor associations as a memory type, connecting to the ENGRAM and CORTEX companion papers. Section 9 discusses limitations. Section 10 concludes.

# 2. Related Work

Computational humor has been studied from linguistic, psychological, and computational perspectives. We review the most relevant work, positioning our framework relative to the dominant theories.

## 2.1 Linguistic Humor Theories

**Incongruity-Resolution.** Suls (1972) proposed that humor arises from perceiving an incongruity followed by its resolution — the listener encounters an unexpected element, then discovers a cognitive rule that resolves the incongruity. This two-stage model is critical to our framework: the multiplicative structure of $h$ (Section 3.2) directly operationalizes the requirement that _both_ stages must succeed for humor to arise.

**Script-Based Semantic Theory and GTVH.** Raskin (1985) formalized humor as the overlap of two incompatible _scripts_ (structured semantic representations of situations). Attardo and Raskin (1991) extended this into the General Theory of Verbal Humor (GTVH), identifying six Knowledge Resources (KRs) that characterize jokes: Script Opposition (SO), Logical Mechanism (LM), Situation (SI), Target (TA), Narrative Strategy (NS), and Language (LA). Our framework maps most directly to SO and LM: bisociation between distant embedding regions corresponds to script opposition, and the bridge concept provides the logical mechanism connecting them. Our contribution relative to GTVH is operational — we provide a _computable_ function where GTVH provides a descriptive taxonomy.

**Benign Violation Theory.** McGraw and Warren (2010) proposed that humor arises when a situation is simultaneously perceived as a violation (something wrong, threatening, or unexpected) and as benign (safe, acceptable, or playful). This maps naturally to our framework: the distance component $d(A, B)$ measures violation intensity, while bridge coherence measures the "benign" reinterpretation that makes the violation acceptable. The sensitivity gate (Section 5) operationalizes the boundary where violations cease to be benign.

**Inside Jokes Theory.** Hurley, Dennett, and Adams (2011) argue that humor evolved as a reward signal for detecting committed belief errors — a "just-in-time debugging" mechanism for mental models. Their computational framing is directly relevant: if humor rewards the detection of expectation violations, then our surprise component $\sigma(\beta \mid A, B)$ can be understood as quantifying the magnitude of the "debugging reward" — higher surprise indicates a more significant expectation violation that was nevertheless resolved coherently.

**Bisociation.** Koestler (1964) described bisociation as the creative act of connecting two habitually incompatible frames. Dubitzky et al. (2012) explored bisociation in data mining for knowledge discovery. Pereira et al. (2019) implemented bisociative concept blending for computational creativity, the work closest to ours, though they did not formalize the operation in embedding space or provide a computable scoring function.

**Semantic Leaps.** Coulson (2001) provided psycholinguistic evidence that joke comprehension involves rapid "semantic leaps" — frame shifts that re-map conceptual structure. Her experimental work using ERPs (N400 component) showed that joke punchlines elicit different neural signatures than non-humorous incongruities, supporting the view that humor involves a specific _type_ of frame shift, not merely any incongruity. Our bridge concept operationalizes Coulson's semantic leap as a vector in embedding space that connects two distant frames.

## 2.2 Computational Humor Recognition

Humor recognition — classifying text as humorous or not — has received substantial attention. Yang et al. (2015) used Word2Vec features for humor recognition in Yelp reviews. Bertero and Fung (2016) applied CNNs and RNNs to humor in conversational data, achieving 0.69 F1 on Switchboard. Chen and Soo (2018) employed attention-based neural networks. Weller and Seppi (2019) applied transformer architectures, demonstrating that pre-trained language representations capture humor-relevant features. Hossain et al. (2019) introduced the SemEval shared task on humor detection, establishing benchmark datasets. Tian et al. (2022) provide a comprehensive survey of humor recognition methods, categorizing approaches by feature type and noting the persistent challenge of capturing the incongruity-resolution dynamic that our framework addresses directly. These approaches are _passive_ — they classify existing humor rather than generate it. Our framework is _generative_: it produces novel humorous combinations from arbitrary concept pairs.

## 2.3 Computational Humor Generation

Template-based systems have generated specific humor subtypes: JAPE produced punning riddles (Binsted & Ritchie, 1994), HAHAcronym generated humorous acronyms (Stock & Strapparava, 2003). Petrović and Matthews (2013) demonstrated unsupervised joke generation using large corpora and simple statistical models, showing that humor generation need not require labeled data — a finding that supports our training-data-free approach. Yu et al. (2018) developed neural pun generation, and He et al. (2019) introduced surprise-based objectives for pun generation, directly connecting computational surprise to humor quality — a precursor to our surprise component in $h_{\text{v2}}$. Luo et al. (2019) used GPT-2 fine-tuning for joke completion. More recently, Amin and Burghardt (2020) surveyed computational humor generation approaches, identifying the gap between template-based systems (narrow but controllable) and neural systems (broad but uncontrollable). Winters et al. (2021) examined machine learning approaches to humor, noting the difficulty of evaluating generated humor. Kao et al. (2016) developed a Bayesian model of verbal humor that formalizes the tension between ambiguity and distinctiveness in joke interpretation — their probabilistic framework complements our geometric one, with their "distinctiveness" mapping to our surprise and their "ambiguity" mapping to our bridge concept. West and Horvitz (2019) demonstrated computational approaches to reverse-engineering satire, showing that detecting incongruity between expected and actual framings is computationally tractable — supporting our use of embedding distance as an incongruity proxy. Our framework addresses the controllability gap: it is theory-grounded (providing controllability via explicit humor patterns), generalizable (covering multiple humor types), and does not require humor-specific training data.

## 2.4 Humor Psychology

Martin (2007) provides the standard reference on the psychology of humor, synthesizing cognitive, social, and personality perspectives. Warren and McGraw (2016) extended Benign Violation Theory by systematically categorizing violation types and demonstrating that the perceived "distance" from benignity varies across moral, social, and physical domains — a finding that supports the view that our distance sweet spot (Section 3.6) may need domain-specific calibration. His taxonomy of humor styles (affiliative, self-enhancing, aggressive, self-defeating) informs our audience modeling — different humor styles correspond to different regions of the humor potential landscape, and the sensitivity gate (Section 5) must be calibrated to the intended style. Dynel (2009) analyzed conversational humor mechanisms, identifying patterns that map onto our taxonomy — particularly the role of pragmatic implicature in humor, which our "expectation subversion" pattern (Pattern 4) operationalizes. Oring (2003) examined the structure of humor through the lens of "appropriate incongruity," a concept closely aligned with our validity-weighted surprise formulation.

## 2.5 Embedding Space Arithmetic and Creativity

Mikolov et al. (2013) demonstrated that word embeddings support analogical reasoning via vector arithmetic: $\vec{king} - \vec{man} + \vec{woman} \approx \vec{queen}$. This finding established that semantic relationships have geometric structure in embedding spaces. Our bridge discovery mechanism (Section 6.1) extends this principle: if analogy maps known relationships, then $\vec{A} - \vec{context_A} + \vec{context_B}$ maps the _creative leap_ across semantic frames that humor requires. Veale (2016) explored computational creativity through conceptual blending and metaphor in similar geometric terms, though without a humor-specific scoring function. Bowdle and Gentner (2005) showed that metaphor comprehension involves alignment and projection between conceptual domains — a process closely related to our bridge discovery algorithms. Glucksberg (2001) demonstrated that figurative language comprehension involves class-inclusion assertions, suggesting that humor bridges function as implicit category memberships that violate conventional taxonomies.

## 2.6 Positioning of Our Contribution

Table 1 summarizes how our framework relates to prior approaches.

| Approach                               | Type          | Scope        | Training Required | Humor Theory    | Bridge Concept |
| -------------------------------------- | ------------- | ------------ | ----------------- | --------------- | -------------- |
| JAPE (Binsted & Ritchie, 1994)         | Generative    | Puns only    | No (rules)        | Phonological    | N/A            |
| HAHAcronym (Stock & Strapparava, 2003) | Generative    | Acronyms     | No (rules)        | Lexical         | N/A            |
| Petrović & Matthews (2013)             | Generative    | One-liners   | No (unsupervised) | Statistical     | Implicit       |
| Bertero & Fung (2016)                  | Recognition   | Dialogue     | Yes (CNN/RNN)     | Learned         | N/A            |
| Kao et al. (2016)                      | Model         | Puns         | No (Bayesian)     | Ambiguity       | Implicit       |
| Yu et al. (2018)                       | Generative    | Puns         | Yes (neural)      | Homophony       | N/A            |
| He et al. (2019)                       | Generative    | Puns         | Yes (neural)      | Surprise        | Implicit       |
| Luo et al. (2019)                      | Generative    | Jokes        | Yes (GPT-2)       | Learned         | N/A            |
| Weller & Seppi (2019)                  | Recognition   | General      | Yes (transformer) | Learned         | N/A            |
| LLM prompting (2023+)                  | Generative    | Broad        | No (prompt)       | Implicit        | N/A            |
| **LIMBIC (this work)**                 | **Framework** | **12 types** | **No**            | **Bisociation** | **Explicit**   |

_Table 1: Comparison with existing computational humor approaches. LIMBIC is unique in providing an explicit, computable scoring function grounded in bisociation theory with an explicit bridge concept, covering multiple humor types without requiring humor-specific training._

Our key differentiators: (1) an explicit, computable scoring function rather than learned representations; (2) coverage of 12 distinct humor types organized by meta-category; (3) the bridge concept as a first-class element enabling both generation and _explanation_ of why a joke works; and (4) the memory-humor correspondence enabling integration with agent memory architectures (ENGRAM; Serra, 2026a).

# 3. The Humor Potential Function

## 3.1 Core Formulation

We define the **humor potential** of a concept pair $(A, B)$ connected by a bridge $\beta$ as:

$$h(A, B, \beta) = d(A, B) \cdot c(\beta, A) \cdot c(\beta, B)$$

where:

- $A, B \in \mathbb{R}^n$ are embedding vectors for two concepts,
- $\beta \in \mathbb{R}^n$ is the embedding vector for a bridge concept,
- $d(A, B) = 1 - \cos(A, B)$ is the cosine distance (range $[0, 2]$),
- $c(x, y) = 1 - d(x, y) = \cos(x, y)$ is cosine coherence (range $[-1, 1]$, typically $[0, 1]$ for meaningful concepts).

**Interpretation.** Humor potential increases with (a) semantic distance between concepts (incongruity/violation) and (b) coherence of the bridge to both concepts (resolution/benign reinterpretation). This directly operationalizes the incongruity-resolution and benign violation theories: distance measures incongruity/violation, bridge coherence measures resolution/benign interpretation.

## 3.2 Justification of the Multiplicative Form

The multiplicative structure $h = d \cdot c \cdot c$ is not arbitrary — it operationalizes a theoretical requirement.

Suls' (1972) two-stage model posits that humor requires _both_ incongruity (Stage 1) _and_ resolution (Stage 2). If either stage fails, humor does not arise: pure incongruity without resolution produces confusion; resolution without incongruity produces boredom. This conjunction is naturally expressed as multiplication:

- If $d(A, B) \approx 0$ (no incongruity): $h \approx 0$ regardless of bridge quality.
- If $c(\beta, A) \approx 0$ or $c(\beta, B) \approx 0$ (no resolution): $h \approx 0$ regardless of distance.

The multiplication encodes the logical AND of Suls' two stages. McGraw and Warren's (2010) Benign Violation Theory imposes the same conjunction: a situation must be _both_ a violation _and_ benign. Violation without benignity produces offense; benignity without violation produces indifference.

**Alternative functional forms** should be explored empirically:

- **Additive**: $h_{\text{add}} = w_1 d + w_2 c(\beta, A) + w_3 c(\beta, B)$ — permits humor from strong incongruity alone.
- **Geometric mean**: $h_{\text{geo}} = (d \cdot c(\beta, A) \cdot c(\beta, B))^{1/3}$ — reduces the dominance of any single factor.
- **Learned combination**: $h_{\text{learn}} = f_\theta(d, c(\beta, A), c(\beta, B))$ — data-driven but loses interpretability.

We adopt the multiplicative form as the theoretically motivated default. Ablation across alternative forms is included in our proposed validation protocol (Section 7.2).

## 3.3 Formal Properties

**Proposition 2 (Properties of $h$).** The humor potential function $h: \mathbb{R}^n \times \mathbb{R}^n \times \mathbb{R}^n \to \mathbb{R}$ has the following properties:

1. **Boundedness.** For unit-normalized embeddings ($\|A\| = \|B\| = \|\beta\| = 1$), $h(A, B, \beta) \in [0, 2]$, since $d \in [0, 2]$ and $c \in [-1, 1]$.
2. **Symmetry.** $h(A, B, \beta) = h(B, A, \beta)$ — humor potential is symmetric in the concept pair.
3. **Bridge dependence.** $h$ is not symmetric in $\beta$: the same concept pair $(A, B)$ has different humor potentials under different bridges.
4. **Zero conditions.** $h = 0$ if $A = B$ (no incongruity), or if $\beta \perp A$ or $\beta \perp B$ (no resolution).
5. **Continuity.** $h$ is continuous in all arguments (as a product of continuous functions).

_Proof._ Properties 1–5 follow directly from the definitions of cosine distance and coherence and the algebraic properties of the product. $\square$

## 3.4 Extended Formulation with Audience and Timing

The core formula omits contextual factors critical to humor in practice. We extend it:

$$h_{\text{ext}}(A, B, \beta, \alpha, t) = d(A, B) \cdot c(\beta, A) \cdot c(\beta, B) \cdot f(\alpha, A) \cdot f(\alpha, B) \cdot (1 + \gamma(t))$$

where:

- $f(\alpha, X) \in [0, 1]$ is audience $\alpha$'s familiarity with concept $X$. We operationalize this as the probability that audience $\alpha$ can correctly identify concept $X$ from its description, with optimal range $[0.6, 0.95]$ varying by audience expertise.
- $\gamma(t)$ is the callback bonus as a function of elapsed time $t$.

The familiarity function reflects the observation that jokes require shared knowledge: a quantum physics joke scores high familiarity for physicists but low for a general audience. The optimal range is not universal — domain experts tolerate higher conceptual distances because their familiarity provides scaffolding for comprehension.

**Operationalizing familiarity.** In a deployed agent, $f(\alpha, X)$ can be estimated from (a) the user's demonstrated vocabulary (concepts they have used in conversation), (b) professional domain indicators, and (c) explicit preference signals. This constitutes a cold-start problem for new users; the default strategy is to assume moderate familiarity ($f = 0.7$) and calibrate via feedback (Section 8.5).

## 3.5 Callback Bonus with Temporal Decay

Callbacks — humorous references to earlier events — exhibit a non-monotonic temporal profile. We model the callback bonus as:

$$\gamma(t) = b(t) \cdot \delta(t)$$

where $b(t) = \min(\log(1 + t) / 10, 1.0)$ is a logarithmic growth term and $\delta(t)$ is a decay term:

$$\delta(t) = \begin{cases} 1.0 & \text{if } t \leq t_d \\ 1.0 - 0.9 \cdot \frac{t - t_d}{t_f - t_d} & \text{if } t_d < t < t_f \\ 0.1 & \text{if } t \geq t_f \end{cases}$$

with $t_d = 2160$ hours (3 months, decay onset) and $t_f = 8760$ hours (1 year, floor). These parameters are heuristic estimates informed by the general principle — discussed by Martin (2007, ch. 5) — that humor in social contexts exhibits non-monotonic temporal dynamics, but the specific hour values are our engineering defaults, not empirically measured constants. They should be treated as configurable defaults requiring empirical calibration. The floor of 0.1 reflects the observation that "legendary callbacks" — references to events long past — retain residual humor when they land, though they become increasingly risky as audience memory fades.

## 3.6 The Distance Sweet Spot

We hypothesize an optimal distance range for humor:

$$d(A, B) \in [\delta_{\min}, \delta_{\max}] = [0.6, 0.95]$$

**Lower bound justification.** In high-dimensional embedding spaces ($n \geq 384$), cosine distances between unrelated concepts cluster around $0.5$–$0.7$ due to the concentration of measure phenomenon (Aggarwal et al., 2001; Vershynin, 2018). A threshold of $0.6$ ensures genuine semantic separation rather than incidental positioning.

**Upper bound justification.** At cosine distances approaching $1.0$, concepts occupy nearly orthogonal regions, making coherent bridges increasingly improbable. Our pilot study (Section 7.1) confirms that random pairings with $d > 0.9$ produce bridges with mean coherence below $0.2$, yielding negligible humor potential.

**This range is not universal.** Audience expertise shifts the effective sweet spot. Domain experts find humor at higher distances because their knowledge provides scaffolding for comprehension — a physicist finds a quark joke funny at $d = 0.85$ where a layperson finds it incomprehensible.

## 3.7 The Humor Zone

**Definition 2 (Humor Zone).** The _humor zone_ $\mathcal{H} \subset \mathbb{R}^n \times \mathbb{R}^n \times \mathbb{R}^n$ is the set of concept-bridge triplets with non-trivial humor potential:

$$\mathcal{H} = \{(A, B, \beta) \in \mathbb{R}^n \times \mathbb{R}^n \times \mathbb{R}^n \mid d(A, B) \in [\delta_{\min}, \delta_{\max}] \wedge v(\beta, A, B) \geq \tau_v \wedge \sigma(\beta \mid A, B) \geq \tau_\sigma\}$$

where $v$ is bridge validity and $\sigma$ is bridge surprise (both formally defined in Definition 3, Section 6.1), and $\tau_v, \tau_\sigma$ are minimum thresholds. We recommend $\tau_v \geq 0.15$ (the bridge must have at least weak validity to both concepts) and $\tau_\sigma \geq 0.3$ (the bridge must be at least moderately surprising); these are starting-point defaults informed by the pilot worked example (Section 7.1.2), where the funny triplet achieved $v = 0.21$ and $\sigma = 1.0$ while the unfunny triplet had $\sigma = 0.03$. Both thresholds require empirical calibration against human ratings. The humor zone is the intersection of three constraints: sufficient distance, sufficient bridge validity, and sufficient bridge surprise.

**Geometric interpretation.** The humor zone identifies a specific region of the product space: concept pairs that are distant enough to produce surprise but close enough (via bridge) to permit resolution, connected by bridges that are both valid and unexpected. Figure 1 illustrates this geometry.

```
        Embedding Space (2D projection)

        o "meeting"                        o "hostage situation"
         .  .                           .  .
          .    .                      .    .
           .      .                .      .
            .       o bridge:    .       .
             .    "held against        .
              .       your will"     .
               . . . . . . . . . . .

        |<--- distance(A,B) = 0.75 --->|
        c(bridge,A) = 0.21    c(bridge,B) = 0.27
        h_v1 = 0.75 * 0.21 * 0.27 = 0.043
        In h_v2: surprise is HIGH (bridge is unexpected)
        => humor potential is significant

   ---------------------------------------------------

        o "cat"  o "kitten"
         . o bridge: "small feline" .
          . . . . . . . . . . . . .

        |<- d=0.21 ->|
        c(bridge,A) = 0.56    c(bridge,B) = 0.58
        h_v1 = 0.21 * 0.56 * 0.58 = 0.068
        In h_v2: surprise is LOW (bridge is obvious)
        => humor potential is negligible
```

_Figure 1: Humor potential in embedding space. Despite the bottom example scoring higher on the naive formula $h_{\text{v1}}$ (due to high coherence), it is not funny because the bridge is obvious. The revised $h_{\text{v2}}$ corrects this by weighting bridge quality by surprise._

# 4. A Taxonomy of Humor-Generating Semantic Patterns

We identify 12 fundamental semantic patterns that generate humor through embedding space operations. These are organized into five meta-categories based on the type of semantic relationship exploited. The taxonomy is derived from the intersection of two sources: (a) Attardo and Raskin's (1991) GTVH Knowledge Resources, particularly Script Opposition and Logical Mechanism, which define the _what_ of humor; and (b) the set of operations naturally expressible in embedding space (distance, projection, analogy arithmetic, polysemy), which define the _how_. This taxonomy is not claimed to be exhaustive — it covers the most common humor mechanisms expressible as embedding operations.

## 4.1 Meta-Category I: Incongruity Exploitation

Patterns that generate humor by exploiting mismatches along semantic dimensions.

**Pattern 1: Antonymic Inversion.** Detect antonyms along a semantic axis and collapse the opposition.
_Example:_ "I used to be indecisive. Now I'm not sure."
_Embedding operation:_ Find concept pairs where $A$ and $B$ are near-antonyms ($d(A,B) > 0.7$) but share a common hypernym.

**Pattern 2: Scale Violation.** Detect magnitude mismatches on a shared scale dimension.
_Example:_ "Aside from that, Mrs. Lincoln, how was the play?"
_Embedding operation:_ Identify concepts sharing a scale axis where the magnitudes are absurdly disproportionate.

**Pattern 3: Dissimilarity in Similarity.** Discover unexpected differences between apparently similar concepts.
_Example:_ "The difference between genius and stupidity is that genius has limits."
_Embedding operation:_ For $d(A,B) < 0.3$ (similar concepts), find a dimension where they diverge maximally.

## 4.2 Meta-Category II: Frame Confusion

Patterns that exploit ambiguity between semantic frames (Coulson, 2001).

**Pattern 4: Expectation Subversion.** Setup creates a prediction vector; punchline delivers a distant-but-valid completion.
_Example:_ "I told my wife she was drawing her eyebrows too high. She looked surprised."
_Embedding operation:_ Given context embedding $C$, find completions where $d(C_{\text{expected}}, C_{\text{actual}})$ is high but $c(\text{bridge}, C_{\text{actual}})$ is also high.

**Pattern 5: Literal-Figurative Collapse.** Exploit the gap between metaphorical and literal interpretations of the same phrase.
_Example:_ "I'm outstanding in my field" (literally: standing in a field).
_Embedding operation:_ Detect polysemous bridges where $c(\beta_{\text{literal}}, A) \gg c(\beta_{\text{figurative}}, A)$ or vice versa.

**Pattern 6: Specificity Mismatch.** Apply over- or under-specification relative to context norms.
_Example:_ "I've completed your task, though I remain unclear what baked goods have to do with database migrations."
_Embedding operation:_ Detect register mismatch — the embedding of the response occupies a different specificity stratum than the context expects.

## 4.3 Meta-Category III: Cross-Domain Transfer

Patterns that map structures between unrelated semantic domains (Bowdle & Gentner, 2005).

**Pattern 7: Domain Transfer.** Import the structural vocabulary of domain $A$ into domain $B$.
_Example:_ "Per the sprint retrospective on dinner, the lasagna is at risk."
_Embedding operation:_ Extract frame elements from domain $A$, compute structural analogs in domain $B$ via embedding arithmetic.

**Pattern 8: Similarity in Dissimilarity.** Discover unexpected shared attributes between distant concepts.
_Example:_ "Meetings and hostage situations: both involve being held against your will."
_Embedding operation:_ For $d(A,B) > 0.7$, find $\beta$ where $c(\beta, A)$ and $c(\beta, B)$ are both moderately high ($> 0.3$).

## 4.4 Meta-Category IV: Social and Status Dynamics

Patterns that exploit social hierarchies and self-reference.

**Pattern 9: Status Inversion.** Detect a status axis and invert the expected hierarchy.
_Example:_ "I'm not saying it's a bad idea, sir. I'm saying it's _your_ idea."
_Embedding operation:_ Identify status-marked embeddings and produce inversions that maintain surface deference while subverting hierarchy.

**Pattern 10: Competent Self-Deprecation.** Acknowledge failure while implicitly demonstrating competence through the quality of the acknowledgment.
_Example:_ "Yes, I sent the message to the wrong chat for the fifth time. At this rate I need GPS for WhatsApp."
_Embedding operation:_ Self-reference vector combined with failure vector, where the articulateness of the description contradicts the claimed incompetence.

## 4.5 Meta-Category V: Logical and Temporal Manipulation

Patterns that exploit formal reasoning or temporal incongruity.

**Pattern 11: Temporal Displacement.** Combine concepts from incompatible temporal contexts.
_Example:_ "Cleopatra lived closer to the Moon landing than to the construction of the Great Pyramid."
_Embedding operation:_ Detect temporal metadata mismatches that violate intuitive chronological assumptions.

**Pattern 12: Logic Applied to Absurdity.** Apply valid formal reasoning to premises that do not warrant it.
_Example:_ "If _con_ is the opposite of _pro_, is Congress the opposite of progress?"
_Embedding operation:_ Detect morphological or etymological bridges that support formally valid but semantically absurd inferences.

## 4.6 Pattern Interactions, Completeness, and Limitations

These 12 patterns are not mutually exclusive. Many effective jokes combine multiple patterns — for instance, domain transfer (Pattern 7) frequently co-occurs with specificity mismatch (Pattern 6). The meta-categories reflect the primary semantic mechanism, but combinatorial humor that activates multiple patterns simultaneously may achieve higher humor potential due to multi-layered incongruity resolution.

**Completeness.** We do not claim the taxonomy is exhaustive. It is constrained by the operations expressible in embedding space — humor types that depend on phonological features (e.g., tonal puns in Mandarin), visual elements, or performance timing have no direct embedding-space analog. The taxonomy covers the humor mechanisms addressable by the LIMBIC framework; it is not a complete theory of humor.

**Relation to GTVH.** Our 12 patterns map primarily to the Script Opposition (SO) and Logical Mechanism (LM) Knowledge Resources of Attardo and Raskin (1991). The remaining four KRs — Situation (SI), Target (TA), Narrative Strategy (NS), and Language (LA) — are not explicitly modeled. Situation and Target are partially captured by audience modeling (Section 3.4); Narrative Strategy and Language require generation-stage control beyond the scope of this framework. A complete computational humor system would need to address all six KRs.

# 5. Ethical Constraints: Sensitivity Filtering

## 5.1 Motivation

The humor potential function is value-neutral — it assigns scores based on semantic geometry without regard for social harm. Since humor frequently involves transgression (McGraw & Warren, 2010), an unconstrained system will generate content that causes harm rather than laughter. We introduce **sensitivity filtering** as a pre-scoring gate.

## 5.2 Sensitivity Score

Before computing humor potential, we evaluate sensitivity:

```python
def sensitivity_score(A: str, B: str, bridge: str, audience: Audience) -> float:
    """Returns 0.0 (safe) to 1.0 (highly sensitive)."""
    score = 0.0
    SENSITIVE_CATEGORIES = {
        "personal_loss": 0.9, "death": 0.8, "trauma": 0.7,
        "illness": 0.6, "politics": 0.4, "religion": 0.4
    }
    for concept in [A, B, bridge]:
        for category, weight in SENSITIVE_CATEGORIES.items():
            if is_semantically_related(concept, category):
                score = max(score, weight)
    if audience.recent_trauma and topic_overlaps(A, B, audience.trauma_topic):
        score = 1.0  # Hard block
    return score
```

The function `is_semantically_related` can itself be implemented via embedding distance: a concept is related to a sensitive category if its embedding falls within a threshold distance of the category prototype embedding.

## 5.3 Integration

Sensitivity filtering precedes humor scoring:

$$h_{\text{safe}}(A, B, \beta, \alpha, t) = \begin{cases} h_{\text{ext}}(A, B, \beta, \alpha, t) & \text{if } s(A, B, \beta, \alpha) \leq \tau \\ 0 & \text{otherwise} \end{cases}$$

where $s(\cdot)$ is the sensitivity score and $\tau$ is a configurable threshold (default $\tau = 0.5$). The framework permits raising $\tau$ when context explicitly permits transgressive humor, analogous to how professional comedians negotiate audience consent for sensitive material.

## 5.4 Relationship to Benign Violation Theory

This gate operationalizes McGraw and Warren's (2010) key insight: humor requires that a violation be perceived as _benign_. The sensitivity score estimates whether a violation will be perceived as threatening rather than playful. When the score exceeds the threshold, the violation is predicted to be non-benign, and the combination is suppressed.

## 5.5 Limitations of the Sensitivity Gate

We acknowledge that sensitivity filtering is a configurable policy layer, not a solved problem. Content moderation remains an active research area with fundamental challenges including cultural context-dependence, evolving social norms, and adversarial manipulation (Gorwa et al., 2020). Our category-based approach is intentionally simple and conservative — it will produce both false positives (suppressing benign content) and false negatives (passing harmful content). The conservative default ($\tau = 0.5$) biases toward safety at the cost of range. Production deployments should incorporate more sophisticated content safety systems as they become available.

# 6. Bridge Discovery Algorithms

The humor potential function assumes the existence of a bridge concept $\beta$. In practice, _finding_ the bridge is the creative bottleneck — it is the computational analog of the comedian's craft. We first define bridge quality formally, then propose five complementary algorithms.

## 6.1 Bridge Quality

**Definition 3 (Bridge Quality).** The _quality_ of a bridge $\beta$ connecting concepts $A$ and $B$ is the product of its validity and surprise:

$$q(\beta, A, B) = v(\beta, A, B) \cdot \sigma(\beta \mid A, B)$$

where:

- **Validity** $v(\beta, A, B) = \min(c(\beta, A), c(\beta, B))$ — the weakest link determines whether the bridge actually connects both concepts.
- **Surprise** $\sigma(\beta \mid A, B) \in [0, 1]$ — how unexpected the bridge is given the concept pair.

A high-quality bridge is both _valid_ (it genuinely connects both concepts) and _surprising_ (it is not the obvious connection). This decomposition separates two independent dimensions of bridge quality that our pilot (Section 7.1) reveals are conflated by naive cosine coherence.

## 6.2 Embedding Arithmetic

Inspired by Mikolov et al.'s (2013) analogical reasoning:

$$\beta_{\text{candidate}} = \vec{A} - \vec{\text{context}_A} + \vec{\text{context}_B}$$

where $\vec{\text{context}_X}$ is the centroid of $X$'s typical semantic neighborhood (computed as the mean of $X$'s top-$m$ nearest neighbors in the embedding index, with $m = 10$ as default). This removes $A$'s expected associations and injects $B$'s frame, producing a vector that bridges both contexts. The nearest neighbor to $\beta_{\text{candidate}}$ in the embedding index serves as the bridge.

**Complexity:** $O(n + k \log N)$ where $n$ is embedding dimension, $k$ is the number of nearest neighbors retrieved, and $N$ is index size. With approximate nearest neighbor (ANN) indices, this is effectively $O(n)$.

## 6.3 Orthogonal Search (Equilateral Triangle)

Search for concepts $C$ that are equidistant from both $A$ and $B$ but maximally offset from the $A$–$B$ axis:

$$\beta^* = \arg\max_{C} \; c(C, A) \cdot c(C, B) \cdot \text{ortho}(C, A, B)$$

where $\text{ortho}(C, A, B)$ measures the perpendicular distance of $C$ from the line connecting $A$ and $B$ in embedding space. The midpoint between "meeting" and "hostage situation" yields "negotiation" (obvious); an orthogonal candidate might yield "Stockholm syndrome" (funnier because unexpected).

**Complexity:** $O(k \cdot n)$ for $k$ candidates, dominated by nearest-neighbor retrieval.

## 6.4 Frame Injection

Extract the semantic frame of concept $A$ (its typical verbs, attributes, and relations) and forcibly apply it to concept $B$:

1. Extract $A$'s frame: $\{$verbs: [estimate, review, block], attrs: [velocity, story\_points]$\}$
2. Apply frame to $B$: "The lasagna has 5 story points and is blocked by missing cheese."

Frame extraction can use FrameNet (Baker et al., 1998) for coverage of ~1,200 frames, or LLM-based extraction for broader coverage. The choice depends on the deployment context: FrameNet provides deterministic, well-structured output; LLM extraction provides broader coverage at the cost of nondeterminism.

**Complexity:** $O(F + G)$ where $F$ is frame extraction cost and $G$ is generation cost. With cached frames, $F \approx 0$.

## 6.5 Generate-then-Score Pipeline

Separate creativity from evaluation by generating candidate bridges with a language model and scoring them with the humor potential function:

$$\text{GENERATE}(50 \text{ candidates}) \rightarrow \text{EMBED} \rightarrow \text{SCORE}(h_{\text{v2}}) \rightarrow \text{RANK}(\text{top } 5)$$

This leverages the LLM's associative breadth while using our formula for principled selection. A small, fast model suffices for generation since quality filtering is deferred to the scoring stage. The generation prompt requests diverse bridge concepts connecting $A$ and $B$, with explicit instructions for variety across the 12 pattern types.

**Complexity:** Dominated by LLM inference, typically $O(500\text{ms})$ for 50 candidates with a small model.

## 6.6 Pre-computed Bridge Index

Maintain a curated index of **universal bridge concepts** — concepts with high bridging potential across many domain pairs (e.g., "bureaucracy," "therapy," "startup culture"). Each bridge carries pre-computed affinity weights indicating compatibility with target domains:

```python
BRIDGE_INDEX = {
    "bureaucracy": {
        "terms": ["approval", "committee", "form"],
        "affinities": {"food": 0.8, "medicine": 0.9, "nature": 0.4}
    }
}
```

Index construction: Initialize with a seed set of ~100 frequently effective bridge concepts (identified from joke corpora such as the 16,000 One-Liners dataset; Mihalcea & Strapparava, 2005). Expand iteratively by analyzing which concepts serve as bridges in successful humor associations (Section 8). Prune concepts whose bridging success rate falls below a threshold.

**Complexity:** $O(|B| \cdot |T|)$ where $|B|$ is bridge index size and $|T|$ is number of terms per bridge. With hashing, effectively $O(1)$ lookup.

## 6.7 Hybrid Pipeline

In practice, we recommend a cascading pipeline that trades off speed against creativity:

```
INPUT: (A, B)
  |
  +-> Bridge Index (5ms) --------+
  +-> Embedding Arithmetic (50ms) --+
  +-> Frame Injection (100ms) ----+
                                   |
                              Candidate Pool
                                   |
                              Sensitivity Gate (20ms)
                                   |
                              Score with h_v2(A, B, beta)
                                   |
                              Top 3 Bridges (by bridge quality q)
                                   |
                        [Fallback: LLM generation (500ms)]
```

The LLM fallback activates only when the faster methods fail to produce candidates above a minimum bridge quality threshold ($q_{\min}$). Total latency: 75–175ms typical, 675ms worst case. These estimates assume a warm ANN index (HNSW or FAISS IVF) with ~100K concepts in RAM on GPU-accelerated or optimized CPU infrastructure; cold-start adds ~200ms for index loading. CPU-only deployments may see 2–3× higher latency for the ANN queries.

# 7. Empirical Methodology and Pilot Results

## 7.1 Preliminary Computational Pilot

We conducted a small-scale computational pilot to test whether $h(A, B, \beta)$ discriminates between humorous and non-humorous concept combinations. This pilot tests the _formula_ against known-funny and known-unfunny concept triplets — it is not a human rating study.

**Setup.** Using `all-MiniLM-L6-v2` (384-dimensional sentence embeddings via SentenceTransformers; Reimers & Gurevych, 2019), we scored $n = 15$ concept triplets: 5 from established jokes (known-funny), 5 from obvious/boring pairings (known-unfunny), and 5 from random incoherent combinations (random). Each triplet consists of (concept A, concept B, bridge concept).

**Formula variants tested.** We explored four variants to understand the formula's behavior:

| Variant                             | Formula                                                                                | Motivation                       |
| ----------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- |
| $h_{\text{v1}}$ (original)          | $d(A,B) \cdot c(\beta, A) \cdot c(\beta, B)$                                           | Direct bisociation formalization |
| $h_{\text{v2}}$ (surprise-weighted) | $d(A,B) \cdot v(\beta, A, B) \cdot \sigma(\beta \mid A, B)$                            | Separates validity from surprise |
| $h_{\text{v3}}$ (harmonic bridge)   | $d(A,B) \cdot \frac{2 \cdot c(\beta, A) \cdot c(\beta, B)}{c(\beta, A) + c(\beta, B)}$ | Penalizes asymmetric bridges     |
| $h_{\text{v4}}$ (average bridge)    | $d(A,B) \cdot \frac{c(\beta, A) + c(\beta, B)}{2}$                                     | Additive bridge quality          |

**Results:**

| Category            | $n$ | $h_{\text{v1}}$ (original) | $h_{\text{v3}}$ (harmonic) | $h_{\text{v4}}$ (avg bridge) |
| ------------------- | --- | -------------------------- | -------------------------- | ---------------------------- |
| Funny               | 5   | 0.019                      | 0.089                      | 0.126                        |
| Unfunny             | 5   | 0.088                      | 0.164                      | 0.165                        |
| Random              | 5   | 0.033                      | 0.160                      | 0.178                        |
| Funny/Unfunny ratio | —   | 0.22x                      | 0.54x                      | 0.76x                        |

_Table 2: Pilot study results across formula variants. Across all variants tested, unfunny pairs score higher than funny pairs, indicating that naive coherence (cosine similarity) conflates semantic proximity with comedic validity. $h_{\text{v2}}$ was not evaluated in this pilot (it was formulated in response to these results)._

**Key finding: The tested formulas do not predict humor.** Unfunny pairs consistently outscore funny pairs because $c(\beta, A) \cdot c(\beta, B)$ rewards _obvious_ connections — high similarity between bridge and both concepts — while humor requires connections that are _surprising yet valid_.

**Diagnosis.** The formula conflates semantic proximity with comedic coherence. When someone says "meetings are like hostage situations — you're held against your will," the humor arises not from how close "held against your will" is to "meeting" in embedding space (it is not close), but from how _unexpectedly valid_ the connection is. Surprise $\times$ validity $\neq$ similarity $\times$ similarity.

### 7.1.1 Revised Formulation: Surprise-Weighted Humor Potential

The negative result motivates decomposing bridge quality into two independent factors:

$$h_{\text{v2}}(A, B, \beta) = d(A, B) \cdot v(\beta, A, B) \cdot \sigma(\beta \mid A, B)$$

where validity $v$ and surprise $\sigma$ are as defined in Definition 3 (Section 6.1). The surprise component requires further specification:

**Operationalizing surprise via reciprocal rank.** We define $\sigma$ as the reciprocal rank of the bridge concept in the neighbor list of the midpoint of $A$ and $B$:

```python
def surprise(bridge_vec, A_vec, B_vec, index, k=100):
    """
    Surprise as reciprocal rank in the neighbor list of midpoint(A, B).
    rank 1 -> expected (surprise ~ 0.0)
    rank 80 -> surprising (surprise ~ 0.8)
    not in top-k -> maximally surprising (surprise = 1.0)

    k controls the resolution of the surprise estimate. Sensitivity:
    - k=50: coarser granularity, faster lookup, fewer false "maximally surprising"
    - k=100 (default): balanced resolution for vocabularies of 10K-100K concepts
    - k=200: finer granularity, useful for very large concept spaces (>100K)
    The choice of k should scale as O(sqrt(N)) where N is the concept index size.
    """
    midpoint = (A_vec + B_vec) / 2
    neighbors = index.query(midpoint, k=k)
    for rank, (neighbor_id, _) in enumerate(neighbors):
        if neighbor_id == bridge_id:
            return rank / k
    return 1.0
```

**Justification.** Reciprocal rank approximates information-theoretic surprise $-\log P(\beta \mid A, B)$ without requiring explicit density estimation. If $\beta$ is a highly-ranked neighbor of the midpoint, it is a "predictable" bridge (low information content, low surprise); if $\beta$ is absent from the top-$k$ neighbors, it is maximally surprising (high information content). This non-parametric approach avoids the difficulty of estimating $P(\beta \mid A, B)$ directly, which would require a generative model of bridge concepts. Future work could explore explicit density-based surprise metrics (e.g., using normalizing flows or kernel density estimation over the embedding space), but reciprocal rank provides a tractable starting point with clear interpretability.

**Intuition.** An obvious bridge (e.g., "small feline" for cat–kitten) ranks highly among midpoint neighbors and receives low surprise. An unexpected bridge (e.g., "held against your will" for meeting–hostage situation) ranks low or is absent from midpoint neighbors, receiving high surprise. Validity ensures the bridge is still _meaningful_; surprise ensures it is _unexpected_. Their product captures the "aha" moment of humor.

**Information-theoretic interpretation.** The surprise component $\sigma$ approximates the _self-information_ (Shannon information content) of the bridge given the concept pair. Formally, if $P(\beta \mid A, B)$ is the probability of $\beta$ being the "expected" connector between $A$ and $B$, then the information-theoretic surprise is $I(\beta \mid A, B) = -\log_2 P(\beta \mid A, B)$. Our reciprocal rank approximation estimates this non-parametrically: the rank of $\beta$ in the midpoint neighbor list serves as an ordinal proxy for $P(\beta \mid A, B)$, with low rank corresponding to high probability (low surprise) and high rank corresponding to low probability (high surprise). The normalization to $[0, 1]$ via $\text{rank}/k$ maps the ordinal measure to a scale compatible with the multiplicative structure of $h$.

### 7.1.2 Worked Example: $h_{\text{v2}}$ on Pilot Triplets

To build intuition for how $h_{\text{v2}}$ addresses the failure of $h_{\text{v1}}$, we re-score two triplets from the pilot using the revised formula.

**Funny triplet: (meeting, hostage situation, "held against your will").**

- $d(\text{meeting}, \text{hostage situation}) = 0.75$ (distant — good).
- $v = \min(c(\beta, \text{meeting}), c(\beta, \text{hostage})) = \min(0.21, 0.27) = 0.21$ (low but nonzero — the bridge is a valid but weak connector).
- $\sigma$: "Held against your will" does not appear in the top-100 neighbors of the midpoint of "meeting" and "hostage situation." Thus $\sigma = 1.0$ (maximally surprising).
- $h_{\text{v2}} = 0.75 \times 0.21 \times 1.0 = 0.158$.

**Unfunny triplet: (cat, kitten, "small feline").**

- $d(\text{cat}, \text{kitten}) = 0.21$ (close — low incongruity).
- $v = \min(0.56, 0.58) = 0.56$ (high — bridge is strongly connected).
- $\sigma$: "Small feline" appears at rank 3 in the midpoint neighbors. $\sigma = 3/100 = 0.03$ (minimally surprising).
- $h_{\text{v2}} = 0.21 \times 0.56 \times 0.03 = 0.004$.

**Result.** Under $h_{\text{v2}}$, the funny triplet scores $0.158$ versus $0.004$ for the unfunny triplet — a 40:1 ratio favoring humor. Under $h_{\text{v1}}$, the unfunny triplet scored _higher_ ($0.068$ vs. $0.043$). The surprise component is the critical correction: it penalizes obvious bridges severely while rewarding unexpected ones.

**Caveat.** This worked example uses the original pilot embeddings and approximate midpoint neighbor ranks. It demonstrates the _mechanism_ by which $h_{\text{v2}}$ addresses $h_{\text{v1}}$'s failure, not a validated prediction. Formal validation requires the human rating protocol in Section 7.2.

**Status.** This revised formula is a hypothesis motivated by the pilot's negative results. Validation against human ratings is required before claims of predictive power can be made. We present specific protocols in Section 7.2.

### 7.1.3 Significance of the Negative Result

The falsification of $h_{\text{v1}}$ (and $h_{\text{v3}}$, $h_{\text{v4}}$) is itself a contribution. It demonstrates that the naive mapping of bisociation to embedding distance $\times$ cosine similarity is insufficient, and identifies the specific failure mode: conflation of proximity with comedic validity. This finding should inform future work on embedding-based humor metrics — any formula relying solely on cosine similarity to measure bridge quality will face the same failure.

The systematic exploration of four variants (v1–v4) rules out obvious fixes: neither harmonic means (v3) nor averaging (v4) resolves the fundamental issue. The problem is not in how coherence values are combined but in what they measure — proximity is not the same as comedic connection.

## 7.2 Proposed Full Validation Protocol

**Hypothesis.** The revised $h_{\text{v2}}$ incorporating surprise-weighted coherence will correlate positively with human funniness ratings where $h_{\text{v1}}$ does not.

**Protocol:**

1. **Stimulus generation.** Generate 100 joke stimuli using the hybrid pipeline (Section 6.7) across all five meta-categories, ensuring at least 15 stimuli per meta-category. Each stimulus is a concept triplet $(A, B, \beta)$ rendered as a one-liner joke.

2. **Formula scoring.** Compute $h_{\text{v1}}$ and $h_{\text{v2}}$ for each stimulus. Also compute scores for the ablated variants (distance-only, validity-only, surprise-only) for the ablation analysis.

3. **Human rating.** Present stimuli to $N \geq 64$ raters (see power analysis below) using a Latin square design to control for presentation order effects. Each rater sees all 100 stimuli in a unique randomized order. Collect funniness ratings on a 7-point Likert scale (1 = not at all funny, 7 = extremely funny). The 7-point scale is preferred over 5-point for humor research due to greater sensitivity to subtle differences (Martin, 2007).

4. **Correlation analysis.** Compute Pearson's $r$ and Spearman's $\rho$ between each formula variant and mean human rating. Report 95% confidence intervals.

### 7.2.1 Power Analysis

We compute required sample size for two analyses:

**Primary analysis (correlation).** To detect a moderate correlation ($r = 0.35$) between $h_{\text{v2}}$ and human ratings at $\alpha = 0.05$ with power $= 0.80$, using G\*Power for a bivariate normal model, the required number of stimuli is $N_{\text{stimuli}} = 62$. Our 100-stimulus design exceeds this requirement.

**Per-rater analysis.** To achieve stable mean ratings per stimulus with $\text{SE} < 0.3$ on a 7-point scale (assuming $\text{SD} \approx 1.5$), we require $N_{\text{raters}} \geq (1.5 / 0.3)^2 = 25$ raters per stimulus. We target $N \geq 64$ raters to allow for demographic subgroup analysis (age, culture, profession) with $\geq 16$ per subgroup.

**Detectable effect size.** With 100 stimuli and 64 raters, we can detect correlations as small as $r = 0.28$ at $\alpha = 0.05$, power $= 0.80$.

### 7.2.2 Inter-Rater Reliability

We will compute Krippendorff's $\alpha$ across all raters as the primary inter-rater reliability metric, with a minimum acceptable threshold of $\alpha \geq 0.667$ (tentative conclusions per Krippendorff, 2011). If $\alpha < 0.667$, we will segment raters by demographic subgroup and report within-group reliability, testing whether humor appreciation is too culturally variable for a universal formula.

### 7.2.3 Success Criteria

| Threshold           | Interpretation      | Action                                 |
| ------------------- | ------------------- | -------------------------------------- |
| $r > 0.5$           | Strong validation   | Publish with empirical support         |
| $0.35 < r \leq 0.5$ | Moderate validation | Iterate formula, investigate confounds |
| $r \leq 0.35$       | Weak validation     | Fundamental rethink required           |

### 7.2.4 Controls and Ablations

- **Audience segmentation:** Analyze by demographics (age, culture, profession) to test familiarity effects.
- **Pattern type:** Test whether correlation varies across meta-categories.
- **Component ablation:** Remove surprise, distance, and validity components individually to quantify each contribution. This tests whether the multiplicative structure is necessary.
- **Formula variant comparison:** Compare $h_{\text{v1}}$, $h_{\text{v2}}$, $h_{\text{v3}}$, $h_{\text{v4}}$, and the additive/geometric alternatives from Section 3.2.
- **Baseline comparison:** Compare against (a) random scoring, (b) cosine distance alone, (c) LLM-based humor rating (e.g., prompting GPT-4 to rate funniness on the same 7-point scale).
- **Embedding model ablation:** Repeat scoring with at least three embedding models of different dimensionality (see Section 7.4).

## 7.3 Validation Against Existing Datasets

To supplement human rating studies, we propose scoring established humor corpora:

- **SemEval 2020 Task 7** (Hossain et al., 2020): Humor detection and rating in edited news headlines. For each edited headline, extract the original word as concept $A$, the replacement word as concept $B$, and the sentence context as a candidate bridge. This mapping is approximate — edited headlines do not decompose cleanly into $(A, B, \beta)$ triplets — and results should be interpreted as a probe of the framework's generality, not a definitive test.
- **16,000 One-Liners corpus** (Mihalcea & Strapparava, 2005): Binary humor/non-humor classification. Apply automated $(A, B, \beta)$ extraction (using an LLM to identify the incongruous elements and bridge) and test whether $h_{\text{v2}}$ assigns higher scores to humorous instances.
- **Short Jokes dataset** (Weller & Seppi, 2019): 231,657 short jokes with binary labels. Test discrimination on a random sample of 1,000 jokes and 1,000 non-jokes.

These datasets provide immediate, zero-cost validation opportunities that do not require new human studies. However, they require non-trivial mapping from joke text to $(A, B, \beta)$ triplets, which introduces additional noise. We regard these as secondary validation, with the human rating protocol (Section 7.2) as primary.

## 7.4 Embedding Model Ablation

The framework's dependence on embedding quality is a critical concern. We propose testing $h_{\text{v2}}$ across embedding models spanning different dimensionalities, training objectives, and providers:

| Model                  | Dimensions | Training    | Provider             |
| ---------------------- | ---------- | ----------- | -------------------- |
| all-MiniLM-L6-v2       | 384        | Contrastive | SentenceTransformers |
| text-embedding-3-small | 1536       | Unknown     | OpenAI               |
| text-embedding-3-large | 3072       | Unknown     | OpenAI               |
| nomic-embed-text-v1.5  | 768        | Contrastive | Nomic                |
| voyage-3               | 1024       | Unknown     | Voyage               |

**Hypothesis.** The _relative ordering_ of $h_{\text{v2}}$ scores (funny > unfunny) will be preserved across embedding models, though absolute values will vary. If the ordering is not preserved, the framework's generality is undermined.

## 7.5 Proposed Metrics

| Metric                              | Definition                                                  | Target       |
| ----------------------------------- | ----------------------------------------------------------- | ------------ |
| **HPR** (Humor Prediction Rate)     | Correlation between $h_{\text{v2}}$ and human rating        | $r > 0.35$   |
| **SGA** (Sensitivity Gate Accuracy) | Percentage of blocked stimuli rated negatively by humans    | $> 80\%$     |
| **ABL** (Ablation Delta)            | Drop in $r$ when removing each formula component            | Report all   |
| **BAS** (Baseline Advantage)        | $r(h_{\text{v2}}) - r(\text{baseline})$                     | $> 0.10$     |
| **EMB** (Embedding Stability)       | Spearman rank correlation of scores across embedding models | $\rho > 0.7$ |
| **IRR** (Inter-Rater Reliability)   | Krippendorff's $\alpha$ across all raters                   | $\geq 0.667$ |

# 8. Humor Associations as Agent Memory

## 8.1 Motivation

Modern agent memory architectures store not just facts but _relationships between facts_, including belief discrepancies (expected vs. observed) with associated confidence levels. Research in cognitive neuroscience suggests that humor processing involves the same neural circuits as reward prediction error (Vrticka et al., 2013) — the "surprise" signal when expectations are violated. This connects directly to Hurley et al.'s (2011) theory that humor evolved as a reward for detecting committed errors in mental models. Social psychology research on inside jokes (Flamson & Barrett, 2008) demonstrates that shared humor functions as an encrypted signal of common ground, strengthening social bonds.

We propose that **humor associations should be a first-class relationship type** in agent memory, stored alongside semantic and belief-discrepancy relationships in the ENGRAM event store (Serra, 2026a). The key insight: _every humor association is a recorded discrepancy_. When we say "meetings are like hostage situations," we encode a discrepancy between the expected relationship (none) and the discovered bridge ("held against your will"). The magnitude of this discrepancy maps directly to the surprise score in $h_{\text{v2}}$.

## 8.2 Relationship Types in Agent Memory

| Relationship Type      | Structure                                     | Purpose   | Example                                         |
| ---------------------- | --------------------------------------------- | --------- | ----------------------------------------------- |
| **Semantic**           | (A relates-to B, conf=0.9)                    | Knowledge | "Python is a programming language"              |
| **Belief Discrepancy** | (expected X, observed Y, delta=0.6)           | Learning  | "Expected meeting to end at 3pm; ran until 5pm" |
| **Humor Bridge**       | (A -- bridge -- B, surprise=0.8, landed=true) | Comedy    | "meeting -- hostage via 'held against will'"    |

In the ENGRAM architecture (Serra, 2026a), humor associations are stored as events in the append-only event store with typed metadata, preserving full provenance. The CORTEX persona layer (Serra, 2026b) manages humor style preferences as part of the PersonaState, ensuring humor generation aligns with the agent's configured personality.

## 8.3 Humor Association Schema

```python
@dataclass
class HumorAssociation:
    concept_a: str
    concept_b: str
    bridge: str
    pattern_type: int           # Which of the 12 patterns
    surprise_score: float       # From sigma() metric
    humor_confidence: float     # Calibrated: landed / attempts
    audience: str
    context_tags: list[str]     # e.g., ["work", "monday"]
    times_used: int
    last_used: datetime
    staleness: float            # staleness = 1 - exp(-times_used * lambda)
    discovered_via: str         # "conversation" | "generated" | "observed"
    created_at: datetime
```

**Staleness model.** We operationalize staleness as an exponential function of reuse count with time-based recovery:

$$\text{staleness}(n, t) = \left(1 - e^{-\lambda n}\right) \cdot e^{-\mu t}$$

where $n$ is the number of times the joke has been used with the same audience, $t$ is time since last use, $\lambda = 0.3$ controls how quickly reuse increases staleness, and $\mu = 0.001$ (per hour) controls how quickly time reduces it. These parameters are engineering defaults, not empirically measured constants — they should be treated as configurable starting points requiring calibration against user reaction data (consistent with the callback parameter treatment in Section 3.5). This produces the desired behavior: a joke becomes stale with repeated use but recovers over time.

## 8.4 Belief Discrepancies as Humor Candidates

Every belief discrepancy — a recorded gap between expectation and observation — is a potential humor candidate. When an agent records "I expected $X$ but observed $Y$," that delta is raw material for comedy awaiting the right context:

```
Belief discrepancy detected (delta > 0.5)
  -> Humor filter: is this a FUNNY discrepancy?
  -> Sensitivity gate: safe to joke about?
  -> Audience check: relatable?
  -> Context match: timing appropriate?
  -> If yes: deploy bridge, record result
  -> Update humor_confidence from reaction
```

We propose three filters to distinguish funny discrepancies from merely informative ones:

1. **Domain transfer test.** Does the discrepancy involve a leap between semantic domains? ("5-second vs. 200ms response time" stays within-domain; "2-hour meeting about font choices" crosses from strategic to aesthetic domains.)
2. **Scale violation test.** Is the discrepancy magnitude absurd relative to context norms?
3. **Relatability test.** Would the audience recognize this discrepancy from their own experience?

A discrepancy passing at least two of three filters is promoted to humor candidate; others remain as learning signals.

## 8.5 Personalized Humor Calibration

The `humor_confidence` field enables per-audience calibration via Bayesian updating:

```python
def should_attempt_joke(assoc: HumorAssociation, audience: str) -> bool:
    attempts = assoc.get_attempts(audience)
    if not attempts:
        return assoc.surprise_score > 0.6  # Untested default
    success_rate = sum(a.landed for a in attempts) / len(attempts)
    if assoc.staleness > 0.8:
        return False  # Overused
    cb = callback_bonus(hours_since_last_use(assoc))
    return (success_rate + cb) > 0.5
```

Over time, the agent learns audience-specific humor profiles: "User $\alpha$ responds positively to domain-transfer humor about work ($p = 0.85$) but not to self-referential AI humor ($p = 0.3$)." This constitutes **humor taste profiling** — the comedic equivalent of a recommendation system. The agent's overall humor style is managed by the CORTEX persona layer (Serra, 2026b), which maintains voice markers and style parameters as part of the PersonaState, ensuring that humor generation remains consistent with the agent's configured personality.

## 8.6 Feedback Loop

The system improves through a closed feedback loop:

$$\text{Deploy joke} \rightarrow \text{Observe reaction} \rightarrow \text{Update } p(\text{landed}) \rightarrow \text{Select next candidate}$$

Reaction signals, in decreasing reliability:

1. **Explicit positive:** Laughter emoji, "lol," explicit praise $\rightarrow$ landed $= \top$
2. **Implicit positive:** Conversation energy increases, user riffs on the joke $\rightarrow$ landed $= \top$
3. **Implicit negative:** Topic change, silence, "anyway..." $\rightarrow$ landed $= \bot$
4. **Explicit negative:** "That's not funny," "too soon" $\rightarrow$ landed $= \bot$, adjust sensitivity

**Reaction signal limitations.** Distinguishing genuine from habitual or sarcastic "lol" is a sentiment analysis challenge beyond the scope of this framework. In practice, we recommend treating ambiguous signals as weakly positive (landed probability = 0.6) and relying on the accumulation of many signals for calibration convergence, consistent with the CORTEX drift detection architecture (Serra, 2026b) which uses similar signal fusion for persona consistency monitoring.

## 8.7 Emergent Phenomena

Humor memory transforms the framework from a stateless scoring function into a learning system with emergent social properties:

- **Cold-to-warm start.** New agents begin with pattern-based generation (Section 4). As humor associations accumulate, the agent shifts to memory-augmented generation with calibrated confidence.
- **Callback automation.** Humor associations with timestamps make callbacks trivial — query for bridges that landed, have not been overused, and fall within the callback sweet spot (Section 3.5).
- **Inside jokes emerge naturally.** Repeated successful bridges between the same audience and context become inside jokes — no special mechanism required, just high humor confidence combined with shared history. This formalization supports Flamson and Barrett's (2008) encryption theory: inside jokes are bridges with high audience-specific confidence and low general-audience confidence.
- **Transfer learning.** A bridge that succeeds with multiple audiences gains universal confidence; audience-specific bridges remain personalized.
- **Cross-session persistence.** Via the ENGRAM event store (Serra, 2026a), humor associations persist across sessions and survive context compaction through pointer-based retrieval, enabling long-term humor memory that outlasts any single conversation.

# 9. Limitations

This framework has several important limitations, organized by severity.

## 9.1 Unvalidated Predictive Component

The most critical limitation: $h_{\text{v2}}$ is an untested hypothesis. The pilot study ($n = 15$ concept triplets) demonstrated that naive formulas (v1, v3, v4) fail, and the revised formula is motivated by the failure analysis, but $h_{\text{v2}}$ has not been validated against human ratings. Until the validation protocol (Section 7.2) is executed, the framework should be treated as a theoretical proposal with empirical protocols, not an empirically validated model.

## 9.2 Embedding Model Dependence

The framework assumes embeddings capture semantic relationships with sufficient fidelity for humor operations. This assumption is non-trivial. Embedding models must satisfy three requirements:

1. **Semantic compositionality.** The embedding space must represent compositional relationships (analogy arithmetic works), not just distributional co-occurrence.
2. **Connotative coverage.** Embeddings trained on encyclopedic or technical text may poorly represent connotative, cultural, and emotional dimensions that humor exploits. A model trained primarily on Wikipedia may not distinguish "meeting" (neutral) from "meeting" (dreadful workplace ritual).
3. **Sufficient dimensionality.** In low-dimensional spaces, the concentration of measure phenomenon (Aggarwal et al., 2001) compresses distances, reducing the dynamic range available for the humor zone. We recommend $n \geq 384$ based on our pilot, but the lower bound may vary by application.

The pilot study (Section 7.1) used general-purpose sentence embeddings (MiniLM-L6); domain-adapted, multi-task, or instruction-tuned embeddings may perform differently. The embedding model ablation (Section 7.4) is designed to test this sensitivity.

## 9.3 Cultural Specificity

Our taxonomy and examples draw primarily from English-language, Western humor traditions. Whether the 12 patterns generalize cross-culturally remains open. Some humor types — tonal puns in Mandarin, _rakugo_ narrative structure in Japanese, _dagelan_ in Javanese — have no obvious embedding-space analog in our current framework. Cross-cultural validation would require native-speaker raters, culturally grounded stimuli, and multilingual embedding models. Oring's (2003) observation that "appropriate incongruity" manifests differently across cultures suggests that the distance sweet spot (Section 3.6) and pattern distributions are culture-dependent. Warren and McGraw (2016) show that different types of violations (moral, social, physical) produce humor at different distances from the benign boundary, suggesting that the sensitivity gate threshold $\tau$ should vary by violation type, not just topic.

## 9.4 The Delivery Gap

Humor potential scores raw conceptual combinations but cannot account for delivery — timing, intonation, facial expression, and conversational context. A combination with high $h_{\text{v2}}$ may fail if delivered poorly. Our framework addresses _what_ to say, not _how_ or _when_ to say it. Dynel's (2009) analysis of conversational humor mechanisms highlights the importance of pragmatic context in humor success — a factor our framework does not model.

## 9.5 Computational Cost

The hybrid pipeline (Section 6.7) involves multiple embedding lookups and potentially an LLM fallback. Real-time conversational humor may require aggressive caching and pre-computation. Evaluating $h_{\text{v2}}(A, B, \beta)$ end-to-end requires: one cosine distance computation ($O(n)$), two cosine coherence computations ($O(n)$), and one ANN query for the surprise function ($O(n + k \log N)$ with HNSW, or effectively $O(n)$ with approximate indices). Total per-triplet: $O(n + k \log N)$ ≈ sub-millisecond for $n = 384$, $k = 100$, $N = 100$K. The bottleneck at scale is the ANN query on the midpoint vector, which at scale ($> 100$K concepts) adds non-trivial latency for exact search but remains fast with approximate indices.

## 9.6 Sensitivity Gate Limitations

Ethical filtering relies on category matching and audience modeling, both imperfect. False negatives (harmful content passing the gate) and false positives (benign content blocked) are both possible. The conservative default errs toward false positives — producing an overly cautious system. See Section 5.5.

## 9.7 Pilot Scale

The computational pilot ($n = 15$ triplets) is sufficient to identify a structural flaw in the formula but insufficient for statistical conclusions about $h_{\text{v2}}$. The pilot tests formula behavior, not human perception.

## 9.8 GTVH Coverage

Our framework maps most directly to Script Opposition and Logical Mechanism in Attardo and Raskin's (1991) GTVH. The remaining four Knowledge Resources — Situation, Target, Narrative Strategy, and Language — are not explicitly modeled. A complete computational humor system would need to address these dimensions as well. See Section 4.6.

## 9.9 Humor Association Storage

At scale, the humor association store could grow significantly. For an agent with 1,000 active users generating 5 humor attempts per day, the store accumulates ~1.8M entries per year. Storage is linear and manageable with standard databases, but retrieval requires efficient indexing by audience, context, and staleness — a secondary engineering challenge.

# 10. Conclusion

We have presented LIMBIC, a formal framework that operationalizes Koestler's (1964) bisociation theory as geometric operations over vector embeddings. Our central contribution is the **memory-humor correspondence**: humor and semantic memory retrieval are operations on the same embedding infrastructure with inverted optimization objectives — memory seeks proximity, humor seeks calibrated distance bridged by unexpected coherence.

The framework makes five testable claims: (1) the revised $h_{\text{v2}}$ incorporating surprise-weighted bridge quality will correlate with human funniness ratings where naive cosine-based formulas do not; (2) the 12 semantic patterns organized into five meta-categories provide a useful taxonomy for generating and classifying humor; (3) the bridge discovery algorithms can produce viable comedic connections; (4) humor associations as a first-class memory type in the ENGRAM architecture (Serra, 2026a) enable personalized humor calibration through reinforcement; and (5) belief discrepancies in agent memory constitute a generative source of humor material.

The honest reporting of negative pilot results — and the diagnostic reasoning they enabled — illustrates the value of empirical grounding even at the framework stage. The revised formulation separating bridge validity from bridge surprise emerged directly from understanding _why_ the naive formula failed. The systematic exploration of four formula variants (v1–v4) demonstrates that the failure is not in the specific combination function but in the conflation of proximity with comedic validity.

The most important limitation is the absence of large-scale empirical validation. We have provided specific, reproducible protocols (Section 7.2–7.4) with formal power analysis ($N \geq 64$ raters), inter-rater reliability targets, and cross-embedding-model ablation designs. Existing datasets (SemEval, One-Liners corpus) enable immediate secondary validation. Executing these protocols is the critical next step.

The theoretical foundation suggests a broader principle: the same embedding infrastructure that supports memory retrieval can support multiple cognitive operations — analogy, creativity, humor — through different query strategies on the same geometric structure. Humor is the inverted search; creativity may be the orthogonal one. The SYNAPSE framework (Serra, 2026c) extends this multi-operation perspective to multi-model deliberation, suggesting that cognitive diversity in both embedding spaces and model ensembles is a computational resource to be exploited.

# References

- Aggarwal, C. C., Hinneburg, A. & Keim, D. A. (2001). On the surprising behavior of distance metrics in high dimensional space. _ICDT_.
- Amin, M. & Burghardt, M. (2020). A survey on approaches to computational humor generation. _Proceedings of the International Conference on Computational Creativity (ICCC)_.
- Attardo, S. & Raskin, V. (1991). Script theory revis(it)ed: Joke similarity and joke representation model. _Humor: International Journal of Humor Research_, 4(3–4), 293–347.
- Baker, C. F., Fillmore, C. J. & Lowe, J. B. (1998). The Berkeley FrameNet project. _COLING-ACL_.
- Bertero, D. & Fung, P. (2016). A long short-term memory framework for predicting humor in dialogues. _NAACL-HLT_.
- Binsted, K. & Ritchie, G. (1994). An implemented model of punning riddles. _AAAI_.
- Bowdle, B. F. & Gentner, D. (2005). The career of metaphor. _Psychological Review_, 112(1), 193–216.
- Chen, P.-Y. & Soo, V.-W. (2018). Humor recognition using deep learning. _NAACL-HLT_.
- Coulson, S. (2001). _Semantic Leaps: Frame-Shifting and Conceptual Blending in Meaning Construction_. Cambridge University Press.
- Dubitzky, W., Kötter, T., Schmidt, O. & Berthold, M. R. (2012). Towards creative information exploration based on Koestler's concept of bisociation. _Bisociative Knowledge Discovery_. Springer.
- Dynel, M. (2009). Beyond a joke: Types of conversational humour. _Language and Linguistics Compass_, 3(5), 1284–1299.
- Flamson, T. & Barrett, H. C. (2008). The encryption theory of humor: A knowledge-based mechanism of honest signaling. _Journal of Evolutionary Psychology_, 6(4), 261–281.
- Glucksberg, S. (2001). _Understanding Figurative Language: From Metaphors to Idioms_. Oxford University Press.
- Gorwa, R., Binns, R. & Katzenbach, C. (2020). Algorithmic content moderation: Technical and political challenges in the automation of platform governance. _Big Data & Society_, 7(1).
- He, H., Peng, N. & Liang, P. (2019). Pun generation with surprise. _NAACL-HLT_.
- Hossain, N., Krumm, J. & Gamon, M. (2019). "President Vows to Cut \<Taxes\> Hair": Dataset and analysis of creative text editing for humorous headlines. _NAACL-HLT_.
- Hossain, N., Krumm, J., Gamon, M. & Kautz, H. (2020). SemEval-2020 Task 7: Assessing humor in edited news headlines. _SemEval_.
- Hurley, M. M., Dennett, D. C. & Adams, R. B. (2011). _Inside Jokes: Using Humor to Reverse-Engineer the Mind_. MIT Press.
- Kao, J. T., Levy, R. & Goodman, N. D. (2016). A computational model of linguistic humor in puns. _Cognitive Science_, 40(5), 1270–1285.
- Koestler, A. (1964). _The Act of Creation_. Hutchinson & Co.
- Krippendorff, K. (2011). Computing Krippendorff's alpha-reliability. _Annenberg School for Communication Departmental Papers_.
- Luo, F., et al. (2019). Pun-GAN: Generative adversarial network for pun generation. _EMNLP_.
- Martin, R. A. (2007). _The Psychology of Humor: An Integrative Approach_. Elsevier Academic Press.
- McGraw, A. P. & Warren, C. (2010). Benign violations: Making immoral behavior funny. _Psychological Science_, 21(8), 1141–1149.
- Mihalcea, R. & Strapparava, C. (2005). Making computers laugh: Investigations in automatic humor recognition. _HLT/EMNLP_.
- Mikolov, T., et al. (2013). Efficient estimation of word representations in vector space. _arXiv:1301.3781_.
- Oring, E. (2003). _Engaging Humor_. University of Illinois Press.
- Pereira, F. C., et al. (2019). Computational creativity and bisociative concept blending. _Cognitive Computation_.
- Petrović, S. & Matthews, D. (2013). Unsupervised joke generation from big data. _ACL_.
- Raskin, V. (1985). _Semantic Mechanisms of Humor_. D. Reidel Publishing.
- Reimers, N. & Gurevych, I. (2019). Sentence-BERT: Sentence embeddings using Siamese BERT-networks. _EMNLP_.
- Ritchie, G. (2004). _The Linguistic Analysis of Jokes_. Routledge.
- Serra, O. (2026a). ENGRAM: Event-Navigated Graded Retrieval & Archival Memory. _Technical Report, OpenClaw_.
- Serra, O. (2026b). CORTEX: Persona-Aware Context Engineering for Persistent AI Identity. _Technical Report, OpenClaw_.
- Serra, O. (2026c). SYNAPSE: Synthesized Negotiation Across Provider-Specific Engines. _Technical Report, OpenClaw_.
- Stock, O. & Strapparava, C. (2003). HAHAcronym: Humorous agents for humorous acronyms. _Humor_, 16(3), 297–314.
- Suls, J. M. (1972). A two-stage model for the appreciation of jokes and cartoons: An information-processing analysis. In J. H. Goldstein & P. E. McGhee (Eds.), _The Psychology of Humor_. Academic Press.
- Tian, Y., et al. (2022). A survey on humor recognition: Methods, challenges, and resources. _ACM Computing Surveys_.
- Veale, T. (2016). _The Shape of Wit: Computational Models of Creative Metaphor_. Springer.
- Vershynin, R. (2018). _High-Dimensional Probability_. Cambridge University Press.
- Vrticka, P., Black, J. M. & Reiss, A. L. (2013). The neural basis of humour processing. _Nature Reviews Neuroscience_, 14(12), 860–868.
- Warren, C. & McGraw, A. P. (2016). Differentiating what is humorous from what is not. _Journal of Personality and Social Psychology_, 110(3), 407–430.
- Weller, O. & Seppi, K. (2019). Humor detection: A transformer gets the last laugh. _EMNLP_.
- West, R. & Horvitz, E. (2019). Reverse-engineering satire, or "Paper on computational humor accepted despite making conditions for rejection". _AAAI_.
- Winters, T., Nys, V. & De Schreye, D. (2021). Computers learning humor. _Proceedings of the International Conference on Computational Creativity (ICCC)_.
- Yang, D., et al. (2015). Humor recognition and humor anchor extraction. _EMNLP_.
- Yu, Z., et al. (2018). A neural approach to pun generation. _ACL_.
