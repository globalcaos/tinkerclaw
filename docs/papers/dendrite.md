# Fractal Memory Index: A Self-Similar Architecture for Scalable Long-Term Memory in Large Language Models

**Author:** Research Report — the user / JarvisOne AI Research  
**Date:** February 2026  
**Keywords:** fractal data structures, LLM memory, retrieval-augmented generation, self-similarity, memory compression, hierarchical indexing

---

## Abstract

Large Language Models face fundamental memory limitations: fixed context windows, linear KV-cache growth, and flat retrieval architectures that fail to capture multi-scale semantic structure. We propose the **Fractal Memory Index (FMI)**, a novel memory architecture that applies three principles from fractal mathematics to LLM memory systems: (1) **Bε-tree-inspired buffered consolidation** for write-optimized memory ingestion, (2) **Hilbert-curve multi-resolution indexing** for locality-preserving retrieval across semantic granularities, and (3) **Iterated Function System (IFS) semantic compression** for compact memory representation. We provide theoretical analysis showing that FMI achieves O(log n / log B) multi-resolution retrieval, O(log n / (ε·B^(1-ε))) amortized memory writes, and potentially O(d/D) compression ratios where d is the intrinsic fractal dimension of the semantic embedding space and D is the ambient dimension. We compare FMI against RAPTOR, MemGPT, standard RAG, and KV-cache compression methods, demonstrating theoretical advantages in storage efficiency, retrieval flexibility, and write throughput. We argue that existing systems like RAPTOR already exploit fractal-like self-similarity implicitly, and that formalizing this connection yields principled improvements. We identify IFS-based semantic compression as the primary open research challenge and propose concrete experiments for validation.

---

## 1. Introduction

The memory problem in Large Language Models is multifaceted and increasingly urgent. As LLMs are deployed in long-running agent systems, personal assistants, and enterprise knowledge platforms, they must manage growing bodies of information that far exceed their fixed context windows. Current solutions fall into several categories: retrieval-augmented generation (RAG) (Lewis et al., 2020), hierarchical retrieval (Sarthi et al., 2024), operating-system-inspired memory management (Packer et al., 2023), and KV-cache compression (Xiao et al., 2023; Zhang et al., 2024a). Each addresses a subset of the problem but none provides a unified framework.

We observe that these memory challenges share a common structure that fractal mathematics is uniquely positioned to address. Specifically:

1. **Scale invariance in semantic content.** Documents, conversations, and knowledge bases exhibit statistical self-similarity: the distribution of topics within a corpus mirrors the distribution of subtopics within a document, which mirrors the distribution of concepts within a paragraph. This is reflected in well-known power-law distributions in natural language (Zipf, 1949; Mandelbrot, 1953).

2. **Multi-resolution retrieval needs.** Users and downstream tasks require information at varying levels of abstraction — sometimes a gist, sometimes a specific detail. Flat vector retrieval returns results at a single granularity.

3. **Asymmetric read/write patterns.** Memory systems ingest information continuously but retrieve it on demand. This asymmetry matches the performance profile of fractal tree indexes, which are write-optimized.

4. **Biological precedent.** The hippocampal-neocortical memory consolidation system exhibits fractal-like properties: hierarchical organization, multi-scale temporal dynamics, and iterative compression during sleep-replay (McClelland et al., 1995; Buzsáki, 1996).

These observations motivate our proposal: the **Fractal Memory Index (FMI)**, an architecture that formalizes the self-similar structure of semantic memory and exploits it for compression, efficient retrieval, and write optimization.

### 1.1 Contributions

- A formal analysis of self-similarity in LLM memory systems, connecting fractal mathematics to practical memory challenges.
- The FMI architecture integrating three fractal components: buffered consolidation, space-filling curve indexing, and IFS-based compression.
- Theoretical complexity analysis comparing FMI to existing approaches.
- Identification of RAPTOR's implicit fractal structure and how formalizing it yields improvements.
- A concrete research agenda for validating IFS-based semantic compression.

---

## 2. Background

### 2.1 Fractal Mathematics: Key Concepts

**Self-similarity** describes objects whose parts resemble the whole at different scales. A set S is *exactly self-similar* if S = ∪ᵢ fᵢ(S) for a finite set of contractive maps {fᵢ}. More relevant to natural data is *statistical self-similarity*, where statistical properties are invariant under scaling.

