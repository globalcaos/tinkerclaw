// ============================================================
// src/amygdala/embedding.ts
// P0.2 — Embedding Pipeline
// ============================================================
//
// Dependencies:
//   - onnxruntime-node (npm install onnxruntime-node)
//   - @xenova/transformers (npm install @xenova/transformers)  [for tokenizer]
//
// Models (export via export_encoder.py):
//   - models/amygdala/encoder.onnx     (all-MiniLM-L6-v2)
//   - models/amygdala/projection.onnx  (Linear 384 → 512 + LayerNorm)

// onnxruntime-node is loaded lazily in EmbeddingPipeline.initialize() so that
// EmbeddingWindow and cosineSimilarity can be used (and tested) without the
// native binary being installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtModule = typeof import("onnxruntime-node");
import type { AmygdalaConfig } from "./types";

// ---------------------------------------------------------------------------
// Ring buffer for temporal window of K=32 situation embeddings
// ---------------------------------------------------------------------------

/**
 * Ring buffer for maintaining the last K situation embeddings (temporal window).
 * Default K=32 per paper §4.8.
 */
export class EmbeddingWindow {
  private buffer: Float32Array[];
  private head: number = 0;
  private count: number = 0;
  private readonly capacity: number;
  private readonly dim: number;

  constructor(capacity: number = 32, dim: number = 512) {
    this.capacity = capacity;
    this.dim = dim;
    this.buffer = Array.from({ length: capacity }, () => new Float32Array(dim));
  }

