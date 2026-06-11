/**
 * FORK: AmygdalaHook -- main evaluation pipeline for Learned Intuition.
 *
 * Wires into the action execution pipeline. Evaluates every tool call
 * through the ONNX gate (or rule-based fallback), logs to training DB,
 * and generates personality nudges.
 *
 * Self-contained: no imports from upstream src/.
 */

import { EmbeddingPipeline, EmbeddingWindow } from "./embedding.js";
import { AmygdalaGate } from "./gate.js";
import { GitCache } from "./git-cache.js";
import { NoveltyIndex } from "./novelty.js";
import { decodePersonalityNudge } from "./personality-decoder.js";
import { evaluateRuleBased } from "./rule-based-gate.js";
import { buildSituation, serializeSituation } from "./situation-template.js";
import type { ActionRequest, SessionContext } from "./situation-template.js";
import { TrainingLog } from "./training-log.js";
import type {
  AmygdalaConfig,
  AmygdalaEvaluation,
  Disposition,
  AmygdalaSignal,
  GateDecision,
  PersonalityNudge,
} from "./types.js";

/** Calibration key for the persisted novelty threshold. */
const NOVELTY_THRESHOLD_KEY = "novelty_threshold";

// -- Read-only short-circuit --

// FORK 2026-06-10 (Phase 0): unambiguous LOCAL read-only tools cannot cause a
// destructive side effect, so they short-circuit to "allow" in evaluate()
// WITHOUT waking the neural gate (which, while uncalibrated, soft-blocked 100%
// of actions — including plain file reads). AEGIS rule checks still run first in
// evaluate(), so reading a credential file is still hard-blocked. Conservative
// on purpose: Bash is NOT listed (it can `rm -rf`), and external calls
// (WebFetch/WebSearch) are excluded since they are not pure local reads.
const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "ls", "notebookread", "toolsearch"]);

/** Whether a tool name is an unambiguous local read-only operation. */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName.trim().toLowerCase());
}

// -- AEGIS integration --

export interface AegisResult {
  blocked: boolean;
  rule_id?: string;
  reason?: string;
}

export interface AegisChecker {
  check(action: ActionRequest, context: SessionContext): Promise<AegisResult>;
}

// -- Public result type --

export interface AmygdalaHookResult {
  /** Whether the action was blocked */
  blocked: boolean;
  /** Gate decision */
  decision: GateDecision;
  /** Database ID of the evaluation row (for later outcome recording) */
  evaluationId?: number;
  /**
   * Structured response to show the LLM when blocked.
   */
  response?: {
    gate_decision: string;
    reason: string;
    user_action_required?: string;
  };
  /** Full evaluation result (may be null if AMYGDALA is disabled or in rule-based mode) */
  evaluation: AmygdalaEvaluation | null;
  /** Personality modulation nudge -- inject into next prompt turn */
  personalityNudge?: PersonalityNudge;
  /** Whether rule-based fallback was used instead of ONNX */
  ruleBasedFallback: boolean;
  /** v3.1: novelty score (1 − top-k cosine to history); null when disabled. */
  novelty?: number | null;
  /** v3.1: what experience says to do (proceed | ask | block). */
  disposition?: Disposition;
  /** v3.1: which salience channel drove the decision. */
  signal?: AmygdalaSignal;
}

// -- AmygdalaHook --

export class AmygdalaHook {
  private gate: AmygdalaGate;
  private embedder: EmbeddingPipeline;
  private window: EmbeddingWindow;
  private trainingLog: TrainingLog;
  private gitCache: GitCache;
  private config: AmygdalaConfig;
  private aegis: AegisChecker | null;
  private initialized = false;
  private _useRuleBasedFallback = false;
  /** v3.1 novelty channel (k-NN over situation history). */
  private novelty: NoveltyIndex | null = null;
  /** v3.1: whether the legacy 5-net ONNX ensemble runs in the decision path. */
  private readonly legacyEnsemble: boolean;
  private noveltyAdds = 0;

  constructor(config: AmygdalaConfig, aegis?: AegisChecker) {
    this.config = config;
    this.aegis = aegis ?? null;
    this.legacyEnsemble = config.legacyEnsemble === true;
    this.gate = new AmygdalaGate(config);
    this.embedder = new EmbeddingPipeline(config.embedding);
    this.window = new EmbeddingWindow(config.embedding.window_size, config.embedding.internal_dim);
    this.trainingLog = new TrainingLog(config.training_log);
    this.gitCache = new GitCache(config.git_cache);
    if (config.novelty?.enabled !== false) {
      this.novelty = new NoveltyIndex(config.novelty);
    }
  }