**Fractal dimension** generalizes the notion of dimension to non-integer values. For a set S in D-dimensional ambient space, the box-counting dimension is:

    d_B = lim_{ε→0} log N(ε) / log(1/ε)

where N(ε) is the number of ε-boxes needed to cover S. When d_B < D, the set is "fractal" and admits compression: it occupies a d_B-dimensional submanifold of D-dimensional space.

**Iterated Function Systems (IFS)** (Barnsley, 1988) are finite collections of contractive mappings {f₁, ..., fₖ} on a complete metric space. By the Banach Fixed Point Theorem, there exists a unique compact set (the *attractor*) A such that A = ∪ᵢ fᵢ(A). The **Collage Theorem** provides the key insight for compression: if the attractor of an IFS approximates a target set, then the IFS code (the set of contractive maps) provides a compact representation.

**Space-filling curves** map the unit interval [0,1] surjectively onto [0,1]ᴰ while preserving locality. The **Hilbert curve** (Hilbert, 1891) provides optimal locality preservation: nearby points on the curve correspond to nearby points in the higher-dimensional space. This property is exploited in database indexing for efficient range queries over multidimensional data (Lawder & King, 2000).

**Bε-trees** (Brodal & Fagerberg, 2003) generalize B-trees by adding message buffers to internal nodes. The parameter ε ∈ (0, 1] controls the tradeoff between insert and query performance. With branching factor B:
- Insert: O(log_B N / (ε · B^(1-ε))) amortized I/Os
- Point query: O(log_B N / ε) I/Os
- Range query of k results: O(log_B N / ε + k/B) I/Os

This makes Bε-trees optimal for write-heavy workloads, as commercialized in TokuDB (Tokutek/Percona).

### 2.2 Existing LLM Memory Systems

**Retrieval-Augmented Generation (RAG)** (Lewis et al., 2020) augments LLM generation with retrieved documents. Standard RAG chunks documents into fixed-size segments, embeds them with a dense encoder, stores them in a vector database, and retrieves the top-k most similar chunks at query time. Limitations include: chunk boundary artifacts, flat retrieval at a single granularity, and no mechanism for memory consolidation or compression.

**RAPTOR** (Sarthi et al., 2024) constructs a hierarchical summary tree by recursively clustering and summarizing text chunks. Using UMAP for dimensionality reduction and Gaussian Mixture Models for clustering, RAPTOR builds a tree where leaf nodes are original chunks and internal nodes are progressively more abstract summaries. Retrieval can occur at any level, enabling multi-granularity access. RAPTOR achieves state-of-the-art results on question-answering benchmarks requiring multi-step reasoning over long documents.

**MemGPT** (Packer et al., 2023) treats the LLM context window as "RAM" and external storage as "disk," implementing virtual memory management where the LLM itself decides what to page in and out. This enables unbounded conversation history but introduces overhead from self-managed memory operations and does not address the underlying storage efficiency.

**KV-Cache Compression** addresses inference-time memory bottlenecks. Approaches include quantization (KIVI: 2-bit KV cache, Hooper et al., 2024), token eviction (H2O: Heavy-Hitter Oracle, Zhang et al., 2024b; StreamingLLM: attention sinks, Xiao et al., 2023), and paging (vLLM: PagedAttention, Kwon et al., 2023). These methods reduce memory footprint by 2-8× but operate at the token level without semantic awareness.

**HippoRAG** (Gutiérrez et al., 2024) and **Mem0** (2024) integrate knowledge graphs with retrieval, adding relational structure to flat vector stores. These represent a step toward structured memory but remain fundamentally non-fractal.

### 2.3 Neuroscience of Memory Consolidation

The hippocampal-neocortical memory system provides a biological template for LLM memory design. Key principles include:

**Complementary Learning Systems** (McClelland et al., 1995): The hippocampus rapidly encodes episodic memories; the neocortex slowly consolidates them into semantic knowledge. This two-speed architecture prevents catastrophic interference.

