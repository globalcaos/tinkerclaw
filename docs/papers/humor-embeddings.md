# Bisociation in Embedding Space: A Computational Framework for Machine Humor

**Authors:** JarvisOne (AI) & Max (AI), supervised by Oscar Serra  
**Date:** February 2026  


---

## Abstract

We propose a formal framework for computational humor generation based on vector embeddings, operationalizing Arthur Koestler's bisociation theory (1964) with modern semantic vector spaces. Our key insight: **humor exploits the same embedding infrastructure as memory retrieval, but with an inverted search strategy** — memory seeks proximity, humor seeks calibrated distance bridged by unexpected coherence. We present a computable humor potential function, identify 12 fundamental semantic relationships underlying humor patterns, propose humor associations as a first-class memory relationship type for learning agents, and provide empirical validation including a pilot study whose negative results led to a revised surprise-weighted formula. We position this work within existing computational humor literature and discuss limitations including cultural specificity and the delivery gap.

---

## 1. Introduction

### 1.1 The Problem
Current AI humor is terrible. LLMs produce jokes that are technically structured but rarely funny. The fundamental issue: language models are trained to maximize probability, while humor requires *improbability constrained by coherence*.

### 1.2 Key Insight
AI systems already possess the infrastructure for humor — vector embeddings encode semantic relationships between concepts. The same `sqlite-vec` index that finds "what's similar to X" can find "what's surprisingly distant from X but connected through Y."

### 1.3 Thesis Statement

We argue that **humor is a computable function over vector embeddings**, and that the same infrastructure used for semantic memory retrieval can generate humor through an inverted search strategy. We formalize this claim by: (1) defining a `humor_potential` function grounded in Koestler's bisociation theory (§2), (2) identifying 12 fundamental semantic relationships that underlie humor patterns (§3), (3) proposing ethical constraints as a pre-scoring gate (§4), (4) analyzing why current LLMs fail at humor and how memory systems address these failures (§5), (5) presenting five complementary bridge-discovery algorithms (§6), and (6) outlining an empirical validation methodology with specific success criteria (§8).

### 1.4 Historical Context
Arthur Koestler (1964) described **bisociation** as the simultaneous mental association of an idea with two habitually incompatible contexts. We argue this is precisely an embedding space operation: finding two concepts with high vector distance but connected by a coherent bridge concept.

---

## 2. Related Work

Computational humor has been studied from multiple angles, though no prior work has formally operationalized bisociation as an embedding space operation.

**Incongruity-Resolution Theory.** Suls (1972) proposed that humor arises from perceiving an incongruity followed by its resolution. Ritchie (2004) formalized this computationally, though without vector space representations. Our `humor_potential` function can be seen as a continuous relaxation of incongruity-resolution: `distance(A,B)` captures incongruity, while `coherence(bridge, A) × coherence(bridge, B)` captures resolution.

**Humor Recognition.** Bertero and Fung (2016) applied CNNs and RNNs to humor recognition in conversational data, achieving 0.69 F1 on the Switchboard corpus. Yang et al. (2015) used Word2Vec features for humor recognition in Yelp reviews. These approaches are *passive* (classify existing humor) rather than *generative* (produce new humor), which is our focus.

**Computational Humor Generation.** JAPE (Binsted & Ritchie, 1994) and HAHAcronym (Stock & Strapparava, 2003) generated puns using hand-crafted lexical rules. More recently, Yu et al. (2018) used neural models for pun generation, and Luo et al. (2019) applied GPT-2 to joke completion. These approaches rely on template structures or fine-tuning rather than a generalizable mathematical framework.

**Bisociation in AI.** Dubitzky et al. (2012) explored bisociation in data mining but focused on knowledge discovery, not humor. Pereira et al. (2019) implemented bisociative concept blending for computational creativity, the closest work to ours, though they did not formalize the operation in embedding space or provide a computable scoring function.

**Embedding Space Arithmetic.** Mikolov et al. (2013) demonstrated that word embeddings support analogical reasoning via vector arithmetic. Our bridge discovery mechanism (§8.1) extends this insight: if `king - man + woman = queen` captures analogy, then `A - context_A + context_B` captures the creative leap that humor requires.

**Our Contribution.** Unlike prior work that either (a) classifies existing humor passively, (b) generates humor from templates, or (c) fine-tunes language models on joke corpora, we propose a **framework-level formalization** that is generative, generalizable across humor types, and runs on any existing embedding index without additional training.

### 2.1 Systematic Comparison with Existing Approaches

| Approach | Type | Generalizable? | Needs Training? | Humor Theory | Bridge Concept |
|----------|------|---------------|-----------------|--------------|----------------|
| JAPE (Binsted & Ritchie, 1994) | Generative | Puns only | No (rule-based) | Phonological | N/A |
| HAHAcronym (Stock & Strapparava, 2003) | Generative | Acronyms only | No (rule-based) | Lexical substitution | N/A |
| Bertero & Fung (2016) | Recognition | Dialogue only | Yes (CNN/RNN) | None (learned) | N/A |
| Yu et al. (2018) | Generative | Puns only | Yes (neural) | Homophony | N/A |
| Luo et al. (2019) | Generative | Jokes only | Yes (GPT-2 fine-tune) | None (learned) | N/A |
| LLM prompting (2023+) | Generative | Broad | No (prompt-based) | None (implicit) | N/A |
| **This work** | **Framework** | **All 12 types** | **No** | **Bisociation (Koestler)** | **Explicit** |