  /** Add a new embedding to the window (oldest evicted on overflow). */
  push(embedding: Float32Array): void {
    if (embedding.length !== this.dim) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dim}, got ${embedding.length}`,
      );
    }
    this.buffer[this.head].set(embedding);
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  /**
   * Get the full sequence in chronological order.
   * Returns K embeddings (padded with zeros if fewer than K have been pushed).
   * Shape: [K, dim] flattened to Float32Array of length K*dim.
   */
  getSequence(): Float32Array {
    const result = new Float32Array(this.capacity * this.dim);
    // Padding (zeros) fills the first (capacity - count) slots.
    // Actual embeddings (chronological) fill the remaining count slots.
    const pad = this.capacity - this.count;
    for (let i = 0; i < this.count; i++) {
      const bufIdx = (this.head - this.count + i + this.capacity) % this.capacity;
      result.set(this.buffer[bufIdx], (pad + i) * this.dim);
    }
    return result;
  }

  /** Returns embeddings in chronological order (only filled slots). */
  getAll(): Float32Array[] {
    const result: Float32Array[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.capacity) % this.capacity;
      result.push(new Float32Array(this.buffer[idx]));
    }
    return result;
  }

  /** Get current count of embeddings in the window. */
  getCount(): number {
    return this.count;
  }

  /** Get the most recent embedding (for Architecture E which uses single embedding). */
  getLatest(): Float32Array | null {
    if (this.count === 0) {
      return null;
    }
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return new Float32Array(this.buffer[idx]);
  }

  /** Reset the buffer. */
  reset(): void {
    this.head = 0;
    this.count = 0;
    for (const buf of this.buffer) {
      buf.fill(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Simple word-piece-style tokenizer placeholder
// ---------------------------------------------------------------------------

interface TokenizerOutput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input_ids: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attention_mask: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  token_type_ids: any;
}

/**
 * Minimal character-level tokenizer for bootstrap / testing.
 * Produces fixed-length sequences of ASCII codepoints clamped to vocab size 512.
 *
 * NOTE: In production, replace with @xenova/transformers AutoTokenizer:
 *
 *   import { AutoTokenizer } from '@xenova/transformers';
 *   const tokenizer = await AutoTokenizer.from_pretrained('Xenova/all-MiniLM-L6-v2');
 *   const { input_ids, attention_mask, token_type_ids } = tokenizer(text, {
 *     padding: true, truncation: true, max_length: 128, return_tensors: 'pt'
 *   });
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function naiveTokenize(text: string, maxLength: number, ort: OrtModule): TokenizerOutput {
  const chars = Array.from(text).slice(0, maxLength - 2);
  const ids = new BigInt64Array(maxLength);
  const mask = new BigInt64Array(maxLength);
  const typeIds = new BigInt64Array(maxLength);

  // [CLS] = 101, [SEP] = 102
  ids[0] = 101n;
  mask[0] = 1n;
  for (let i = 0; i < chars.length; i++) {
    ids[i + 1] = BigInt(chars[i].charCodeAt(0) % 30522); // BERT vocab size
    mask[i + 1] = 1n;
  }
  ids[chars.length + 1] = 102n;
  mask[chars.length + 1] = 1n;

  return {
    input_ids: new ort.Tensor("int64", ids, [1, maxLength]),
    attention_mask: new ort.Tensor("int64", mask, [1, maxLength]),
    token_type_ids: new ort.Tensor("int64", typeIds, [1, maxLength]),
  };
}

// ---------------------------------------------------------------------------
// EmbeddingPipeline
// ---------------------------------------------------------------------------

/**
 * Embedding pipeline: serialized situation string → 512d internal embedding.
 * Uses frozen sentence encoder (all-MiniLM-L6-v2) + learned projection layer,
 * both in ONNX. GPU (CUDA) preferred, CPU fallback.
 *
 * Target latency: <2ms on GPU.
 */
export class EmbeddingPipeline {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private encoderSession: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private projectionSession: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ort: OrtModule | null = null;
  private readonly config: AmygdalaConfig["embedding"];

  /** Temporal window of last K embeddings (K = config.window_size, default 32). */
  readonly window: EmbeddingWindow;

  constructor(config: AmygdalaConfig["embedding"]) {
    this.config = config;
    this.window = new EmbeddingWindow(config.window_size ?? 32, config.internal_dim ?? 512);
  }

  /**
   * Initialize ONNX sessions. Call once at startup before using embed().
   * Tries CUDA first, falls back to CPU automatically.
   *
   * Requires: npm install onnxruntime-node
   */
  async initialize(): Promise<void> {
    // Lazy import so EmbeddingWindow/cosineSimilarity work without the native package.
    this.ort = (await import("onnxruntime-node")) as OrtModule;
    const ort = this.ort;

    const options = {
      executionProviders: [{ name: "cuda" }, { name: "cpu" }],
      graphOptimizationLevel: "all" as const,
      enableCpuMemArena: true,
    };

    try {
      this.encoderSession = await ort.InferenceSession.create(
        this.config.encoder_model_path,
        options,
      );
    } catch (err) {
      throw new Error(`Failed to load encoder model at ${this.config.encoder_model_path}: ${err}`, {
        cause: err,
      });
    }

    try {
      this.projectionSession = await ort.InferenceSession.create(
        this.config.projection_model_path,
        options,
      );
    } catch (err) {
      throw new Error(
        `Failed to load projection model at ${this.config.projection_model_path}: ${err}`,
        { cause: err },
      );
    }
  }

  /**
   * Embed a serialized situation string into a 512d internal vector.
   *
   * Pipeline:
   *   1. Tokenize input string (naive fallback; swap in @xenova/transformers for production)
   *   2. Run sentence encoder (all-MiniLM-L6-v2) → 384d via mean pooling
   *   3. Run projection layer (384 → 512) with LayerNorm
   *   4. Push result into temporal window
   *   5. Return 512d Float32Array
   */
  async embed(situationString: string): Promise<Float32Array> {
    if (!this.encoderSession || !this.projectionSession) {
      throw new Error("EmbeddingPipeline not initialized. Call initialize() first.");
    }

    const ort = this.ort!;

    // Step 1–2: Sentence encoder
    const encoded = naiveTokenize(situationString, 128, ort);
    const encoderResult = await this.encoderSession.run({
      input_ids: encoded.input_ids,
      attention_mask: encoded.attention_mask,
      token_type_ids: encoded.token_type_ids,
    });

    // Mean-pool last_hidden_state → 384d sentence embedding
    const lastHidden = encoderResult["last_hidden_state"];
    const sentenceEmbedding = meanPool(lastHidden, encoded.attention_mask);

    // Step 3: Projection layer (384 → 512) + LayerNorm
    const projInput = new ort.Tensor("float32", sentenceEmbedding, [1, this.config.input_dim]);
    const projResult = await this.projectionSession.run({ input: projInput });
    const projected = projResult["output"];

    const result = new Float32Array(projected.data as Float32Array);

    // Step 4: Update temporal window
    this.window.push(result);

    return result;
  }

  async dispose(): Promise<void> {
    await this.encoderSession?.release();
    await this.projectionSession?.release();
    this.encoderSession = null;
    this.projectionSession = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mean pooling: average token embeddings weighted by attention mask.
 * Input:  lastHidden shape [1, seq_len, hidden_size]
 *         attentionMask shape [1, seq_len]
 * Output: Float32Array of length hidden_size
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function meanPool(lastHidden: any, attentionMask: any): Float32Array {
  const data = lastHidden.data as Float32Array;
  const mask = attentionMask.data as BigInt64Array;
  const [, seqLen, hiddenSize] = lastHidden.dims as [number, number, number];

  const result = new Float32Array(hiddenSize);
  let totalMask = 0;

  for (let t = 0; t < seqLen; t++) {
    const m = Number(mask[t]);
    if (m === 0) {
      continue;
    }
    totalMask += m;
    for (let d = 0; d < hiddenSize; d++) {
      result[d] += data[t * hiddenSize + d] * m;
    }
  }

  if (totalMask > 0) {
    for (let d = 0; d < hiddenSize; d++) {
      result[d] /= totalMask;
    }
  }

  return result;
}

/**
 * Cosine similarity between two vectors (utility for tests and evaluation).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error("Vector length mismatch");
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