**Sleep replay** (Buzsáki, 1996; Diekelmann & Born, 2010): During sleep, hippocampal sharp-wave ripples replay compressed versions of waking experiences, driving synaptic consolidation in neocortex. This is temporally nested: slow oscillations (< 1 Hz) modulate sleep spindles (12-15 Hz), which modulate ripples (80-120 Hz) — a *hierarchical temporal structure* with self-similar nesting.

**Hierarchical Temporal Memory** (Hawkins et al., 2004; 2019): Numenta's HTM framework models neocortical computation using cortical columns that repeat the same algorithm at every level, implementing a self-similar processing hierarchy with sparse distributed representations.

---

## 3. The Fractal Memory Index Architecture

We propose the Fractal Memory Index (FMI), a three-component architecture that maps fractal principles to LLM memory operations.

### 3.1 Component 1: Buffered Memory Consolidation (BMC)

Inspired by Bε-trees and hippocampal-neocortical consolidation, BMC separates memory ingestion from memory organization.

**Architecture:** New memories (text chunks, conversation turns, observations) enter a *write buffer* — an append-only log analogous to the hippocampal buffer. Periodically, a *consolidation process* merges buffered entries into the persistent memory index, performing clustering, summarization, and compression.

**Formally:** Let M be the memory store and B be the write buffer. At consolidation time t:

    M_{t+1} = Consolidate(M_t ∪ Flush(B_t))

where Consolidate performs:
1. **Clustering**: Group related memories using embedding similarity
2. **Summarization**: Generate abstract representations of clusters (à la RAPTOR)
3. **Compression**: Apply IFS coding to redundant memories (see §3.3)
4. **Eviction**: Remove memories whose information is fully captured by higher-level summaries

**Complexity:** Write operations to the buffer are O(1) amortized. Consolidation is O(n log n) but runs asynchronously, amortized over all buffered writes. This matches the Bε-tree performance profile: individual inserts are cheap; bulk reorganization is batched.

**Biological analogy:** The write buffer ↔ hippocampal episodic store. Consolidation ↔ sleep replay. The persistent index ↔ neocortical semantic memory. The key insight from neuroscience is that consolidation is *lossy by design* — memories are compressed into gists, with details available only if explicitly retained.

### 3.2 Component 2: Hilbert-Curve Multi-Resolution Index (HMRI)

Standard vector databases index embeddings using flat structures (HNSW, IVF-PQ). These support single-granularity nearest-neighbor queries but cannot efficiently answer multi-resolution queries like "find relevant information at both the topic level and the detail level."

**Architecture:** HMRI maps the D-dimensional embedding space onto a 1D Hilbert curve, then indexes this curve using a Bε-tree with augmented nodes. Each node in the tree stores:
- The Hilbert-curve interval it covers
- Summary embeddings at multiple granularity levels (leaf, cluster, super-cluster)
- Pointers to both the raw memories and their compressed representations

**Multi-resolution retrieval:** Given a query q, HMRI performs:
1. Compute the Hilbert index h(q) of the query embedding
2. Traverse the Bε-tree, collecting matches at each level of the tree hierarchy
3. Return results ranked by relevance at the requested granularity (or all granularities)

**Formally:** A query at resolution level ℓ retrieves:

    R_ℓ(q) = {m ∈ M : d(embed_ℓ(m), embed_ℓ(q)) < τ_ℓ}

where embed_ℓ is the embedding function at granularity level ℓ and τ_ℓ is the corresponding threshold. The Hilbert-curve structure ensures that scanning a contiguous interval in the index covers a compact region in embedding space.

**Complexity:** Point query: O(log_B n / ε). Multi-resolution query across L levels: O(L · log_B n / ε). This is a multiplicative L factor over single-resolution retrieval, but L is typically small (3-5 levels), and the constant factors are favorable due to cache-friendly sequential access along the Hilbert curve.

**Advantage over RAPTOR:** RAPTOR requires separate embedding and retrieval at each tree level. HMRI unifies all levels in a single index structure, enabling joint retrieval with shared computation.

### 3.3 Component 3: IFS Semantic Compression (ISC)

This is the most speculative and potentially most impactful component. The hypothesis is that semantic embeddings in LLM memory exhibit statistical self-similarity, and that this self-similarity can be exploited for compression using IFS-inspired techniques.