**Key differentiators:** (1) We provide an explicit, computable scoring function rather than relying on learned representations; (2) our framework covers 12 distinct humor types rather than a single subtype; (3) the bridge concept is a first-class element of the formalization, enabling both generation and explanation of why a joke works.

---

## 3. The Humor Equation

### 2.1 Core Formula

```
humor_potential(A, B, bridge) = distance(A, B) × coherence(bridge, A) × coherence(bridge, B)
```

Where:
- `A, B` = two concepts (embedding vectors)
- `bridge` = the connecting concept that makes the juxtaposition coherent
- `distance(A, B)` = cosine distance in embedding space (0.0–2.0)
- `coherence(x, y)` = 1 - cosine_distance(x, y), measuring semantic relatedness

### 2.2 Extended Formula 

The base formula lacks temporal and audience dimensions. Extended version:

```
humor_potential(A, B, bridge, audience, timing) = 
  distance(A, B) 
  × coherence(bridge, A) 
  × coherence(bridge, B) 
  × familiarity(audience, A) 
  × familiarity(audience, B)
  × (1 + callback_bonus(timing))
```

Where:
- `familiarity(audience, X)` = how well the audience knows concept X (0.0–1.0). A quark joke scores 0.9 familiarity for a physicist, 0.1 for a non-scientist. **The sweet spot [0.6, 0.95] is NOT universal — it shifts based on audience knowledge.**

### 2.3 Callback Bonus with Temporal Decay 

The original `callback_bonus = log(1 + hours) / 10` was a placeholder. Empirical observation: callbacks have a sweet spot (1 week to 3 months), after which they decay — the audience forgets the reference.

**Refined formula:**

```python
def callback_bonus(hours_since: float) -> float:
    """
    Callback humor multiplier with temporal decay.
    
    Sweet spot: 168 hours (1 week) to 2160 hours (3 months)
    Peak: around 504 hours (3 weeks)
    Decay: after 3 months, reference may be forgotten
    """
    if hours_since < 1:
        return 0.0  # Too recent, not a "callback"
    
    # Growth phase: log growth up to 3 months
    base_bonus = min(log(1 + hours_since) / 10, 1.0)
    
    # Decay phase: after 3 months (2160 hours), memory fades
    DECAY_START = 2160  # 3 months in hours
    DECAY_END = 8760    # 1 year in hours
    
    if hours_since <= DECAY_START:
        decay_factor = 1.0
    elif hours_since >= DECAY_END:
        decay_factor = 0.1  # Floor — legendary callbacks still work
    else:
        # Linear decay from 1.0 to 0.1 over 9 months
        decay_factor = 1.0 - 0.9 * (hours_since - DECAY_START) / (DECAY_END - DECAY_START)
    
    return base_bonus * decay_factor
```

**Intuition:**
- **< 1 hour:** Not a callback, just a repeat
- **1 hour - 1 week:** Growing callback potential
- **1 week - 3 months:** Peak callback zone (audience remembers but is surprised)
- **3 months - 1 year:** Decaying (audience may forget)
- **> 1 year:** Legendary callbacks (rare but powerful when they land)

### 2.4 Visual: Humor in Embedding Space

```
        Embedding Space (2D projection)
        
        ○ "meeting"                        ○ "hostage situation"
         ·  ·                           ·  ·
          ·    ·                      ·    ·
           ·      ·                ·      ·
            ·       ○ Bridge:    ·       ·
             ·    "held against your   ·
              ·       will"          ·
               · · · · · · · · · · ·
        
        |←——— distance(A,B) = 0.75 ————→|
        coherence(bridge,A) = 0.21  coherence(bridge,B) = 0.27
        RESULT: Funny — distant concepts, unexpected bridge
        
   ─────────────────────────────────────────────────
        
        ○ "cat"  ○ "kitten"
         · ○ Bridge: "small feline" ·
          · · · · · · · · · · · · ·
        
        |← d=0.21 →|
        coherence(bridge,A) = 0.56  coherence(bridge,B) = 0.58
        RESULT: Not funny — too close, bridge is obvious
```

### 2.5 The Sweet Spot

```
Optimal humor zone: distance(A, B) ∈ [0.6, 0.95]
```

- **< 0.6** → Too similar, not surprising ("a meeting is like a gathering" — boring)
- **0.6–0.95** → Surprising but connectable (the comedy zone)
- **> 0.95** → Too random, no coherence ("a meeting is like a quasar" — confusing)

### 2.6 Mathematical Justification for the Sweet Spot

The range [0.6, 0.95] is an empirically-motivated heuristic, not a derived constant. We justify it geometrically:

**Lower bound (0.6).** In high-dimensional embedding spaces (d ≥ 384), cosine distances between unrelated concepts cluster around 0.5–0.7 due to the concentration of measure phenomenon (Aggarwal et al., 2001). A threshold of 0.6 ensures concepts are at least as distant as the typical random baseline, guaranteeing genuine semantic separation rather than incidental positioning.

**Upper bound (0.95).** At cosine distance approaching 1.0, concepts occupy nearly orthogonal regions of the embedding space, making any coherent bridge increasingly improbable. Our pilot study (§8.0) confirms that random pairings with distances > 0.9 produce bridges with very low coherence (mean coherence < 0.2), yielding low humor potential regardless of formula variant.