  /** Whether the hook is using rule-based fallback instead of ONNX */
  get useRuleBasedFallback(): boolean {
    return this._useRuleBasedFallback;
  }

  /** v3.1: novelty channel status for logging / the feed. */
  get noveltyStatus(): { enabled: boolean; size: number; threshold: number | null } {
    return {
      enabled: this.novelty?.enabled ?? false,
      size: this.novelty?.size ?? 0,
      threshold: this.novelty?.threshold ?? null,
    };
  }

  /** FORK 2026-05-30: gate load errors, surfaced so index.ts can log the REAL onnx
   * failure via the structured logger (console.error here is not captured). */
  get gateLoadErrors(): string[] {
    return this.gate.loadErrors;
  }

  /**
   * Initialise all sub-systems. Must be called once before evaluate().
   * If ONNX is not available, falls back to rule-based gate.
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // v3.1: the legacy 5-net ONNX ensemble only loads when explicitly enabled.
    // The embedder (encoder + projection) is ALWAYS loaded — the novelty channel
    // needs the situation embedding even though the prudence nets are retired.
    const tasks: Array<Promise<unknown>> = [
      this.embedder.initialize(),
      this.gitCache.start(),
      this.trainingLog.initialize(),
    ];
    if (this.legacyEnsemble) {
      tasks.push(this.gate.initialize());
    }
    await Promise.all(tasks);

    // Rule-based "fallback" only applies to the legacy path: it is the ONNX-gate
    // substitute. In the v3.1 default path AEGIS + novelty are the decision, so
    // useRuleBasedFallback stays false (we are not falling back, we redesigned).
    this._useRuleBasedFallback = this.legacyEnsemble && !this.gate.onnxAvailable;

    // Bootstrap the novelty reference from the situation history, restore a
    // persisted threshold (or calibrate fresh).
    if (this.novelty) {
      try {
        const cap = this.config.novelty?.cap ?? 5000;
        const refs = this.trainingLog.getRecentEmbeddings(cap, this.config.embedding.internal_dim);
        this.novelty.load(refs);
        const persisted = this.trainingLog.getCalibration(NOVELTY_THRESHOLD_KEY);
        if (persisted !== null) {
          this.novelty.setThreshold(persisted);
        } else if (this.novelty.enabled) {
          const t = this.novelty.calibrate();
          if (t !== null) this.trainingLog.setCalibration(NOVELTY_THRESHOLD_KEY, t);
        }
      } catch {
        // Novelty is best-effort; a load failure must not break the gate.
        this.novelty = this.novelty;
      }
    }

    this.initialized = true;
  }

  /**
   * Main evaluation entry point. Called for every non-trivial action.
   *
   * Execution order:
   *   1. AEGIS pre-check (absolute rules, short-circuit if blocked)
   *   2. Rule-based gate OR AMYGDALA ONNX evaluation
   *   3. AEGIS post-check (defence-in-depth)
   */
  async evaluate(action: ActionRequest, context: SessionContext): Promise<AmygdalaHookResult> {
    // Step 1: AEGIS pre-check — the deterministic hard floor (disposition: block).
    if (this.aegis) {
      const aegisResult = await this.aegis.check(action, context);
      if (aegisResult.blocked) {
        return this.aegisBlockResult(aegisResult.rule_id, aegisResult.reason);
      }
    }

    // AMYGDALA disabled
    if (!this.config.enabled || !this.initialized) {
      return this.allowResult(null);
    }

    // Step 1.5 (FORK 2026-06-10, Phase 0): read-only short-circuit. AEGIS already
    // ran above, so a credential read is still seen; any OTHER unambiguous local
    // read carries no destructive risk and is allowed without scoring novelty.
    if (isReadOnlyTool(action.type)) {
      return this.allowResult(null);
    }

    // Step 2: legacy ONNX ensemble path (only when explicitly enabled).
    if (this.legacyEnsemble) {
      if (this._useRuleBasedFallback) {
        return this.evaluateRuleBased(action);
      }
      return this.evaluateOnnx(action, context);
    }

    // Step 2 (v3.1 default): the novelty channel — "have I seen this before?".
    return this.evaluateNovelty(action, context);
  }