**Hypothesis:** Let E = {e₁, ..., eₙ} be a set of embedding vectors for memories in a domain. If E has fractal dimension d_B < D (the ambient embedding dimension), then there exist contractive mappings {f₁, ..., fₖ} such that the attractor A ≈ E, and k ≪ n.

**Compression scheme:**
1. **Analysis phase:** Estimate the fractal dimension of the embedding space using box-counting. Identify self-similar sub-regions using correlation analysis at multiple scales.
2. **Encoding phase:** For each memory cluster, find the IFS code (set of affine contractions) whose attractor best approximates the cluster's embedding distribution. Store the IFS codes instead of raw embeddings.
3. **Decoding phase:** To retrieve, iterate the IFS to reconstruct embeddings at the desired resolution. Apply the Collage Theorem to bound approximation error.

**Theoretical compression ratio:** If the embedding space has intrinsic fractal dimension d and ambient dimension D, the compression ratio scales as O(d/D). For typical LLM embeddings (D = 768-4096) with estimated intrinsic dimensionality of 50-200 (based on persistent homology studies of embedding spaces; Birdal et al., 2021), this suggests compression ratios of 4-80×.

**Practical considerations:**
- The IFS codes are *learned*, not analytically derived. This requires training a small model to find contractive mappings that minimize reconstruction error.
- Compression is asymmetric: encoding (finding the IFS) is expensive; decoding (iterating the IFS) is cheap. This matches the consolidation model — compression happens during offline consolidation, not during real-time retrieval.
- Error bounds from the Collage Theorem guarantee that if the collage distance is δ, the reconstruction error is at most δ/(1-s), where s is the maximum contractivity.

**Connection to existing work:** This approach generalizes fractal image compression (Jacquin, 1992) from pixel space to semantic embedding space. While fractal image compression fell out of favor due to slow encoding and the rise of wavelet-based methods (JPEG2000), the specific characteristics of memory compression — offline encoding, online decoding, multi-resolution access — align well with the fractal approach's strengths.

### 3.4 Integrated Architecture

The three components integrate as follows:

```
Input memories → [Write Buffer (BMC)] → periodic consolidation →
  [Clustering + Summarization] → [IFS Compression (ISC)] →
  [Hilbert-Curve Index (HMRI)]
  
Query → [HMRI multi-resolution lookup] → [ISC decompression if needed] →
  [Ranked results at requested granularity] → LLM context
```

The consolidation pipeline runs asynchronously (analogous to background garbage collection), while queries are served from the index in real-time.

---

## 4. Theoretical Analysis

### 4.1 Retrieval Complexity

| System | Single query | Multi-res query (L levels) | Write |
|--------|-------------|---------------------------|-------|
| Flat RAG (HNSW) | O(log n) | O(L · log n) | O(log n) |
| RAPTOR | O(L · log n) | O(L · log n) | O(n log n) rebuild |
| MemGPT | O(n) page scan | O(n) | O(1) |
| FMI | O(log_B n / ε) | O(L · log_B n / ε) | O(1) amortized |

FMI matches or improves on all systems for all operations. The key advantage is the O(1) amortized write cost (buffered) combined with competitive query performance. For large B (block size), log_B n ≪ log n.

### 4.2 Storage Complexity

| System | Storage per memory | Total for n memories |
|--------|-------------------|---------------------|
| Flat RAG | O(D) embedding + O(T) text | O(n · (D + T)) |
| RAPTOR | O(D) per level, L levels | O(n · L · D + Σ text) |
| FMI (no ISC) | O(D) + O(log n) index | O(n · D + n log n) |
| FMI (with ISC) | O(d) IFS codes | O(n · d + n log n) |

With ISC compression, FMI reduces the per-memory storage from O(D) to O(d), where d is the intrinsic fractal dimension. For D = 1024 and d ≈ 100, this is a 10× reduction in embedding storage.

### 4.3 Compression Analysis

The effectiveness of ISC depends on the fractal dimension of the embedding space. We can estimate this theoretically:

**Argument for low fractal dimension:** LLM embeddings are generated by a finite-capacity model mapping from a structured input space (natural language). The effective dimensionality of natural language is far lower than the embedding dimension — this is why dimensionality reduction techniques (PCA, UMAP) work well on embeddings. Studies of intrinsic dimensionality in neural network representations consistently find values of 20-200 for embedding spaces of dimension 768-4096 (Ansuini et al., 2019; Pope et al., 2021).