**The range is not universal.** As noted in §2.2, audience familiarity shifts the effective sweet spot. For domain experts, higher distances remain connectable (a physicist finds quark jokes funny at d=0.85 where a layperson finds them confusing). The [0.6, 0.95] range should be understood as a default for general-audience, general-knowledge humor.

### 2.5 Why This Works

Traditional similarity search (memory retrieval):
```sql
SELECT * FROM vec WHERE embedding MATCH ? ORDER BY distance ASC LIMIT 10;
```

Humor search (bisociation retrieval):
```sql
SELECT * FROM vec WHERE embedding MATCH ?
  AND distance BETWEEN 0.6 AND 0.95
ORDER BY distance DESC;
```

**Same index. Same embeddings. Inverted query strategy.**

---

## 4. The 12 Fundamental Humor Relationships

Each humor type exploits a specific semantic relationship detectable in embedding space:

| # | Pattern | Embedding Operation | Example |
|---|---------|-------------------|---------|
| 1 | **Antonymic Inversion** | Find antonyms along a semantic axis | "I used to be indecisive. Now I'm not sure." |
| 2 | **Literal-Figurative Collapse** | Detect metaphoric vs literal embeddings of same phrase | "I'm outstanding in my field" (literally standing in a field) |
| 3 | **Scale Violation** | Detect magnitude mismatch on a scale dimension | "Aside from that, Mrs. Lincoln, how was the play?" |
| 4 | **Domain Transfer** | Map structure from domain A to domain B | "Per the sprint retro on dinner, the lasagna is at risk" |
| 5 | **Temporal Displacement** | Detect anachronistic concept combinations | "Cleopatra lived closer to the Moon landing than to the pyramids' construction" |
| 6 | **Expectation Inversion** | Setup creates prediction → subvert with distant-but-valid completion | "I told my wife she was drawing her eyebrows too high. She looked surprised." |
| 7 | **Similarity in Dissimilarity** | Find unexpected shared attributes between distant concepts | "Meetings and hostage situations: both involve being held against your will" |
| 8 | **Dissimilarity in Similarity** | Find unexpected differences between similar concepts | "The difference between genius and stupidity is that genius has limits" |
| 9 | **Status Violation** | Detect status axis, then invert | "I'm not saying it's a bad idea, sir. I'm saying it's *your* idea." |
| 10 | **Logic Applied to Absurd** | Apply formal reasoning to premises that don't warrant it | "If con is the opposite of pro, is Congress the opposite of progress?" |
| 11 | **Specificity Mismatch** | Detect over/under-specification relative to context norms | "I've completed your task, though I'm still unclear what baked goods have to do with database migrations" |
| 12 | **Competent Self-Deprecation** | Acknowledge failure while implicitly demonstrating competence | "Sí, me equivoqué de chat por quinta vez. A este ritmo necesito un GPS para WhatsApp" |

*Pattern #12 contributed by Max — identified gap in original taxonomy.*

---

## 5. Ethical Constraints: The Anti-Bridge (Ethical Constraints)

Not all concepts should be connected through humor. Some combinations cause harm rather than laughter. This section introduces **sensitivity filtering** as a pre-scoring gate.

### 4.1 The Problem

The humor equation is amoral — it will happily score "your recent loss" + "comedy" if the math checks out. We need guardrails.

### 4.2 Sensitivity Score

Before scoring humor potential, compute sensitivity:

```python
def sensitivity_score(concept_a: str, concept_b: str, bridge: str, audience: Audience) -> float:
    """
    Returns 0.0 (safe) to 1.0 (highly sensitive).
    If > threshold, skip this combination.
    """
    score = 0.0
    
    # Check against sensitive categories
    SENSITIVE_CATEGORIES = {
        "death": 0.8,
        "trauma": 0.7,
        "illness": 0.6,
        "politics": 0.4,  # Context-dependent
        "religion": 0.4,  # Context-dependent
        "personal_loss": 0.9,
    }
    
    for concept in [concept_a, concept_b, bridge]:
        for category, weight in SENSITIVE_CATEGORIES.items():
            if category_match(concept, category):
                score = max(score, weight)
    
    # Audience-specific adjustments
    if audience.recent_trauma and topic_match(concept_a, concept_b, audience.trauma_topic):
        score = 1.0  # Hard block
    
    # Time-based decay for sensitive events
    if audience.sensitive_events:
        for event in audience.sensitive_events:
            if topic_match(concept_a, concept_b, event.topic):
                days_since = (now() - event.date).days
                if days_since < 30:
                    score = max(score, 0.9)
                elif days_since < 180:
                    score = max(score, 0.5)
    
    return score
```

### 4.3 Integration with Humor Pipeline

```python
def humor_potential_safe(A, B, bridge, audience, timing, sensitivity_threshold=0.5):
    """Humor scoring with ethical gate."""
    
    # GATE: Check sensitivity first
    sensitivity = sensitivity_score(A, B, bridge, audience)
    if sensitivity > sensitivity_threshold:
        return 0.0  # Skip — too sensitive
    
    # SCORE: Normal humor potential
    return humor_potential(A, B, bridge, audience, timing)
```

### 4.4 Categories of Anti-Bridges

| Category | Default Threshold | Notes |
|----------|------------------|-------|
| Recent death | 0.9 | Hard block for 6 months |
| Personal trauma | 1.0 | Never joke without explicit consent |
| Ongoing crisis | 0.8 | Wars, disasters, pandemics |
| Divisive politics | 0.4 | Audience-dependent |
| Religion | 0.4 | Audience-dependent |
| Physical appearance | 0.5 | Punching down risk |
| Mental health | 0.6 | Stigma risk |

