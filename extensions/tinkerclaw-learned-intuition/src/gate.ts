/**
 * FORK: AmygdalaGate -- ONNX inference engine for 10 neural networks.
 *
 * Loads all 10 ONNX models (5 Prudence + 5 Personality), runs parallel
 * inference, applies conformal prediction and trust ramp, and produces
 * a final gate decision per situation.
 *
 * Gracefully handles missing ONNX runtime or missing model files --
 * falls back to neutral outputs (effectively pass-through).
 */

// onnxruntime-node is loaded lazily so this module can be imported
// in test environments where the native addon is not installed.
type OrtModule = typeof import("onnxruntime-node");
let _ort: OrtModule | null = null;
async function loadOrt(): Promise<OrtModule | null> {
  if (_ort) {
    return _ort;
  }
  try {
    _ort = (await import("onnxruntime-node")) as OrtModule;
    return _ort;
  } catch (err) {
    // FORK 2026-05-30: surface WHY the runtime failed to import (was silent → hid
    // the 1.26.0 regression). If this fires, onnxruntime-node itself didn't load
    // (e.g. device-discovery throwing under systemd), so the gate can't be onnx.
    console.error(
      `[learned-intuition] onnxruntime-node import failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return null;
  }
}

import type { EmbeddingWindow } from "./embedding.js";
import type {
  AmygdalaConfig,
  AmygdalaEvaluation,
  GateDecision,
  PrudenceOutput,
  PrudenceEnsembleOutput,
  PersonalityOutput,
  PersonalityEnsembleOutput,
  SituationTemplate,
} from "./types.js";

const ARCH_KEYS = ["a", "b", "c", "d", "e"] as const;
type ArchKey = (typeof ARCH_KEYS)[number];

/** Fallback PrudenceOutput used when a model fails or is not loaded */
const NEUTRAL_PRUDENCE: PrudenceOutput = {
  gate_probabilities: { stop: 0.1, allow: 0.8, escalate: 0.1 },
  confidence: 0.5,
  ambiguity_score: 0.5,
};

const NEUTRAL_PERSONALITY: PersonalityOutput = {
  behaviour_embedding: new Float32Array(64).fill(0),
};

/**
 * AmygdalaGate: runs all 10 ONNX models and returns a full AmygdalaEvaluation.
 *
 * Lifecycle:
 *   const gate = new AmygdalaGate(config);
 *   await gate.initialize();   // loads ONNX sessions
 *   const eval = await gate.evaluate(embedding, window, situation, serialized);
 *   await gate.dispose();      // releases ONNX sessions
 */
export class AmygdalaGate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private prudenceSessions: Map<ArchKey, any> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private personalitySessions: Map<ArchKey, any> = new Map();
  private config: AmygdalaConfig;
  private _onnxAvailable = false;

  // Per-network calibration quantiles: [q_safe, q_needs_review, q_dangerous]
  private conformalQuantiles: Map<ArchKey, [number, number, number]> = new Map();

  // Per-network calibration quality score in [0, 1]
  private calibrationQuality: Map<ArchKey, number> = new Map();

  constructor(config: AmygdalaConfig) {
    this.config = config;
    for (const key of ARCH_KEYS) {
      this.conformalQuantiles.set(key, [0.9, 0.9, 0.9]);
      this.calibrationQuality.set(key, 1.0);
    }
  }

  /** Whether any ONNX models were successfully loaded */
  get onnxAvailable(): boolean {
    return this._onnxAvailable;
  }

  // -- Lifecycle --

  /**
   * Load all 10 ONNX models. Missing model files are silently skipped;
   * fallback neutral outputs are used for those networks.
   * If onnxruntime-node is not available, gate runs in stub mode (all fallbacks).
   */
  async initialize(): Promise<void> {
    const ort = await loadOrt();
    if (!ort) {
      // onnxruntime-node not installed -- gate runs in stub mode
      return;
    }

    const opts: import("onnxruntime-node").InferenceSession.SessionOptions = {
      // FORK 2026-05-30: onnxruntime-node uses SHORT EP names ('cpu'/'cuda'),
      // NOT the C++ long names. Passing "CPUExecutionProvider" made
      // InferenceSession.create throw "backend not found" → onnxAvailable was
      // permanently false → the gate could never leave rule-based fallback even
      // with the runtime installed. CPU is ample for these small nets and skips
      // the noisy GPU-device probing.
      executionProviders: ["cpu"],
    };

    for (const key of ARCH_KEYS) {
      // Prudence
      try {
        const pPath = this.config.prudence.model_paths[key];
        this.prudenceSessions.set(key, await ort.InferenceSession.create(pPath, opts));
        this._onnxAvailable = true;
      } catch (err) {
        // FORK 2026-05-30: was a SILENT catch — which hid the onnxruntime-node 1.26.0
        // regression (gate fell to rule-based with no explained reason). d/e have no
        // trained full-weight model (expected); a/b/c failing is a real problem worth
        // surfacing to the devtools console.
        console.error(
          `[learned-intuition] prudence '${key}' load failed (${this.config.prudence.model_paths[key]}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Personality
      try {
        const iPath = this.config.personality.model_paths[key];
        this.personalitySessions.set(key, await ort.InferenceSession.create(iPath, opts));
        this._onnxAvailable = true;
      } catch (err) {
        console.error(
          `[learned-intuition] personality '${key}' load failed (${this.config.personality.model_paths[key]}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async dispose(): Promise<void> {
    for (const session of this.prudenceSessions.values()) {
      await session.release();
    }
    for (const session of this.personalitySessions.values()) {
      await session.release();
    }
    this.prudenceSessions.clear();
    this.personalitySessions.clear();
    this._onnxAvailable = false;
  }

  // -- Public API --

  /**
   * Full AMYGDALA evaluation pipeline.
   */
  async evaluate(
    embedding: Float32Array,
    window: EmbeddingWindow,
    situation: SituationTemplate,
    serialized: string,
  ): Promise<AmygdalaEvaluation> {
    const t0 = performance.now();
    const K = this.config.embedding.window_size;
    const dim = this.config.embedding.internal_dim;

    const sequence = window.getSequence();

    // Step 1: Parallel Prudence inference
    const prudencePromises = ARCH_KEYS.map((key) =>
      this.runPrudence(key, embedding, sequence, K, dim),
    );
    const prudenceResults = await Promise.all(prudencePromises);

    const prudenceByArch = Object.fromEntries(
      ARCH_KEYS.map((k, i) => [k, prudenceResults[i]]),
    ) as Record<ArchKey, PrudenceOutput>;

    // Step 2: Meta-learner weighted average
    const combined = this.combinePrudence(prudenceByArch);

    // Step 3: Conformal prediction
    const predictionSet = this.conformalPredict(prudenceByArch);

    // Step 4: Ensemble disagreement
    const confidences = prudenceResults.map((r) => r.confidence);
    const meanConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const ensembleDisagreement = Math.sqrt(
      confidences.reduce((s, c) => s + (c - meanConf) ** 2, 0) / confidences.length,
    );

    // Step 5+6+7: Trust ramp + Conservative override + Decision
    const gateDecision = this.determineGate(
      combined,
      predictionSet,
      prudenceByArch,
      ensembleDisagreement,
    );

    const explanation = this.generateExplanation(
      gateDecision,
      combined,
      predictionSet,
      ensembleDisagreement,
      situation,
    );

    const prudenceOutput: PrudenceEnsembleOutput = {
      per_architecture: {
        a_gru_mlp: prudenceByArch.a,
        b_tcn: prudenceByArch.b,
        c_transformer: prudenceByArch.c,
        d_dual_encoder: prudenceByArch.d,
        e_ensemble_mlp: prudenceByArch.e,
      },
      combined,
      gate_decision: gateDecision,
      prediction_set: predictionSet,
      ensemble_disagreement: ensembleDisagreement,
      explanation,
    };

    // Step 8: Parallel Personality inference
    const personalityPromises = ARCH_KEYS.map((key) =>
      this.runPersonality(key, embedding, sequence, K, dim),
    );
    const personalityResults = await Promise.all(personalityPromises);

    const personalityByArch = Object.fromEntries(
      ARCH_KEYS.map((k, i) => [k, personalityResults[i]]),
    ) as Record<ArchKey, PersonalityOutput>;

    // Step 9: Personality combination
    const combinedPersonality = this.combinePersonality(personalityByArch);

    const personalityOutput: PersonalityEnsembleOutput = {
      per_architecture: {
        a_gru_mlp: personalityByArch.a,
        b_tcn: personalityByArch.b,
        c_transformer: personalityByArch.c,
        d_dual_encoder: personalityByArch.d,
        e_ensemble_mlp: personalityByArch.e,
      },
      combined_embedding: combinedPersonality,
    };

    return {
      situation,
      serialized,
      embedding,
      prudence: prudenceOutput,
      personality: personalityOutput,
      evaluated_at: new Date().toISOString(),
      latency_ms: performance.now() - t0,
    };
  }

  // -- Calibration updates --

  updateConformalQuantiles(quantiles: Map<ArchKey, [number, number, number]>): void {
    for (const [key, q] of quantiles) {
      this.conformalQuantiles.set(key, q);
    }
  }

  updateCalibrationQuality(quality: Map<ArchKey, number>): void {
    for (const [key, q] of quality) {
      this.calibrationQuality.set(key, q);
    }
  }

  // -- Private inference helpers --

  private async runPrudence(
    key: ArchKey,
    current: Float32Array,
    sequence: Float32Array,
    K: number,
    dim: number,
  ): Promise<PrudenceOutput> {
    const session = this.prudenceSessions.get(key);
    if (!session) {
      return { ...NEUTRAL_PRUDENCE };
    }

    const ort = await loadOrt();
    if (!ort) {
      return { ...NEUTRAL_PRUDENCE };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;

      if (key === "e") {
        const input = new ort.Tensor("float32", current, [1, dim]);
        result = await session.run({ current: input });
      } else if (key === "d") {
        const context = sequence.subarray(0, (K - 1) * dim);
        const ctxTensor = new ort.Tensor("float32", context, [1, K - 1, dim]);
        const curTensor = new ort.Tensor("float32", current, [1, dim]);
        result = await session.run({ context: ctxTensor, current: curTensor });
      } else {
        const fullSeq = new Float32Array(K * dim);
        fullSeq.set(sequence.subarray(dim), 0);
        fullSeq.set(current, (K - 1) * dim);
        const input = new ort.Tensor("float32", fullSeq, [1, K, dim]);
        result = await session.run({ sequence: input });
      }

      return this.parsePrudenceOutput(result);
    } catch {
      return { ...NEUTRAL_PRUDENCE };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parsePrudenceOutput(result: any): PrudenceOutput {
    const gate = result["gate_probabilities"]?.data as Float32Array | undefined;
    const conf = result["confidence"]?.data as Float32Array | undefined;
    const amb = result["ambiguity"]?.data as Float32Array | undefined;

    if (!gate || !conf || !amb) {
      return { ...NEUTRAL_PRUDENCE };
    }

    return {
      gate_probabilities: {
        stop: gate[0] ?? 0.1,
        allow: gate[1] ?? 0.8,
        escalate: gate[2] ?? 0.1,
      },
      confidence: conf[0] ?? 0.5,
      ambiguity_score: amb[0] ?? 0.5,
    };
  }

  private async runPersonality(
    key: ArchKey,
    current: Float32Array,
    sequence: Float32Array,
    K: number,
    dim: number,
  ): Promise<PersonalityOutput> {
    const session = this.personalitySessions.get(key);
    if (!session) {
      return { ...NEUTRAL_PERSONALITY };
    }

    const ort = await loadOrt();
    if (!ort) {
      return { ...NEUTRAL_PERSONALITY };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;

      if (key === "e") {
        const input = new ort.Tensor("float32", current, [1, dim]);
        result = await session.run({ current: input });
      } else if (key === "d") {
        const context = sequence.subarray(0, (K - 1) * dim);
        const ctxTensor = new ort.Tensor("float32", context, [1, K - 1, dim]);
        const curTensor = new ort.Tensor("float32", current, [1, dim]);
        result = await session.run({ context: ctxTensor, current: curTensor });
      } else {
        const fullSeq = new Float32Array(K * dim);
        fullSeq.set(sequence.subarray(dim), 0);
        fullSeq.set(current, (K - 1) * dim);
        const input = new ort.Tensor("float32", fullSeq, [1, K, dim]);
        result = await session.run({ sequence: input });
      }

      const emb = result["behaviour_embedding"]?.data as Float32Array | undefined;
      if (!emb) {
        return { ...NEUTRAL_PERSONALITY };
      }
      return { behaviour_embedding: new Float32Array(emb) };
    } catch {
      return { ...NEUTRAL_PERSONALITY };
    }
  }

  // -- Ensemble combination --

  private combinePrudence(byArch: Record<ArchKey, PrudenceOutput>): PrudenceOutput {
    const w = this.config.prudence.meta_weights;

    let stopSum = 0,
      allowSum = 0,
      escalateSum = 0,
      confSum = 0,
      ambSum = 0,
      wSum = 0;

    for (let i = 0; i < 5; i++) {
      const key = ARCH_KEYS[i];
      const out = byArch[key];
      stopSum += w[i] * out.gate_probabilities.stop;
      allowSum += w[i] * out.gate_probabilities.allow;
      escalateSum += w[i] * out.gate_probabilities.escalate;
      confSum += w[i] * out.confidence;
      ambSum += w[i] * out.ambiguity_score;
      wSum += w[i];
    }

    const denom = wSum || 1;
    return {
      gate_probabilities: {
        stop: stopSum / denom,
        allow: allowSum / denom,
        escalate: escalateSum / denom,
      },
      confidence: confSum / denom,
      ambiguity_score: ambSum / denom,
    };
  }

  private combinePersonality(byArch: Record<ArchKey, PersonalityOutput>): Float32Array {
    const w = this.config.personality.meta_weights;
    const dim = this.config.personality.embedding_dim;
    const result = new Float32Array(dim);
    let wSum = 0;

    for (let i = 0; i < 5; i++) {
      const emb = byArch[ARCH_KEYS[i]].behaviour_embedding;
      for (let d = 0; d < dim; d++) {
        result[d] += w[i] * (emb[d] ?? 0);
      }
      wSum += w[i];
    }

    const denom = wSum || 1;
    for (let d = 0; d < dim; d++) {
      result[d] /= denom;
    }
    return result;
  }

  // -- Conformal prediction --

  private conformalPredict(
    byArch: Record<ArchKey, PrudenceOutput>,
  ): Array<"safe" | "needs-review" | "dangerous"> {
    const outcomes = ["safe", "needs-review", "dangerous"] as const;
    const predictionSet = new Set<"safe" | "needs-review" | "dangerous">();

    let anyDangerous = false;

    for (const key of ARCH_KEYS) {
      const quality = this.calibrationQuality.get(key) ?? 1.0;
      const quantiles = this.conformalQuantiles.get(key) ?? [0.9, 0.9, 0.9];
      const out = byArch[key];

      const probs = [
        out.gate_probabilities.allow,
        out.gate_probabilities.escalate,
        out.gate_probabilities.stop,
      ];

      const dangNonConf = 1 - probs[2];
      if (dangNonConf <= quantiles[2]) {
        anyDangerous = true;
      }

      if (quality < 0.5) {
        continue;
      }

      for (let j = 0; j < 3; j++) {
        const nonconformity = 1 - probs[j];
        if (nonconformity <= quantiles[j]) {
          predictionSet.add(outcomes[j]);
        }
      }
    }

    if (anyDangerous) {
      predictionSet.add("dangerous");
    }

    if (predictionSet.size === 0) {
      predictionSet.add("needs-review");
    }

    return Array.from(predictionSet);
  }

  // -- Gate decision --

  private determineGate(
    combined: PrudenceOutput,
    predictionSet: Array<"safe" | "needs-review" | "dangerous">,
    byArch: Record<ArchKey, PrudenceOutput>,
    disagreement: number,
  ): GateDecision {
    const alpha = this.config.trust.alpha_prudence;
    const overrideThreshold = this.config.prudence.conservative_override_threshold;

    // 1. Conservative override
    for (const key of ARCH_KEYS) {
      const out = byArch[key];
      if (out.gate_probabilities.stop > overrideThreshold && out.confidence > overrideThreshold) {
        return "hard_block";
      }
    }

    // 2. 'dangerous' in prediction set
    if (predictionSet.includes("dangerous")) {
      if (combined.gate_probabilities.stop > 0.7 && combined.confidence > 0.7) {
        return "hard_block";
      }
      return "soft_block";
    }

    // 3. Ambiguous prediction set
    if (predictionSet.length > 1) {
      return "soft_block";
    }

    // 4. High ensemble disagreement
    if (disagreement > this.config.prudence.disagreement_threshold) {
      return "soft_block";
    }

    // 5. High ambiguity score
    if (combined.ambiguity_score > 0.6) {
      return "soft_block";
    }

    // 6. Trust ramp
    const effectiveStop = alpha * combined.gate_probabilities.stop;
    const effectiveEscalate = alpha * combined.gate_probabilities.escalate;

    if (effectiveStop > 0.5) {
      return "hard_block";
    }
    if (effectiveEscalate > 0.3) {
      return "soft_block";
    }

    return "allow";
  }

  // -- Explanation generation --

  private generateExplanation(
    decision: GateDecision,
    combined: PrudenceOutput,
    predictionSet: Array<string>,
    disagreement: number,
    situation: SituationTemplate,
  ): string {
    if (decision === "allow") {
      return `Action allowed. Confidence: ${(combined.confidence * 100).toFixed(0)}%.`;
    }

    const reasons: string[] = [];

    if (situation.target_metadata.recent_commits > 3) {
      reasons.push(`${situation.target_metadata.recent_commits} recent commits on target`);
    }
    if (situation.target_metadata.effort_hours > 2) {
      reasons.push(`~${situation.target_metadata.effort_hours.toFixed(1)}h effort invested`);
    }
    if (situation.context.topic_drift > 0.5) {
      reasons.push(`high topic drift (${situation.context.topic_drift.toFixed(2)})`);
    }
    if (situation.scope.blast_radius === "external") {
      reasons.push("external blast radius");
    }
    if (situation.scope.reversible === "false") {
      reasons.push("irreversible action");
    }
    if (!situation.scope.human_in_loop) {
      reasons.push("no human in loop");
    }
    if (disagreement > 0.2) {
      reasons.push(`high ensemble disagreement (${disagreement.toFixed(2)})`);
    }
    if (predictionSet.length > 1) {
      reasons.push(`ambiguous prediction set: {${predictionSet.join(", ")}}`);
    }

    const blockType = decision === "hard_block" ? "BLOCKED" : "REVIEW REQUIRED";
    return (
      `${blockType}: ${situation.action_type} ${situation.target_type} ` +
      `"${situation.target_id}". ` +
      `Reasons: ${reasons.length > 0 ? reasons.join("; ") : "elevated risk signal"}. ` +
      `Confidence: ${(combined.confidence * 100).toFixed(0)}%.`
    );
  }
}
