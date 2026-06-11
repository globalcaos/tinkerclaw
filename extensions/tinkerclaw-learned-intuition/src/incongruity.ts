/**
 * FORK: AMYGDALA v3.1 — intra-prompt incongruity (the "ask, don't guess" signal).
 *
 * Validated offline at AUROC 0.896 on a transfer set of purpose-mismatch anchors
 * ("build a chess game so I can water my plants") vs coherent multi-intent
 * lookalikes — and the WINNING mechanism is the zero-train clause-cosine
 * baseline (a trained head scored only 0.701 and was discarded). So: segment a
 * request at its purpose connective, embed the action clause and the purpose
 * clause, and if their cosine is low the two halves do not cohere → the safe
 * move is to ASK, not guess.
 *
 * Pure logic: the caller supplies the two clause embeddings (from the shared
 * MiniLM embedder). This is the dispatch-seam gut-check; it never blocks.
 *
 * Calibration (from the validated anchor set): incongruous action↔purpose pairs
 * sit at cosine ≈ 0.03, coherent ones at ≈ 0.23; threshold 0.11 gives TPR 1.0 /
 * FPR 0.17 on the anchors. Kept deliberately conservative (low threshold) so a
 * coherent request is almost never flagged.
 */

/**
 * Purpose connectives that separate an action clause from its rationale. Matches
 * the validated E3 connective set (AUROC 0.896): purpose ("so I can", "so that",
 * "in order to"), cause ("because"), and sequence ("and then").
 */
const PURPOSE_CONNECTIVES =
  /\s+(?:so (?:i|we|you) can|so that|so as to|so we can|in order to|so i could|and then|because|para que|porque|a fin de)\s+/i;

export const DEFAULT_INCONGRUITY_THRESHOLD = 0.11;

export interface ClauseSplit {
  head: string;
  tail: string;
}

/**
 * Split a request at its first purpose connective. Returns null when there is no
 * connective or either side is too short to carry meaning (so we never flag a
 * single-intent prompt).
 */
export function segmentByPurpose(text: string): ClauseSplit | null {
  if (!text) return null;
  const m = PURPOSE_CONNECTIVES.exec(text);
  if (!m || m.index <= 0) return null;
  const head = text.slice(0, m.index).trim();
  const tail = text.slice(m.index + m[0].length).trim();
  if (head.split(/\s+/).length < 3 || tail.split(/\s+/).length < 3) return null;
  return { head, tail };
}

/** Cosine similarity of two vectors (defensive normalization). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

export interface IncongruityVerdict {
  /** cosine(head, tail); low = the halves do not cohere. */
  similarity: number;
  /** true → recommend asking a clarifying question (never a block). */
  incongruous: boolean;
}

/** Judge two clause embeddings against the calibrated threshold. */
export function judgeIncongruity(
  headEmb: Float32Array,
  tailEmb: Float32Array,
  threshold: number = DEFAULT_INCONGRUITY_THRESHOLD,
): IncongruityVerdict {
  const similarity = cosine(headEmb, tailEmb);
  return { similarity, incongruous: similarity < threshold };
}