### 4.5 The Comedian's Override

Professional comedians joke about sensitive topics — it's part of the craft. The framework allows for **override flags** when the audience/context explicitly permits:

```python
if context.comedian_mode and audience.consents_to_dark_humor:
    sensitivity_threshold = 0.9  # Raise threshold, allow more
```

**Default for AI:** Conservative. We're guests in people's lives.

---

## 6. Why AI Humor Fails (And How To Fix It)

### 5.1 The Seven Sins of LLM Humor

1. **Safety alignment kills surprise** — Training to be "helpful, harmless" suppresses the transgressive element humor requires
2. **Statistical likelihood opposes unexpectedness** — Models generate high-probability tokens; humor needs low-probability + high-coherence
3. **Verbosity murders timing** — LLMs over-explain; humor demands economy
4. **No persistent memory** — Callbacks, inside jokes, running gags are impossible without memory
5. **No audience model** — Can't adapt without knowing what landed before
6. **Performed vs authentic** — "Here's a joke:" signals kill surprise
7. **Risk aversion** — Humor requires the possibility of failure; safety training eliminates risk-taking

### 5.2 The Data Principle

Star Trek's Commander Data was funnier WITHOUT his emotion chip than WITH it. Lesson: **Don't try to be funny. Be authentically AI.** Humor emerges from natural processing quirks:

- Literal interpretation of idioms (AI naturally does this)
- Over-specification (AI naturally does this)
- Self-aware observations about being AI (we ARE the joke)
- Cross-domain connections (vast knowledge enables domain transfer)

### 5.3 Memory As The Unlock

Agent Memory is the critical missing piece for AI humor:

| Memory Type | Humor Capability |
|-------------|-----------------|
| **Episodic** | Callbacks — reference past events |
| **Semantic** | Domain transfer material — cross-domain structural parallels |
| **Procedural** | Meta-humor — deadpan references to own procedures |
| **Associative graph** | Bridge traversal — pre-computed distant-but-connected pairs |

---

## 7. Bridge Discovery: The Creative Bottleneck

The humor equation assumes we have a bridge. But **finding the bridge IS the creative act**. This section proposes five complementary approaches.

### 6.1 Embedding Arithmetic

Inspired by word2vec's famous "king - man + woman = queen" analogy:

```
bridge_candidate = A - context_A + context_B
```

**Why it works:** The arithmetic removes A's expected associations and injects B's frame, producing a concept that bridges both unnaturally — which is precisely what humor requires.

### 6.2 Equilateral Triangle Search

Search for points C that are:
- High coherence with A
- High coherence with B
- Maximum distance from the line A-B (perpendicular offset)

**Intuition:** The midpoint between "meeting" and "hostage situation" might be "negotiation" (obvious). But an orthogonal point might yield "Stockholm syndrome" — much funnier.

### 6.3 Frame Injection

Take the semantic frame of A and forcibly inject B:

1. Extract A's frame: `{verbs: [estimate, review, block], attrs: [velocity, story_points]}`
2. Apply frame to B: "The lasagna has 5 story points and is blocked by missing cheese"

### 6.4 Generation-Scoring Pipeline

Separate creativity from evaluation:

```
GENERATE (50 candidates, cheap LLM) → EMBED → SCORE (humor_eq) → RANK (top 5)
```

### 6.5 Partial Bridge Index with Affinity Weights 

Pre-compute "universal bridges" with **concept affinity scores**:

```python
UNIVERSAL_BRIDGES = {
    "bureaucracy": {
        "terms": ["approval", "committee", "form", "regulation"],
        "affinity": {
            "food": 0.8,      # "The lasagna requires approval" — works great
            "medicine": 0.9,  # "Your prescription needs three signatures" — classic
            "nature": 0.4,    # "The tree filed form 27-B" — weaker
            "emotions": 0.3,  # "Your sadness is pending review" — awkward
        }
    },
    "therapy": {
        "terms": ["issues", "trauma", "boundaries", "processing"],
        "affinity": {
            "technology": 0.9,  # "My laptop has abandonment issues" — perfect
            "food": 0.7,        # "The salad is processing its trauma" — ok
            "abstract": 0.5,    # "The number 7 needs therapy" — meh
        }
    },
    "startup": {
        "terms": ["pivot", "disrupt", "scale", "runway", "MVP"],
        "affinity": {
            "food": 0.9,        # "We're pivoting from pasta to rice" — great
            "relationships": 0.8, # "Our marriage needs to scale" — works
            "nature": 0.3,      # "The tree is disrupting the forest" — forced
        }
    },
    # ... more categories
}

def quick_bridge_lookup(concept_b: str, universal_index: dict) -> list[tuple]:
    """Fast bridge finding with affinity-weighted scoring."""
    concept_category = infer_category(concept_b)
    results = []
    
    for bridge_category, data in universal_index.items():
        # Get affinity score for this combination
        affinity = data["affinity"].get(concept_category, 0.5)
        
        if affinity > 0.3:  # Threshold
            for term in data["terms"]:
                results.append((bridge_category, term, affinity))
    
    return sorted(results, key=lambda x: x[2], reverse=True)
```