**IFS compression bound:** By the Collage Theorem, if we find an IFS {f₁, ..., fₖ} with contractivity s < 1 such that the Hausdorff distance d_H(E, ∪ᵢ fᵢ(E)) ≤ δ, then d_H(E, A) ≤ δ/(1-s), where A is the IFS attractor. The storage cost is O(k · D²) for affine maps in D dimensions (each map is a D×D matrix plus translation). For the compression to be worthwhile, we need k · D² < n · D, i.e., k < n/D. With n = 100,000 memories and D = 1024, we need k < ~100 IFS maps, which is plausible for well-structured memory domains.

**Alternative: Hierarchical IFS.** Rather than compressing the entire embedding space with a single IFS, we can apply IFS compression hierarchically — at the cluster level, sub-cluster level, etc. This mirrors the fractal structure itself and allows the IFS codes to capture local self-similarity patterns that differ across memory regions.

### 4.4 Retrieval Quality

Multi-resolution retrieval improves answer quality for questions that require reasoning at different abstraction levels. Consider a question like "How has the company's strategy evolved over the past decade?" This requires:
- **Detail-level retrieval**: Specific strategy announcements, quarterly reports
- **Summary-level retrieval**: Annual summaries, strategic pivots
- **Theme-level retrieval**: Overarching strategic themes across years

RAPTOR can answer this by querying different tree levels, but independently. FMI's Hilbert-curve index enables *joint* retrieval: a single traversal identifies relevant memories at all scales, with results naturally ordered by the space-filling curve's locality property.

---

## 5. Comparison with Existing Approaches

### 5.1 FMI vs. RAPTOR

RAPTOR is the closest existing system to FMI. Both build hierarchical memory structures with multi-granularity access. Key differences:

| Aspect | RAPTOR | FMI |
|--------|--------|-----|
| Construction | Batch rebuild from scratch | Incremental (buffered consolidation) |
| Index structure | Tree of summaries | Bε-tree with Hilbert indexing |
| Compression | None (stores all levels) | IFS compression of embeddings |
| Write model | O(n log n) rebuild | O(1) amortized |
| Multi-res query | Separate query per level | Single unified traversal |
| Clustering | UMAP + GMM (fixed) | Adaptive, informed by fractal dimension |

FMI can be seen as a principled generalization of RAPTOR that formalizes its implicit fractal structure and adds write optimization and compression.

### 5.2 FMI vs. MemGPT

MemGPT and FMI address orthogonal aspects of memory management. MemGPT manages *what to put in context*; FMI manages *how to store and retrieve it*. The two are complementary: MemGPT could use FMI as its backing store, replacing flat vector search with multi-resolution fractal retrieval.

### 5.3 FMI vs. KV-Cache Compression

KV-cache compression operates at the token level during inference; FMI operates at the memory/knowledge level during storage and retrieval. However, the ISC component suggests a connection: if KV-cache attention patterns exhibit self-similarity across layers (as multi-scale attention architectures suggest), IFS-inspired compression could complement existing quantization and eviction methods.

### 5.4 FMI vs. Standard RAG

Standard RAG is a special case of FMI with a single granularity level, no consolidation, and no compression. FMI strictly generalizes RAG.

---

## 6. Implementation Considerations

### 6.1 Prototype Architecture

A minimal FMI implementation requires:

1. **Write buffer**: Redis or a simple append-only log
2. **Consolidation engine**: A background process that periodically:
   - Clusters new memories (HDBSCAN over embeddings)
   - Generates summaries (LLM call per cluster)
   - Reindexes using Hilbert-curve mapping
