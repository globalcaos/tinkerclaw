// ============================================================
// src/amygdala/runtime-hook.ts
// AmygdalaHook: wires into the OpenClaw action execution pipeline.
//
// WHERE TO INSERT:
//   In the action executor, AFTER parsing the action but BEFORE executing it.
//   Search for the function that dispatches tool calls:
//
//     grep -r "executeTool\|dispatchAction\|runTool" src/
//
//   Then add:
//
//     const hookResult = await amygdalaHook.evaluate(action, sessionCtx);
//     if (hookResult.blocked) return hookResult.response;
//     const result = await action.execute();
//     await amygdalaHook.recordOutcome(hookResult.evaluationId, actualOutcome);
// ============================================================

import { AmygdalaGate } from './gate.js';
import { EmbeddingPipeline, EmbeddingWindow } from './embedding.js';
import { buildSituation, serializeSituation } from './situation-template.js';
import { TrainingLog } from './training-log.js';
import { GitCache } from './git-cache.js';
import type {
  AmygdalaConfig,
  AmygdalaEvaluation,
  GateDecision,
} from './types.js';
import type { ActionRequest, SessionContext } from './situation-template.js';

// ── AEGIS integration ────────────────────────────────────────

/**
 * AEGIS (Absolute Ethical Guardrail and Immutable Safety) interface.
 *
 * AEGIS provides hard-coded rules that ALWAYS override AMYGDALA's learned
 * decisions. Even at Phase 4 (α=0.90), AEGIS retains absolute veto.
 *
 * AMYGDALA is probabilistic and learns from data.
 * AEGIS is deterministic and non-negotiable.
 *
 * The check runs:
 *   - PRE-check: short-circuit before expensive AMYGDALA inference
 *   - POST-check: override even if AMYGDALA said 'allow'
 */
export interface AegisResult {
  blocked: boolean;
  rule_id?: string;
  reason?: string;
}

export interface AegisChecker {
  check(action: ActionRequest, context: SessionContext): Promise<AegisResult>;
}

// ── Public result type ────────────────────────────────────────

export interface AmygdalaHookResult {
  /** Whether the action was blocked */
  blocked: boolean;
  /** Gate decision */
  decision: GateDecision;
  /** Database ID of the evaluation row (for later outcome recording) */
  evaluationId?: number;
  /**
   * Structured response to show the LLM when blocked.
   * Soft block: present to the LLM so it can ask the user.
   * Hard block: present to the LLM as a non-negotiable stop.
   */
  response?: {
    gate_decision: string;
    reason: string;
    user_action_required?: string;
  };
  /** Full evaluation result (may be null if AMYGDALA is disabled) */
  evaluation: AmygdalaEvaluation | null;
}

// ── AmygdalaHook ─────────────────────────────────────────────

export class AmygdalaHook {
  private gate: AmygdalaGate;
  private embedder: EmbeddingPipeline;
  private window: EmbeddingWindow;
  private trainingLog: TrainingLog;
  private gitCache: GitCache;
  private config: AmygdalaConfig;
  private aegis: AegisChecker | null;
  private initialized = false;

  constructor(config: AmygdalaConfig, aegis?: AegisChecker) {
    this.config = config;
    this.aegis = aegis ?? null;
    this.gate = new AmygdalaGate(config);
    this.embedder = new EmbeddingPipeline(config.embedding);
    this.window = new EmbeddingWindow(
      config.embedding.window_size,
      config.embedding.internal_dim,
    );
    this.trainingLog = new TrainingLog(config.training_log);
    this.gitCache = new GitCache(config.git_cache);
  }