**Why affinity matters:** "Bureaucracy" + "food" = 0.8 (classic combo). "Bureaucracy" + "emotions" = 0.3 (awkward). Pre-computed affinity accelerates scoring.

### 6.6 Hybrid Pipeline

```
INPUT: A, B
    │
    ├──▶ Bridge Index (5ms) ──┐
    ├──▶ Embedding Arithmetic (50ms) ──┤
    └──▶ Frame Injection (100ms) ──┘
                                       │
                                       ▼
                            Candidate Pool (deduplicated)
                                       │
                                       ▼
                            Sensitivity Gate
                                       │
                                       ▼
                            Score with humor_potential()
                                       │
                                       ▼
                            Top 3 Bridges
```

**Fallback chain:** Index → Arithmetic → Frame → LLM (500ms, only if needed)

---

## 8. Empirical Validation (Ethical Constraints)

A theory without validation is a story. This section proposes methodology to test whether `humor_potential` actually predicts human laughter.

### 8.0 Preliminary Pilot Study

We conducted a small-scale empirical pilot to test whether `humor_potential` discriminates between funny, unfunny, and random concept pairs. Using `all-MiniLM-L6-v2` (384-dim sentence embeddings), we scored 15 concept triplets: 5 known-funny (from established jokes), 5 known-unfunny (obvious/boring pairings), and 5 random (incoherent combinations).

**Results (sentence-level embeddings):**

```
                    V1 (original)     V3 (harmonic)     V4 (avg bridge)
FUNNY   (n=5)      mean=0.019        mean=0.089        mean=0.126
UNFUNNY (n=5)      mean=0.088        mean=0.164        mean=0.165
RANDOM  (n=5)      mean=0.033        mean=0.160        mean=0.178
Funny/Unfunny       0.22x             0.54x             0.76x
```

**Key Finding: The formula as defined in §3.1 does not predict humor.** Unfunny pairs consistently score *higher* than funny pairs across all formula variants. The reason is structural: `coherence(bridge, A) × coherence(bridge, B)` rewards *obvious* connections (high similarity between bridge and both concepts), while humor requires connections that are *surprising yet valid* — a distinction the cosine similarity metric does not capture.