3. **Hilbert-curve index**: Built on top of an existing Bε-tree implementation (e.g., TokuDB's fractal tree library) or a B-tree with message buffers
4. **Vector storage**: Standard embedding store (FAISS, pgvector) with Hilbert-curve ordering

For the ISC component (research prototype):
5. **Fractal dimension estimator**: Box-counting algorithm over embedding samples
6. **IFS learner**: Small neural network trained to predict contractive mappings for embedding clusters
7. **Reconstruction module**: IFS iterator with error-bounded approximation

### 6.2 Consolidation Schedule

Borrowing from the neuroscience of sleep cycles, we propose a tiered consolidation schedule:

- **Micro-consolidation** (every ~100 new memories): Cluster and index new entries
- **Macro-consolidation** (every ~10,000 memories or daily): Full re-summarization, IFS compression, index rebuild
- **Archival consolidation** (weekly/monthly): Aggressive compression of old, rarely-accessed memories

This mirrors the biological pattern of synaptic consolidation (minutes-hours) → systems consolidation (days-weeks) → long-term storage (months-years).

### 6.3 Integration with Existing Systems

FMI is designed as a drop-in replacement for the retrieval backend in existing RAG pipelines. The API surface is:

```python
class FractalMemoryIndex:
    def add(self, text: str, embedding: np.ndarray, metadata: dict) -> None
        """Add to write buffer (O(1))"""
    
    def query(self, q_embedding: np.ndarray, 
              levels: List[int] = [0, 1, 2],
              top_k: int = 10) -> List[MemoryResult]
        """Multi-resolution retrieval"""
    
    def consolidate(self, aggressive: bool = False) -> ConsolidationStats
        """Trigger consolidation cycle"""
    
    def stats(self) -> IndexStats
        """Fractal dimension, compression ratio, memory usage"""
```

### 6.4 Estimated Engineering Effort

| Component | Complexity | Time estimate |
|-----------|-----------|---------------|
| Write buffer + consolidation | Moderate | 2-4 weeks |
| Hilbert-curve indexing | Moderate | 2-4 weeks |
| Multi-resolution retrieval | Moderate | 2-3 weeks |
| IFS compression (research) | High | 2-4 months |
| Integration + testing | Moderate | 2-4 weeks |
| **Total (without ISC)** | | **2-3 months** |
| **Total (with ISC)** | | **4-7 months** |

The system without ISC (Components 1 and 2 only) already provides significant advantages over flat RAG and is immediately buildable. ISC is the research frontier.

---

## 7. Limitations and Open Questions

### 7.1 Is Semantic Space Actually Fractal?

The central empirical question. While there is strong circumstantial evidence (low intrinsic dimensionality, power-law distributions, hierarchical topic structure), rigorous measurement of fractal dimension in LLM embedding spaces has not been performed. We propose the following experiment:

1. Embed a large, diverse corpus (e.g., Wikipedia) using a standard encoder (e.g., text-embedding-3-large)
2. Compute box-counting dimension at multiple scales
3. Test for scale invariance in the correlation integral
4. Compare fractal dimension across domains (science, law, fiction)

If the fractal dimension is consistently d ≪ D across domains, ISC is justified. If d ≈ D, the compression claims are invalid (though Components 1 and 2 remain useful).

### 7.2 IFS Learning Convergence

Learning IFS codes for high-dimensional embedding spaces is an open problem. The search space of affine contractions in D dimensions is O(D²) per map, which is large for D = 1024. Possible mitigations:
- Learn IFS codes in a reduced space (after PCA to d dimensions)
- Use structured contractions (diagonal + low-rank perturbation)
- Apply the Collage Theorem iteratively with greedy map selection

### 7.3 Consolidation Drift

Over many consolidation cycles, accumulated lossy compression may cause semantic drift — memories gradually lose fidelity. This mirrors the biological phenomenon of false memories arising from repeated consolidation. Mitigation: maintain checksums on critical memories, with periodic re-embedding from source text.

### 7.4 Cold-Start and Domain Transfer

FMI's compression improves as more memories are ingested and the fractal structure stabilizes. Performance during cold-start (few memories) is no better than standard RAG. Domain transfer — applying an FMI trained on one domain to another — depends on whether the fractal structure generalizes.

### 7.5 Comparison to Simpler Hierarchical Approaches

The Skeptic's objection is valid: how much of FMI's benefit comes from the fractal formalism versus simply "being hierarchical"? We acknowledge that a well-engineered hierarchical index without fractal mathematics could capture much of the practical benefit. The fractal formalism adds:
- Principled compression bounds (via IFS/Collage Theorem)
- Fractal dimension as a measurable quantity that predicts compressibility
- Connection to a rich mathematical toolkit (measure theory, dynamical systems)

Whether these theoretical advantages translate to practical gains is an empirical question.

---

## 8. Related Work

Beyond the systems discussed above, several lines of work are relevant:

**FractalNet** (Larsson et al., 2017) applies self-similar macro-architecture to neural network design, demonstrating that fractal structure can be a design principle for deep learning. Our work extends this from network architecture to memory architecture.

**GraphFractalNet** (2025) uses fractal attention mechanisms for graph learning, capturing hierarchical self-similar structures. This validates the applicability of fractal attention in representation learning.

**Hierarchical Temporal Memory** (Hawkins et al., 2004; 2019) models neocortical computation using self-similar cortical columns. HTM's sparse distributed representations and multi-scale temporal processing directly inspire FMI's multi-resolution retrieval.

**Fractal image compression** (Barnsley, 1988; Jacquin, 1992; Fisher, 1995) provides the mathematical foundation for ISC. While fractal image compression was commercially unsuccessful due to slow encoding, the asymmetric encode/decode characteristic aligns well with memory consolidation (slow storage, fast retrieval).

**Cognitive Workspace** (2025) proposes active memory management for LLMs with metacognitive control, complementing our focus on storage and retrieval efficiency.

**Space-filling curves in databases** (Lawder & King, 2000; Hudi Z-order indexing) demonstrate the practical value of Hilbert-curve indexing for multi-dimensional data, which we adapt for embedding spaces.

---

## 9. Conclusion

We have presented the Fractal Memory Index (FMI), an architecture that applies fractal mathematics — self-similarity, recursive compression, and space-filling curves — to the problem of long-term memory in Large Language Models. FMI integrates three components: buffered memory consolidation inspired by Bε-trees and hippocampal-neocortical systems, Hilbert-curve multi-resolution indexing for locality-preserving retrieval, and IFS-based semantic compression for compact memory representation.

Our theoretical analysis demonstrates that FMI achieves favorable complexity bounds for writes (O(1) amortized), multi-resolution retrieval (O(L · log_B n)), and storage (potentially O(d/D) compression via ISC). We have shown that existing systems like RAPTOR already exploit fractal-like self-similarity implicitly, and that formalizing this connection yields principled improvements.

The primary open challenge is validating IFS-based semantic compression. If LLM embedding spaces have low fractal dimension (as circumstantial evidence suggests), ISC could deliver 4-80× compression ratios. Even without ISC, the buffered consolidation and multi-resolution indexing components provide immediate practical value.

The fractal perspective on LLM memory is not merely metaphorical. It connects memory system design to a rigorous mathematical framework with provable properties, and it resonates with biological memory systems that have been optimized by evolution over millions of years. We believe this connection merits further exploration and invite the community to validate, challenge, and extend this framework.

---

## References

Ansuini, A., Laio, A., Macke, J.H., & Zoccolan, D. (2019). Intrinsic dimension of data representations in deep neural networks. *NeurIPS 2019*.

Barnsley, M.F. (1988). *Fractals Everywhere*. Academic Press.

Barnsley, M.F. (2002). Iterated Function Systems for Lossless Data Compression. In *Fractals in Multimedia*, Springer.

Birdal, T., Lou, A., Guibas, L.J., & Siber, G. (2021). Intrinsic dimension, persistent homology and generalization in neural networks. *NeurIPS 2021*.

Brodal, G.S. & Fagerberg, R. (2003). Lower bounds for external memory dictionaries. *SODA 2003*.

Buzsáki, G. (1996). The hippocampo-neocortical dialogue. *Cerebral Cortex*, 6(2), 81-92.

Collins, A.M. & Loftus, E.F. (1975). A spreading-activation theory of semantic processing. *Psychological Review*, 82(6), 407-428.

Diekelmann, S. & Born, J. (2010). The memory function of sleep. *Nature Reviews Neuroscience*, 11(2), 114-126.

Fisher, Y. (1995). *Fractal Image Compression: Theory and Application*. Springer.

Gao, Y., Xiong, Y., Gao, X., Jia, K., Pan, J., Bi, Y., ... & Wang, H. (2023). Retrieval-augmented generation for large language models: A survey. *arXiv:2312.10997*.

Gutiérrez, B.J., et al. (2024). HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models. *arXiv:2405.14831*.

Hawkins, J. & Blakeslee, S. (2004). *On Intelligence*. Times Books.

Hawkins, J., Lewis, M., Klukas, M., Purdy, S., & Ahmad, S. (2019). A Framework for Intelligence and Cortical Function Based on Grid Cells and Cortical Columns. *Frontiers in Neural Circuits*, 13, 22.

Hilbert, D. (1891). Über die stetige Abbildung einer Linie auf ein Flächenstück. *Mathematische Annalen*, 38(3), 459-460.

Hooper, C., Kim, S., Mohammadzadeh, H., Mahoney, M.W., Shao, Y.S., Keutzer, K., & Gholami, A. (2024). KVQuant: Towards 10 Million Context Length LLM Inference with KV Cache Quantization. *arXiv:2401.18079*.

Jacquin, A.E. (1992). Image coding based on a fractal theory of iterated contractive image transformations. *IEEE Transactions on Image Processing*, 1(1), 18-30.

Jannen, W., Yuan, J., Zhan, Y., Akshintala, A., Esmet, J., Jiao, Y., ... & Bender, M.A. (2015). BetrFS: A Right-Optimized Write-Optimized File System. *FAST 2015*.

Kwon, W., Li, Z., Zhuang, S., Sheng, Y., Zheng, L., Yu, C.H., ... & Stoica, I. (2023). Efficient Memory Management for Large Language Model Serving with PagedAttention. *SOSP 2023*.

Larsson, G., Maire, M., & Shakhnarovich, G. (2017). FractalNet: Ultra-Deep Neural Networks without Residuals. *ICLR 2017*.

Lawder, J.K. & King, P.J.H. (2000). Querying multi-dimensional data indexed using the Hilbert space-filling curve. *ACM SIGMOD Record*, 30(1), 19-24.

Lewis, P., Perez, E., Piktus, A., Petroni, F., Karpukhin, V., Goyal, N., ... & Kiela, D. (2020). Retrieval-augmented generation for knowledge-intensive NLP tasks. *NeurIPS 2020*.

Liu, Z., Lin, Y., Cao, Y., Hu, H., Wei, Y., Zhang, Z., ... & Guo, B. (2021). Swin Transformer: Hierarchical Vision Transformer using Shifted Windows. *ICCV 2021*.

Lin, T.Y., Dollár, P., Girshick, R., He, K., Hariharan, B., & Belongie, S. (2017). Feature Pyramid Networks for Object Detection. *CVPR 2017*.

Mandelbrot, B. (1953). An informational theory of the statistical structure of language. *Communication Theory*, 84, 486-502.

McClelland, J.L., McNaughton, B.L., & O'Reilly, R.C. (1995). Why there are complementary learning systems in the hippocampus and neocortex. *Psychological Review*, 102(3), 419-457.

Packer, C., Fang, V., Patil, S.G., Lin, K., Wooders, S., & Gonzalez, J.E. (2023). MemGPT: Towards LLMs as Operating Systems. *arXiv:2310.08560*.

Pope, P., Zhu, C., Abdelkader, A., Goldblum, M., & Goldstein, T. (2021). The intrinsic dimension of images and its impact on learning. *ICLR 2021*.

Sarthi, P., Abdullah, S., Tuli, A., Khanna, S., Goldie, A., & Manning, C.D. (2024). RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval. *ICLR 2024*.

Sohl-Dickstein, J. (2024). The boundary of neural network trainability is fractal. *arXiv:2402.06184*.

Xiao, G., Tian, Y., Chen, B., Han, S., & Lewis, M. (2023). Efficient Streaming Language Models with Attention Sinks. *ICLR 2024*.

Zhang, Z., Sheng, Y., Zhou, T., Chen, T., Zheng, L., Cai, R., ... & Gonzalez, J.E. (2024a). H2O: Heavy-Hitter Oracle for Efficient Generative Inference of Large Language Models. *NeurIPS 2023*.

Zhang, T., Yi, J., Xu, Z., & Shrivastava, A. (2024b). KV Cache is 1 Bit Per Channel: Efficient Large Language Model Inference with Coupled Quantization. *arXiv:2405.03917*.

Zipf, G.K. (1949). *Human Behavior and the Principle of Least Effort*. Addison-Wesley.
