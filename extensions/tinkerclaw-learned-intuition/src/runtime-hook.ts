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
import { decodePersonalityNudge } from "./personality-decoder.js";
import { evaluateRuleBased } from "./rule-based-gate.js";
import { buildSituation, serializeSituation } from "./situation-template.js";
import type { ActionRequest, SessionContext } from "./situation-template.js";
import { TrainingLog } from "./training-log.js";
import type {
  AmygdalaConfig,
  AmygdalaEvaluation,
  GateDecision,
  PersonalityNudge,
} from "./types.js";

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

  constructor(config: AmygdalaConfig, aegis?: AegisChecker) {
    this.config = config;
    this.aegis = aegis ?? null;
    this.gate = new AmygdalaGate(config);
    this.embedder = new EmbeddingPipeline(config.embedding);
    this.window = new EmbeddingWindow(config.embedding.window_size, config.embedding.internal_dim);
    this.trainingLog = new TrainingLog(config.training_log);
    this.gitCache = new GitCache(config.git_cache);
  }

  /** Whether the hook is using rule-based fallback instead of ONNX */
  get useRuleBasedFallback(): boolean {
    return this._useRuleBasedFallback;
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

    await Promise.all([
      this.gate.initialize(),
      this.embedder.initialize(),
      this.gitCache.start(),
      this.trainingLog.initialize(),
    ]);

    // Determine if we need to use rule-based fallback
    this._useRuleBasedFallback = !this.gate.onnxAvailable;
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
    // Step 1: AEGIS pre-check
    if (this.aegis) {
      const aegisResult = await this.aegis.check(action, context);
      if (aegisResult.blocked) {
        return this.aegisBlockResult(aegisResult.rule_id, aegisResult.reason);
      }
    }

    // AMYGDALA disabled
    if (!this.config.enabled || !this.initialized) {
      return { blocked: false, decision: "allow", evaluation: null, ruleBasedFallback: false };
    }

    // Step 1.5 (FORK 2026-06-10, Phase 0): read-only short-circuit. AEGIS already
    // ran above, so a credential read is still blocked; any OTHER unambiguous
    // local read carries no destructive risk and is allowed without invoking the
    // (currently over-flagging) learned gate.
    if (isReadOnlyTool(action.type)) {
      return { blocked: false, decision: "allow", evaluation: null, ruleBasedFallback: false };
    }

    // Step 2: Rule-based fallback when ONNX unavailable
    if (this._useRuleBasedFallback) {
      return this.evaluateRuleBased(action);
    }

    // Step 2 (ONNX path): Full AMYGDALA evaluation
    return this.evaluateOnnx(action, context);
  }

  /**
   * Rule-based evaluation (ONNX not available).
   */
  private async evaluateRuleBased(action: ActionRequest): Promise<AmygdalaHookResult> {
    const argsStr = action.metadata ? JSON.stringify(action.metadata) : action.target;
    const ruleResult = evaluateRuleBased(action.type, argsStr);

    return {
      blocked: ruleResult.decision !== "allow",
      decision: ruleResult.decision,
      evaluation: null,
      ruleBasedFallback: true,
      response:
        ruleResult.decision !== "allow"
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
    const result: AmygdalaHookResult = {
      blocked,
      decision: evaluation.prudence.gate_decision,
      evaluationId: evaluationId >= 0 ? evaluationId : undefined,
      evaluation,
      personalityNudge,
      ruleBasedFallback: false,
    };

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
      response: {
        gate_decision: "hard_block",
        reason: `AEGIS absolute rule ${ruleStr}: ${reason ?? "safety rule violation"}`,
        user_action_required: "Action blocked by absolute safety rule. Cannot be overridden.",
      },
    };
  }
}
