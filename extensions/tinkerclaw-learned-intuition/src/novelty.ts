/**
 * FORK: AMYGDALA v3.1 — novelty / OOD channel.
 *
 * The validated signal (offline AUROC 0.875 in-distribution vs OOD; ~0.5 on
 * danger, i.e. it is honestly an ASK signal, not a danger detector): how
 * UNFAMILIAR is the current situation relative to everything the agent has
 * already seen? Novelty = 1 − mean(top-k cosine similarity to the reference set
 * of past situation embeddings).
 *
 * The feedback loop is STRUCTURAL, not gradient-based: every evaluated situation
 * is `add()`ed to the reference, so a situation that was novel the first time
 * stops being novel once it recurs — habituation / extinction (the vmPFC brake
 * the design demanded) without a single training step.
 *
 * Pure logic: no sqlite import here. `runtime-hook.ts` loads the reference from
 * the training log and persists the calibrated threshold.
 */

export interface NoveltyConfig {
  /** k for the k-NN mean (default 10). */
  k: number;
  /** Reference ring capacity (default 5000, most-recent kept). */
  cap: number;
  /** Below this many reference points the channel is disabled (score → null). */
  minRef: number;
  /** Recalibrate the threshold every N adds (default 200). */
  recalibrateEvery: number;
}

export const DEFAULT_NOVELTY_CONFIG: NoveltyConfig = {
  k: 10,
  cap: 5000,
  minRef: 100,
  recalibrateEvery: 200,
};

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export class NoveltyIndex {
  private cfg: NoveltyConfig;
  private ref: Float32Array[] = [];
  private addsSinceCalibrate = 0;
  /** Calibrated novelty threshold; above it → "ask". null until calibrated. */
  private _threshold: number | null = null;

  constructor(config: Partial<NoveltyConfig> = {}) {
    this.cfg = { ...DEFAULT_NOVELTY_CONFIG, ...config };
  }

  get size(): number {
    return this.ref.length;
  }

  get enabled(): boolean {
    return this.ref.length >= this.cfg.minRef;
  }

  get threshold(): number | null {
    return this._threshold;
  }

  /** Restore a persisted threshold (e.g. from the calibration table). */
  setThreshold(t: number | null): void {
    this._threshold = t;
  }

  /** Bulk-load reference embeddings (normalized, most-recent-capped). */
  load(embeddings: Float32Array[]): void {
    const slice = embeddings.slice(-this.cfg.cap);
    this.ref = slice.map(normalize);
  }

  /** Top-k-mean cosine novelty for a query. null when the channel is disabled. */
  score(embedding: Float32Array): number | null {
    if (!this.enabled) return null;
    return this.noveltyOf(normalize(embedding), -1);
  }

  /** Append a situation to the reference (the habituation step). */
  add(embedding: Float32Array): void {
    this.ref.push(normalize(embedding));
    if (this.ref.length > this.cfg.cap) this.ref.shift();
    this.addsSinceCalibrate++;
    if (this.addsSinceCalibrate >= this.cfg.recalibrateEvery && this.enabled) {
      this.calibrate();
      this.addsSinceCalibrate = 0;
    }
  }

  /**
   * Recompute the threshold as the p95 of self-novelty over a sample (leave-one
   * -out: the query's own nearest neighbour — itself — is dropped). Returns the
   * new threshold, or null if disabled.
   */
  calibrate(): number | null {
    if (!this.enabled) {
      this._threshold = null;
      return null;
    }
    const n = this.ref.length;
    const nQuery = Math.min(300, n);
    const step = Math.max(1, Math.floor(n / nQuery));
    const scores: number[] = [];
    for (let i = 0; i < n; i += step) {
      scores.push(this.noveltyOf(this.ref[i], i));
    }
    scores.sort((a, b) => a - b);
    const idx = Math.min(scores.length - 1, Math.floor(0.95 * scores.length));
    this._threshold = scores[idx];
    return this._threshold;
  }

  /**
   * Novelty of an already-normalized query. `selfIndex >= 0` drops the single
   * highest similarity (the query itself) for a leave-one-out estimate.
   * Reference is sub-sampled for cost control on large sets.
   */
  private noveltyOf(q: Float32Array, selfIndex: number): number {
    const n = this.ref.length;
    const sampleCap = 2000;
    const step = n > sampleCap ? Math.floor(n / sampleCap) : 1;
    // Track the top-k similarities with a small sorted insert.
    const k = this.cfg.k;
    const top: number[] = [];
    let droppedSelf = selfIndex < 0;
    for (let i = 0; i < n; i += step) {
      const r = this.ref[i];
      let dot = 0;
      for (let d = 0; d < q.length; d++) dot += q[d] * r[d];
      if (!droppedSelf && dot > 0.99999) {
        droppedSelf = true; // leave-one-out: skip the exact self match once
        continue;
      }
      if (top.length < k) {
        top.push(dot);
        if (top.length === k) top.sort((a, b) => a - b);
      } else if (dot > top[0]) {
        top[0] = dot;
        // re-sink the smallest
        let j = 0;
        while (j + 1 < k && top[j] > top[j + 1]) {
          const tmp = top[j];
          top[j] = top[j + 1];
          top[j + 1] = tmp;
          j++;
        }
      }
    }
    if (top.length === 0) return 1;
    let mean = 0;
    for (const s of top) mean += s;
    mean /= top.length;
    return 1 - mean;
  }
}