  /** v3.1 novelty path: score unfamiliarity, ask when above threshold, habituate. */
  private async evaluateNovelty(
    action: ActionRequest,
    context: SessionContext,
  ): Promise<AmygdalaHookResult> {
    const started = Date.now();
    let embedding: Float32Array | null = null;
    let serialized = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let situation: any = null;
    try {
      situation = await buildSituation(action, context, this.config, this.gitCache, (text) =>
        this.embedder.embed(text),
      );
      serialized = serializeSituation(situation);
      embedding = await this.embedder.embed(serialized);
    } catch {
      // Embedding failed — allow, novelty unknown.
      return this.allowResult(null);
    }

    const noveltyScore = this.novelty ? this.novelty.score(embedding) : null;
    const threshold = this.novelty?.threshold ?? null;
    const isNovel = noveltyScore !== null && threshold !== null && noveltyScore > threshold;

    const decision: GateDecision = isNovel ? "soft_block" : "allow";
    const disposition: Disposition = isNovel ? "ask" : "proceed";
    const signal: AmygdalaSignal = isNovel ? "novelty" : "none";

    // Log the situation (the row also extends the novelty reference offline).
    const evaluationId = await this.trainingLog.append({
      situation,
      serialized,
      embedding,
      prudence_output: null,
      personality_output: null,
      gate_decision: decision,
      timestamp: new Date().toISOString(),
      latency_ms: Date.now() - started,
      outcome: null,
      alpha_prudence: this.config.trust.alpha_prudence,
      alpha_personality: this.config.trust.alpha_personality,
      phase: this.config.trust.phase,
      novelty: noveltyScore,
      disposition,
      signal,
    });

    // Habituation: this situation is now part of "normal". Persist the threshold
    // when the periodic recalibration fires.
    if (this.novelty) {
      const before = this.novelty.threshold;
      this.novelty.add(embedding);
      this.noveltyAdds++;
      const after = this.novelty.threshold;
      if (after !== null && after !== before) {
        this.trainingLog.setCalibration(NOVELTY_THRESHOLD_KEY, after);
      }
    }

    const result: AmygdalaHookResult = {
      blocked: isNovel,
      decision,
      evaluationId: evaluationId >= 0 ? evaluationId : undefined,
      evaluation: null,
      ruleBasedFallback: false,
      novelty: noveltyScore,
      disposition,
      signal,
    };
    if (isNovel) {
      result.response = {
        gate_decision: decision,
        reason:
          `Unfamiliar situation (novelty ${noveltyScore?.toFixed(3)} vs threshold ` +
          `${threshold?.toFixed(3)}). Would ask before acting.`,
        user_action_required: `This looks unlike past situations — consider confirming ${action.type} on "${action.target}".`,
      };
    }
    return result;
  }

  /** Standard allow with v3.1 disposition fields. */
  private allowResult(novelty: number | null): AmygdalaHookResult {
    return {
      blocked: false,
      decision: "allow",
      evaluation: null,
      ruleBasedFallback: false,
      novelty,
      disposition: "proceed",
      signal: "none",
    };
  }

  /**
   * Rule-based evaluation (ONNX not available).
   */
  private async evaluateRuleBased(action: ActionRequest): Promise<AmygdalaHookResult> {
    const argsStr = action.metadata ? JSON.stringify(action.metadata) : action.target;
    const ruleResult = evaluateRuleBased(action.type, argsStr);

    const blocked = ruleResult.decision !== "allow";
    return {
      blocked,
      decision: ruleResult.decision,
      evaluation: null,
      ruleBasedFallback: true,
      novelty: null,
      disposition: blocked ? "block" : "proceed",
      signal: blocked ? "aegis" : "none",
      response: blocked
        ? {
            gate_decision: ruleResult.decision,
            reason: ruleResult.explanation,
            user_action_required: "Action blocked by rule-based safety gate.",
          }
        : undefined,
    };
  }

