/**
 * FORK: Embedding pipeline and temporal window for AMYGDALA.
 *
 * Provides the EmbeddingWindow ring buffer (K=32 situation embeddings)
 * and the EmbeddingPipeline that runs ONNX sentence encoder + projection.
 * ONNX is loaded lazily -- EmbeddingWindow works without the native addon.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type OrtModule = typeof import("onnxruntime-node");
import type { AmygdalaConfig } from "./types.js";

/**
 * Ring buffer for maintaining the last K situation embeddings (temporal window).
 * Default K=32 per paper.
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

// -- Tokenizer placeholder --

interface TokenizerOutput {
  input_ids: unknown;
  attention_mask: unknown;
  token_type_ids: unknown;
}

/**
 * Minimal character-level tokenizer for bootstrap / testing.
 * Produces fixed-length sequences of ASCII codepoints clamped to vocab size 512.
 *
 * In production, replace with @xenova/transformers AutoTokenizer.
 */
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

// -- Real WordPiece tokenizer (FORK 2026-05-30) ------------------------------
// Replaces naiveTokenize (char-codes → meaningless to MiniLM) with the actual
// BERT/MiniLM WordPiece scheme, loaded from the model's vocab.txt. This is what
// makes "similar situations → similar embeddings" actually hold.

const CLS_ID = 101n;
const SEP_ID = 102n;
const UNK_ID = 100;

export function loadVocab(path: string): Map<string, number> {
  const lines = readFileSync(path, "utf8").split("\n");
  const vocab = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i].replace(/\r$/, "");
    if (tok.length > 0) vocab.set(tok, i);
  }
  return vocab;
}

/** BERT "basic" tokenizer: lowercase, split on whitespace, isolate punctuation. */
function basicTokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text.toLowerCase()) {
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else if (/[^\p{L}\p{N}]/u.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(ch); // punctuation is its own token
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Greedy longest-match WordPiece for a single basic token. */
function wordpiece(token: string, vocab: Map<string, number>): number[] {
  const chars = Array.from(token);
  if (chars.length > 100) return [UNK_ID];
  const ids: number[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let matched: number | undefined;
    while (start < end) {
      const piece = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
      const id = vocab.get(piece);
      if (id !== undefined) {
        matched = id;
        break;
      }
      end--;
    }
    if (matched === undefined) return [UNK_ID]; // unmatchable subword → whole token UNK
    ids.push(matched);
    start = end;
  }
  return ids;
}

function wordpieceTokenize(
  text: string,
  maxLength: number,
  vocab: Map<string, number>,
  ort: OrtModule,
): TokenizerOutput {
  const body: number[] = [];
  outer: for (const w of basicTokenize(text)) {
    for (const id of wordpiece(w, vocab)) {
      if (body.length >= maxLength - 2) break outer;
      body.push(id);
    }
  }
  const ids = new BigInt64Array(maxLength);
  const mask = new BigInt64Array(maxLength);
  const typeIds = new BigInt64Array(maxLength); // single-sentence → all zeros
  ids[0] = CLS_ID;
  mask[0] = 1n;
  let i = 0;
  for (; i < body.length; i++) {
    ids[i + 1] = BigInt(body[i]);
    mask[i + 1] = 1n;
  }
  ids[i + 1] = SEP_ID;
  mask[i + 1] = 1n;
  return {
    input_ids: new ort.Tensor("int64", ids, [1, maxLength]),
    attention_mask: new ort.Tensor("int64", mask, [1, maxLength]),
    token_type_ids: new ort.Tensor("int64", typeIds, [1, maxLength]),
  };
}

/**
 * Embedding pipeline: serialized situation string -> 512d internal embedding.
 * Uses frozen sentence encoder (all-MiniLM-L6-v2) + learned projection layer,
 * both in ONNX. GPU (CUDA) preferred, CPU fallback.
 */
export class EmbeddingPipeline {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private encoderSession: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private projectionSession: any = null;
  private ort: OrtModule | null = null;
  private readonly config: AmygdalaConfig["embedding"];
  private _available = false;
  /** Real WordPiece vocab (null → char-level fallback). FORK 2026-05-30. */
  private vocab: Map<string, number> | null = null;

  /** Temporal window of last K embeddings (K = config.window_size, default 32). */
  readonly window: EmbeddingWindow;

  constructor(config: AmygdalaConfig["embedding"]) {
    this.config = config;
    this.window = new EmbeddingWindow(config.window_size ?? 32, config.internal_dim ?? 512);
  }

  /** Whether ONNX models loaded successfully */
  get available(): boolean {
    return this._available;
  }

  /**
   * Initialize ONNX sessions. Call once at startup before using embed().
   * Gracefully handles missing onnxruntime-node or missing model files.
   */
  async initialize(): Promise<void> {
    try {
      this.ort = (await import("onnxruntime-node")) as OrtModule;
    } catch {
      // onnxruntime-node not installed -- pipeline runs in stub mode
      return;
    }

    const ort = this.ort;
    const options = {
      // FORK 2026-05-30: onnxruntime-node EP short name; CPU is ample for MiniLM
      // and avoids the noisy GPU-device probing + the cuda-EP unavailability path.
      executionProviders: ["cpu" as const],
      graphOptimizationLevel: "all" as const,
      enableCpuMemArena: true,
    };

    try {
      this.encoderSession = await ort.InferenceSession.create(
        this.config.encoder_model_path,
        options,
      );
    } catch {
      // Encoder model not found -- pipeline stays in stub mode
      return;
    }

    try {
      this.projectionSession = await ort.InferenceSession.create(
        this.config.projection_model_path,
        options,
      );
      this._available = true;
    } catch {
      // Projection model not found -- release encoder, stay in stub mode
      await this.encoderSession?.release();
      this.encoderSession = null;
      return;
    }

    // FORK 2026-05-30: load the real WordPiece vocab (vocab.txt next to the
    // encoder). Without it we fall back to the char-level placeholder.
    try {
      this.vocab = loadVocab(join(dirname(this.config.encoder_model_path), "vocab.txt"));
    } catch {
      this.vocab = null;
    }
  }

  /**
   * Embed a serialized situation string into a 512d internal vector.
   * Returns a zero vector if ONNX is not available.
   */
  async embed(situationString: string): Promise<Float32Array> {
    if (!this._available || !this.encoderSession || !this.projectionSession || !this.ort) {
      // Return zero embedding when ONNX not available
      return new Float32Array(this.config.internal_dim ?? 512);
    }

    const ort = this.ort;

    // Step 1-2: Sentence encoder — real WordPiece tokenization (char-level fallback only if vocab absent)
    const encoded = this.vocab
      ? wordpieceTokenize(situationString, 128, this.vocab, ort)
      : naiveTokenize(situationString, 128, ort);
    const encoderResult = await this.encoderSession.run({
      input_ids: encoded.input_ids,
      attention_mask: encoded.attention_mask,
      token_type_ids: encoded.token_type_ids,
    });

    // Mean-pool last_hidden_state -> 384d sentence embedding
    const lastHidden = encoderResult["last_hidden_state"];
    const sentenceEmbedding = meanPool(lastHidden, encoded.attention_mask);

    // Step 3: Projection layer (384 -> 512) + LayerNorm
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
    this._available = false;
  }
}

// -- Helpers --

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