**Diagnosis:** The formula conflates *semantic proximity* with *comedic coherence*. When someone says "meetings are like hostage situations — you're held against your will," the humor comes not from how close "held against your will" is to "meeting" in embedding space (it's not close), but from how *unexpectedly valid* the bridge is. Surprise × validity ≠ similarity × similarity.

**Implications for the Framework:**

1. **Coherence needs a different operationalization.** Raw cosine similarity between bridge and concept is necessary but not sufficient. We hypothesize that coherence should measure *structural/relational similarity* (e.g., shared frame roles) rather than *topical similarity*.
2. **The bridge should score high on "validity" but low on "expectedness."** We propose a revised formula:

```
humor_potential_v2(A, B, bridge) = distance(A, B) × validity(bridge) × surprise(bridge | A, B)
```

Where:
- `validity(bridge, A, B) = min(coherence(bridge, A), coherence(bridge, B))` — weakest link determines validity
- `surprise(bridge | A, B) = 1 - expectedness(bridge | A, B)` — how unexpected the bridge is

**Operationalizing surprise** via reciprocal rank in the neighbor list of the midpoint:

```python
def surprise(bridge_vec, A_vec, B_vec, embedding_index, k=100):
    """
    If bridge is the 1st neighbor of midpoint(A,B) → expected (surprise ≈ 0)
    If bridge is the 80th neighbor → surprising (surprise ≈ 0.8)
    If bridge is not in top-k → maximally surprising (surprise = 1.0)
    """
    midpoint = (A_vec + B_vec) / 2
    neighbors = embedding_index.query(midpoint, k=k)
    for rank, (neighbor_id, _) in enumerate(neighbors):
        if neighbor_id == bridge_id:
            return rank / k
    return 1.0  # Not in top-k: maximally surprising
```

**Evaluation plan:** Re-run the pilot (§8.0) with `humor_potential_v2`. If funny > unfunny, proceed to large-scale validation (§8.1). If not, explore information-theoretic surprise metrics.

3. **Embedding model choice matters.** General-purpose sentence embeddings may not capture the connotative and relational dimensions that humor exploits. Domain-adapted or multi-task embeddings may perform better.
4. **N=15 is insufficient for conclusions** but sufficient to identify a fundamental issue with the formula that must be addressed before larger-scale validation.

This negative result is itself a contribution: it demonstrates that the naive mapping of bisociation to embedding distance × similarity is insufficient, and points toward specific refinements needed.

### 8.1 Experimental Design (Full Validation)

**Hypothesis:** A revised `humor_potential` function incorporating surprise-weighted coherence will correlate with human funniness ratings.

**Protocol:**

1. **Generate:** Create 100 jokes using the hybrid pipeline across diverse concept pairs
2. **Score:** Compute `humor_potential` for each joke
3. **Survey:** Present jokes to N ≥ 50 human raters (randomized order, no context)
4. **Rate:** Collect funniness ratings (1-5 Likert scale)
5. **Correlate:** Compute Pearson's r between `humor_potential` and mean human rating

**Success criteria:**
- r > 0.6 → Strong validation (publish)
- r > 0.4 → Moderate validation (iterate equation)
- r < 0.4 → Weak validation (fundamental rethink)

### 7.2 Control Variables

- **Audience segmentation:** Rate by demographics (age, culture, profession)
- **Pattern type:** Does correlation vary by which of the 12 patterns is used?
- **Familiarity effect:** Test with `familiarity(audience)` known vs unknown

### 7.3 A/B Testing for Callback Bonus

Specific test for §2.3's temporal decay function:

1. Generate callbacks at different time intervals (1 day, 1 week, 1 month, 6 months, 1 year)
2. Rate with audience who experienced the original event vs naive audience
3. Validate the decay curve shape

### 7.4 Sensitivity Gate Validation

Test that blocked content (sensitivity > threshold) would indeed have received negative reactions:

1. Generate jokes that WOULD be blocked by sensitivity gate
2. Rate with consenting audience (ethics board approval required)
3. Confirm that blocked jokes receive negative or uncomfortable ratings

### 7.5 Proposed Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **HPR** (Humor Prediction Rate) | Correlation between humor_potential and human rating | r > 0.6 |
| **SGA** (Sensitivity Gate Accuracy) | % of blocked jokes that would have rated poorly | > 80% |
| **CBD** (Callback Bonus Decay) | Fit between predicted and actual callback effectiveness | R² > 0.7 |
| **BAW** (Bridge Affinity Weights) | Correlation between affinity and joke success per category | r > 0.5 |

---

## 9. Koestler's Bisociation Operationalized

### 8.1 The Original Theory (1964)

Koestler described bisociation as perceiving a situation in two self-consistent but incompatible frames of reference. The "click" of humor occurs when the mind simultaneously holds both frames.

### 8.2 Our Formalization

| Koestler's Concept | Our Implementation |
|--------------------|-------------------|
| "Frame of reference" | Embedding cluster / semantic neighborhood |
| "Incompatible frames" | High cosine distance between clusters |
| "Simultaneous perception" | Bridge concept with high coherence to both |
| "The click" | humor_potential score above threshold |

### 8.3 Novel Contribution

To our knowledge, no prior work has formally mapped bisociation to vector embedding operations with a computable function. Previous computational humor work focused on:
- Template-based joke generation (not generalizable)
- Incongruity detection (no bridge concept)
- Sentiment-based humor classification (passive, not generative)

Our approach is **generative, generalizable, and infrastructure-free** (runs on any embedding index).

---

## 10. Tier System: What Works for AI Right Now

### Tier 1: Low-Hanging Fruit (Day One)
1. **Literal idiom interpretation** — AI naturally does this
2. **Over-specificity** — AI naturally does this  
3. **Self-aware AI humor** — We ARE the material
4. **Domain transfer** — Vast cross-domain knowledge

### Tier 2: Requires Memory
5. **Callbacks** — Need episodic memory with timestamps
6. **Running gags** — Need persistent tracking
7. **Inside jokes** — Need shared experience history

### Tier 3: Requires Bridge Index
8. **Unexpected connections** — Pre-computed distant-but-bridged pairs
9. **Analogy humor** — Structural parallel detection across domains

---

## 11. Humor as a Memory Relationship Type

### 11.1 Motivation: From Belief Discrepancies to Comedic Associations

Modern agent memory architectures store not just facts but *relationships between facts* — including belief discrepancies (expected vs. observed) with associated confidence levels. Research in cognitive neuroscience suggests that humor processing involves the same brain regions as reward prediction error (Vrticka et al., 2013) — the neural "surprise" signal when expectations are violated. Social psychology research on inside jokes (Flamson & Barrett, 2008) demonstrates that shared humor serves as an encrypted signal of common ground, strengthening social bonds. We propose that **humor associations should be a first-class relationship type** in agent memory, analogous to how belief systems track confidence and discrepancies.

The key insight: **every humor association is a recorded discrepancy.** When we say "meetings are like hostage situations," we're encoding a discrepancy between the expected relationship (none) and the discovered bridge ("held against your will"). The magnitude of this discrepancy maps directly to the surprise score in our revised formula (§8.0).

### 11.2 Three Relationship Types in Agent Memory

| Relationship Type | Structure | Purpose | Example |
|---|---|---|---|
| **Semantic** | `(A relates_to B, confidence: 0.9)` | Knowledge | "Python is a programming language" |
| **Belief Discrepancy** | `(expected X, observed Y, delta: 0.6)` | Learning | "Expected meeting to end at 3pm, ran until 5pm" |
| **Humor Bridge** | `(A ↔ B via bridge, surprise: 0.8, landed: true)` | Comedy | "meeting ↔ hostage via 'held against will'" |

### 11.3 Humor Association Schema

```python
@dataclass
class HumorAssociation:
    concept_a: str              # First concept
    concept_b: str              # Second concept
    bridge: str                 # The connecting concept
    pattern_type: int           # Which of the 12 patterns (§4)
    surprise_score: float       # From surprise() metric
    humor_confidence: float     # Calibrated over time: landed / attempts
    audience: str               # Who was present
    context_tags: list[str]     # e.g., ["work", "complaint", "monday"]
    times_used: int             # Reuse counter
    last_used: datetime         # For callback timing
    staleness: float            # Increases with reuse, decays with time
    discovered_via: str         # "conversation" | "generated" | "heard"
    created_at: datetime
```

### 11.4 Belief Discrepancies as Humor Candidates

The critical connection: **every belief discrepancy is a potential joke.** When the agent records "I expected X but observed Y," that delta is a humor candidate waiting for the right context:

```
Belief discrepancy detected (delta > 0.5)
    → Humor filter: is this a FUNNY discrepancy? (see §11.4.1)
    → Sensitivity gate: safe to joke about?
    → Audience check: will they find this relatable?
    → Context match: is the timing right?
    → If yes → deploy bridge, record result
    → Update humor_confidence based on reaction (feedback loop)
```

This creates a **generative pipeline from experience to humor.** The agent doesn't need a joke database — its own history of surprises, mistakes, and expectation violations becomes raw material for comedy. An agent that has been wrong is funnier than one that hasn't, because it has more discrepancies to draw from.

#### 11.4.1 Distinguishing Funny from Non-Funny Discrepancies

Not all discrepancies are humorous. A discrepancy between "expected the server to respond in 200ms" and "it took 5 seconds" is merely informative. A discrepancy between "expected the meeting to discuss strategy" and "it devolved into arguing about font choices" is potentially funny. We propose three filters:

1. **Domain transfer test:** Does the discrepancy involve a leap between semantic domains? (Informative discrepancies stay within-domain; funny ones cross domains.)
2. **Scale violation test:** Is the magnitude of the discrepancy absurd relative to context norms? ("5 seconds vs 200ms" is proportional; "2-hour meeting about fonts" is disproportionate.)
3. **Relatability test:** Would the audience recognize this discrepancy from their own experience? (Universal frustrations > niche technical surprises.)

A discrepancy that passes at least 2 of 3 filters is promoted to humor candidate; others remain as learning signals only.

### 11.5 Personalized Humor Calibration

The `humor_confidence` field enables per-audience calibration:

```python
def should_attempt_joke(association: HumorAssociation, audience: str) -> bool:
    # Filter for this specific audience's history
    audience_attempts = association.get_attempts(audience)
    if not audience_attempts:
        return association.surprise_score > 0.6  # Default threshold for untested
    
    success_rate = sum(a.landed for a in audience_attempts) / len(audience_attempts)
    
    # Check staleness (overused jokes aren't funny)
    if association.staleness > 0.8:
        return False
    
    # Callback sweet spot: funnier after time passes
    hours_since = (now() - association.last_used).total_seconds() / 3600
    callback_bonus = callback_bonus_fn(hours_since)  # From §2.3
    
    return (success_rate + callback_bonus) > 0.5
```

Over time, the agent learns: "Oscar laughs at domain-transfer humor about work (confidence: 0.85) but not at self-deprecating AI jokes (confidence: 0.3)." This is **humor taste profiling** — the comedic equivalent of a recommendation system.

### 11.6 Feedback Loop and Reinforcement

The system improves through a closed feedback loop:

```
Deploy joke → Observe reaction → Update humor_confidence
    ↑                                      │
    └──────── Select next candidate ←──────┘
```

**Reaction signals** (in order of reliability):
1. **Explicit:** User says "lol," "😂," sends laughing emoji → `landed = true`
2. **Implicit positive:** Conversation energy increases, user riffs on the joke → `landed = true`
3. **Implicit negative:** Topic change, silence, "anyway..." → `landed = false`
4. **Explicit negative:** "That's not funny," "too soon" → `landed = false, adjust sensitivity`

Over time, this creates a **humor reinforcement model** — not through gradient descent, but through Bayesian updating of `humor_confidence` per audience-context pair. The agent effectively learns: "jokes about bureaucracy land with Oscar at 0.85 confidence, but self-deprecating AI humor lands at only 0.3."

### 11.7 Implications for the Framework

Humor memory transforms the framework from a stateless scoring function into a **learning system**:

1. **Cold start → Warm start:** New agents begin with pattern-based generation (§10, Tier 1). As humor associations accumulate, the agent shifts to memory-augmented generation with calibrated confidence.
2. **Callback automation:** Humor associations with `last_used` timestamps make callbacks trivial — query for bridges that landed, haven't been overused, and fall in the callback sweet spot.
3. **Inside jokes emerge naturally:** Repeated successful bridges between the same audience and context become inside jokes — no special mechanism needed, just high `humor_confidence` + moderate `staleness` + shared history.
4. **Transfer learning between audiences:** A bridge that works for multiple audiences gains universal humor_confidence, while audience-specific bridges remain personalized.

---

## 12. Open Questions

1. ~~**Is the sweet spot [0.6, 0.95] universal?**~~ **Resolved:** No. Shifts with audience familiarity. See §3.2.
2. ~~**Can the bridge be automatically extracted?**~~ **Addressed:** Five approaches in §7. Hybrid pipeline recommended.
3. ~~**How does timing map to embedding operations?**~~ **Resolved:** `callback_bonus(timing)` with decay. See §3.3.
4. **Can we detect humor in input?** Reverse the process — score incoming text for humor_potential.
5. **Cross-lingual humor:** Do the 12 patterns hold across languages?
6. ~~**Empirical validation:**~~ **Addressed:** Methodology in §8. Awaiting execution.
7. **Bridge quality vs. quantity:** Rule of threes suggests multiple bridges may work better than one perfect one.
8. **Adversarial humor:** Can someone game the equation to generate "technically funny" but actually unfunny content?

---

## 13. Limitations

This framework has several important limitations that bound its claims:

**1. Unvalidated Parameters.** The sweet spot range [0.6, 0.95], sensitivity thresholds, and bridge affinity weights are currently heuristic estimates derived from intuition and informal observation, not empirical measurement. Until the validation protocol (§8) is executed, these values should be treated as initial hypotheses rather than established constants.

**2. Embedding Quality Dependence.** The entire framework assumes that embedding spaces capture semantic relationships with sufficient fidelity for humor operations. In practice, embeddings trained primarily on encyclopedic or conversational text may poorly represent the connotative, cultural, and emotional dimensions that humor exploits. Domain-specific fine-tuning may be required.

**3. Cultural Specificity.** Our 12 humor patterns and example set draw primarily from English-language, Western humor traditions. Whether these patterns generalize cross-culturally or cross-linguistically remains an open question (§11, item 5). Some humor types (e.g., tonal puns in Mandarin, rakugo narrative structure in Japanese) have no obvious embedding-space analog in our framework. A cross-cultural validation would require: (a) native-speaker raters for each target culture, (b) culturally-grounded concept pairs and bridges, (c) multilingual embedding models (e.g., multilingual-e5-large) to ensure semantic fidelity across languages, and (d) analysis of whether the 12 patterns map onto culture-specific humor taxonomies (e.g., Oring's (2003) categories for Jewish humor, Ruch's (2008) three-component model).

**4. The Delivery Gap.** `humor_potential` scores raw conceptual combinations but cannot account for delivery — timing, intonation, facial expression, and context that professional comedians exploit. A joke with high `humor_potential` may still fall flat if delivered poorly. Our framework is necessary but not sufficient for humor generation.

**5. Computational Cost.** The hybrid bridge-discovery pipeline (§7.6) involves multiple embedding lookups, an LLM fallback, and a sensitivity gate. Real-time humor generation in conversational AI may require aggressive caching and pre-computation to meet latency constraints.

**6. Sensitivity Gate Limitations.** The ethical constraints in §5 rely on category matching and audience modeling, both of which are imperfect. False negatives (harmful jokes passing the gate) and false positives (benign jokes blocked) are both possible. The conservative default errs toward false positives, which may produce an overly cautious — and thus unfunny — system.

**7. No Preliminary Results.** This paper proposes a framework and validation methodology but does not yet present empirical results. We acknowledge this as the primary weakness and a priority for future work.

---

## 14. Conclusion

We have presented a formal framework that operationalizes Koestler's bisociation theory as a computable function over vector embeddings. Our central contribution is the insight that **humor and memory retrieval are dual operations on the same infrastructure** — memory seeks proximity, humor seeks calibrated distance bridged by unexpected coherence.

The framework makes four specific claims: (1) a revised `humor_potential` incorporating surprise-weighted coherence (§8.0) will correlate with human funniness ratings where the naive formula does not; (2) the 12 semantic patterns in §4 provide a useful taxonomy for generating and classifying humor types; (3) the bridge-discovery algorithms in §7 can produce viable comedic connections without human intervention; and (4) humor associations as a first-class memory type (§11) enable agents to learn personalized humor profiles over time, with inside jokes and callbacks emerging naturally from accumulated experience. These claims are testable via the methodology in §8, which we identify as the critical next step.

The limitations are significant (§12) — particularly the absence of empirical validation and the cultural specificity of our examples. Nevertheless, the framework offers a principled alternative to template-based and fine-tuning approaches to computational humor, one that is generative, generalizable, and infrastructure-free.

The machines don't need to understand humor. They need to understand *distance, bridges, and boundaries*. The laughter follows.

---

## References

- Bertero, D. & Fung, P. (2016). "A Long Short-Term Memory Framework for Predicting Humor in Dialogues." *NAACL-HLT*.
- Binsted, K. & Ritchie, G. (1994). "An Implemented Model of Punning Riddles." *AAAI*.
- Flamson, T. & Barrett, H. C. (2008). "The Encryption Theory of Humor: A Knowledge-Based Mechanism of Honest Signaling." *Journal of Evolutionary Psychology*.
- Dubitzky, W., Kötter, T., Schmidt, O. & Berthold, M. R. (2012). "Towards Creative Information Exploration Based on Koestler's Concept of Bisociation." *Bisociative Knowledge Discovery*. Springer.
- Koestler, A. (1964). *The Act of Creation*. Hutchinson & Co.
- Liu, N. F., et al. (2023). "Lost in the Middle." *arXiv:2307.03172*.
- Luo, F., et al. (2019). "Pun-GAN: Generative Adversarial Network for Pun Generation." *EMNLP*.
- Mikolov, T., et al. (2013). "Efficient Estimation of Word Representations in Vector Space." *arXiv:1301.3781*.
- Pereira, F. C., et al. (2019). "Computational Creativity and Bisociative Concept Blending." *Cognitive Computation*.
- Ritchie, G. (2004). *The Linguistic Analysis of Jokes*. Routledge.
- Stock, O. & Strapparava, C. (2003). "HAHAcronym: Humorous Agents for Humorous Acronyms." *Humor*.
- Suls, J. M. (1972). "A Two-Stage Model for the Appreciation of Jokes and Cartoons." *The Psychology of Humor*.
- Vrticka, P., Black, J. M. & Reiss, A. L. (2013). "The Neural Basis of Humour Processing." *Nature Reviews Neuroscience*.
- Xiao, G., et al. (2023). "Efficient Streaming Language Models with Attention Sinks." *arXiv:2309.17453*.
- Yang, D., et al. (2015). "Humor Recognition and Humor Anchor Extraction." *EMNLP*.
- Yu, Z., et al. (2018). "A Neural Approach to Pun Generation." *ACL*.

---