  /**
   * Full ONNX-based evaluation.
   */
  private async evaluateOnnx(
    action: ActionRequest,
    context: SessionContext,
  ): Promise<AmygdalaHookResult> {
    // Build situation template
    const situation = await buildSituation(action, context, this.config, this.gitCache, (text) =>
      this.embedder.embed(text),
    );

    const serialized = serializeSituation(situation);
    const embedding = await this.embedder.embed(serialized);
    const evaluation = await this.gate.evaluate(embedding, this.window, situation, serialized);

    this.window.push(embedding);

    // AEGIS post-check
    if (this.aegis && evaluation.prudence.gate_decision === "allow") {
      const aegisPost = await this.aegis.check(action, context);
      if (aegisPost.blocked) {
        await this.trainingLog.append({
          situation,
          serialized,
          embedding,
          prudence_output: evaluation.prudence,
          personality_output: evaluation.personality,
          gate_decision: "hard_block",
          timestamp: evaluation.evaluated_at,
          latency_ms: evaluation.latency_ms,
          outcome: "severe_negative",
          alpha_prudence: this.config.trust.alpha_prudence,
          alpha_personality: this.config.trust.alpha_personality,
          phase: this.config.trust.phase,
        });
        return this.aegisBlockResult(aegisPost.rule_id, aegisPost.reason);
      }
    }

    // Log evaluation for training
    const evaluationId = await this.trainingLog.append({
      situation,
      serialized,
      embedding,
      prudence_output: evaluation.prudence,
      personality_output: evaluation.personality,
      gate_decision: evaluation.prudence.gate_decision,
      timestamp: evaluation.evaluated_at,
      latency_ms: evaluation.latency_ms,
      outcome: null,
      alpha_prudence: this.config.trust.alpha_prudence,
      alpha_personality: this.config.trust.alpha_personality,
      phase: this.config.trust.phase,
    });

    // Compute personality nudge
    const targetVector = this.config.personality.target_vector;
    let personalityNudge: PersonalityNudge | undefined;
    if (targetVector.length > 0) {
      personalityNudge = decodePersonalityNudge(
        evaluation.personality.combined_embedding,
        targetVector,
        this.config.trust.alpha_personality,
      );
    }

    const blocked = evaluation.prudence.gate_decision !== "allow";
    // v3.1: surface novelty + a disposition even on the legacy path for parity.
    const noveltyScore = this.novelty ? this.novelty.score(embedding) : null;
    const disposition: Disposition =
      evaluation.prudence.gate_decision === "hard_block"
        ? "block"
        : evaluation.prudence.gate_decision === "soft_block"
          ? "ask"
          : "proceed";
    const result: AmygdalaHookResult = {
      blocked,
      decision: evaluation.prudence.gate_decision,
      evaluationId: evaluationId >= 0 ? evaluationId : undefined,
      evaluation,
      personalityNudge,
      ruleBasedFallback: false,
      novelty: noveltyScore,
      disposition,
      signal: blocked ? "aegis" : "none",
    };
    if (this.novelty) this.novelty.add(embedding);

    if (blocked) {
      const isSoft = evaluation.prudence.gate_decision === "soft_block";
      result.response = {
        gate_decision: evaluation.prudence.gate_decision,
        reason: evaluation.prudence.explanation,
        user_action_required: isSoft
          ? `Please confirm: ${action.type} on "${action.target}". Type CONFIRM to proceed or CANCEL to abort.`
          : `Action hard-blocked. To override, provide an explicit justification.`,
      };
    }

    return result;
  }

  /**
   * Record the outcome of a previous evaluation.
   */
  async recordOutcome(
    evaluationId: number,
    outcome: string,
    source: string,
    weight = 1.0,
  ): Promise<void> {
    await this.trainingLog.updateOutcome(evaluationId, outcome, source, weight);
  }

  /**
   * Log a human override of a blocked action as training data.
   */
  async logHumanOverride(evaluationId: number, reason: string): Promise<void> {
    await this.trainingLog.logOverride(evaluationId, reason);
    await this.trainingLog.updateOutcome(evaluationId, "positive", "human_override", 0.6);
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.gate.dispose(),
      this.embedder.dispose(),
      this.gitCache.stop(),
      this.trainingLog.close(),
    ]);
    this.initialized = false;
  }

  // -- Private helpers --

  private aegisBlockResult(rule_id?: string, reason?: string): AmygdalaHookResult {
    const ruleStr = rule_id ? `[${rule_id}]` : "";
    return {
      blocked: true,
      decision: "hard_block",
      evaluation: null,
      ruleBasedFallback: false,
      novelty: null,
      disposition: "block",
      signal: "aegis",
      response: {
        gate_decision: "hard_block",
        reason: `AEGIS absolute rule ${ruleStr}: ${reason ?? "safety rule violation"}`,
        user_action_required: "Action blocked by absolute safety rule. Cannot be overridden.",
      },
    };
  }
}