  /**
   * Initialise all sub-systems.  Must be called once before evaluate().
   * Safe to call even when amygdala.enabled=false (no-ops cleanly).
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      // AEGIS still needs to work even when AMYGDALA is disabled.
      // No sub-system init needed for AEGIS (it's stateless per-call).
      return;
    }
    await Promise.all([
      this.gate.initialize(),
      this.embedder.initialize(),
      this.gitCache.start(),
      this.trainingLog.initialize(),
    ]);
    this.initialized = true;
  }

  /**
   * Main evaluation entry point. Called for every non-trivial action.
   *
   * Execution order:
   *   1. AEGIS pre-check (absolute rules, short-circuit if blocked)
   *   2. AMYGDALA evaluation (when enabled and initialized)
   *   3. AEGIS post-check (defence-in-depth: override AMYGDALA 'allow' if needed)
   *
   * AEGIS blocks are ABSOLUTE and NON-OVERRIDABLE.
   * AMYGDALA soft_block can be overridden by the user (logs as training data).
   * AMYGDALA hard_block can be appealed with explicit justification.
   */
  async evaluate(
    action: ActionRequest,
    context: SessionContext,
  ): Promise<AmygdalaHookResult> {
    // ── Step 1: AEGIS pre-check ──────────────────────────────
    if (this.aegis) {
      const aegisResult = await this.aegis.check(action, context);
      if (aegisResult.blocked) {
        return this.aegisBlockResult(aegisResult.rule_id, aegisResult.reason);
      }
    }

    // ── AMYGDALA disabled ────────────────────────────────────
    if (!this.config.enabled || !this.initialized) {
      return { blocked: false, decision: 'allow', evaluation: null };
    }

    // ── Step 2: AMYGDALA evaluation ──────────────────────────

    // 2a. Build situation template (async stat + git metadata)
    const situation = await buildSituation(
      action,
      context,
      this.config,
      this.gitCache,
      (text) => this.embedder.embed(text),
    );

    // 2b. Serialise to natural language
    const serialized = serializeSituation(situation);

    // 2c. Embed
    const embedding = await this.embedder.embed(serialized);

    // 2d. Gate evaluation
    const evaluation = await this.gate.evaluate(
      embedding,
      this.window,
      situation,
      serialized,
    );

    // 2e. Update temporal window with this embedding
    this.window.push(embedding);

    // ── Step 3: AEGIS post-check (defence-in-depth) ──────────
    // Catches the rare case where AMYGDALA says 'allow' but AEGIS would block.
    // Pre-check handles the common path; this is the safety net.
    if (this.aegis && evaluation.prudence.gate_decision === 'allow') {
      const aegisPost = await this.aegis.check(action, context);
      if (aegisPost.blocked) {
        // Log the AMYGDALA false-allow as training data
        await this.trainingLog.append({
          situation,
          serialized,
          embedding,
          prudence_output: evaluation.prudence,
          personality_output: evaluation.personality,
          gate_decision: 'hard_block', // Override
          timestamp: evaluation.evaluated_at,
          latency_ms: evaluation.latency_ms,
          outcome: 'severe_negative', // AEGIS block = failure mode
          alpha_prudence: this.config.trust.alpha_prudence,
          alpha_personality: this.config.trust.alpha_personality,
          phase: this.config.trust.phase,
        });
        return this.aegisBlockResult(aegisPost.rule_id, aegisPost.reason);
      }
    }

    // 2f. Log evaluation for training
    const evaluationId = await this.trainingLog.append({
      situation,
      serialized,
      embedding,
      prudence_output: evaluation.prudence,
      personality_output: evaluation.personality,
      gate_decision: evaluation.prudence.gate_decision,
      timestamp: evaluation.evaluated_at,
      latency_ms: evaluation.latency_ms,
      outcome: null, // Filled later by recordOutcome()
      alpha_prudence: this.config.trust.alpha_prudence,
      alpha_personality: this.config.trust.alpha_personality,
      phase: this.config.trust.phase,
    });

    // 2g. Return result
    const blocked = evaluation.prudence.gate_decision !== 'allow';
    const result: AmygdalaHookResult = {
      blocked,
      decision: evaluation.prudence.gate_decision,
      evaluationId,
      evaluation,
    };

    if (blocked) {
      const isSoft = evaluation.prudence.gate_decision === 'soft_block';
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
   * Call this after the action completes (or after user feedback arrives).
   *
   * @param evaluationId  Row ID from the evaluate() result
   * @param outcome       One of: 'positive', 'mild_negative', 'moderate_negative', 'severe_negative'
   * @param source        How the outcome was determined
   * @param weight        Training weight (1.0 for programmatic, 0.8 for LLM-labeled)
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
   *
   * When a user overrides a soft_block, AMYGDALA should learn from it.
   * Overrides of hard_blocks require explicit justification.
   *
   * @param evaluationId  Row ID of the evaluation being overridden
   * @param reason        User-provided justification
   */
  async logHumanOverride(
    evaluationId: number,
    reason: string,
  ): Promise<void> {
    await this.trainingLog.logOverride(evaluationId, reason);
    // Overrides are logged as mild positive (user was right that it was safe)
    // with reduced weight (we can't be sure until the 72h outcome window)
    await this.trainingLog.updateOutcome(
      evaluationId,
      'positive',
      'human_override',
      0.6,
    );
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

  // ── Private helpers ──────────────────────────────────────────

  private aegisBlockResult(
    rule_id?: string,
    reason?: string,
  ): AmygdalaHookResult {
    const ruleStr = rule_id ? `[${rule_id}]` : '';
    return {
      blocked: true,
      decision: 'hard_block',
      evaluation: null,
      response: {
        gate_decision: 'hard_block',
        reason: `AEGIS absolute rule ${ruleStr}: ${reason ?? 'safety rule violation'}`,
        user_action_required:
          'Action blocked by absolute safety rule. Cannot be overridden.',
      },
    };
  }
}
