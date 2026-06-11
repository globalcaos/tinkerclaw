/**
 * FORK: Type definitions for the AMYGDALA Learned Intuition system.
 *
 * All TypeScript interfaces for situation templates, gate decisions,
 * prudence/personality ensemble outputs, and configuration.
 * Self-contained — no external dependencies.
 */

/** All possible action types AMYGDALA evaluates */
export type ActionType =
  | "overwrite"
  | "delete"
  | "send"
  | "merge"
  | "create"
  | "modify"
  | "execute"
  | "deploy"
  | "revert"
  | "move"
  | "copy";

/** Classification of the target being acted upon */
export type TargetType =
  | "file"
  | "email"
  | "message"
  | "database"
  | "api_call"
  | "git_operation"
  | "system_command"
  | "configuration"
  | "deployment";

/** Reversibility classification */
export type Reversibility = "true" | "false" | "partial";

/** Blast radius classification */
export type BlastRadius = "self" | "session" | "persistent" | "external";

/** Confirmation level */
export type ConfirmationLevel = "none" | "soft" | "hard";

/** Emotional signal classification */
export type EmotionalSignal =
  | "calm"
  | "frustrated"
  | "excited"
  | "focused"
  | "playful"
  | "terse"
  | "unknown";

/** Slot source marker for audit */
export type SlotSource = "programmatic" | "llm_estimated";

/** Metadata about the target of the action */
export interface TargetMetadata {
  /** Hours since target was created/last modified. Source: stat(). */
  age_hours: number;
  /** Size in bytes (files), lines (code), or records (database). Source: stat()/wc. */
  size: number;
  /** Commits touching this target in last 72h. Source: git log. */
  recent_commits: number;
  /** Distinct authors in recent commits. Source: git log. */
  recent_authors: number;
  /** Estimated human+agent hours invested recently. Source: LLM estimate, 0.3x weight. */
  effort_hours: number;
  /** Hours since the human last mentioned/discussed this target. Source: transcript search. */
  last_human_ref: number;
}

/** Contextual information about the current session */
export interface SituationContext {
  /** What the current session is about. Source: LLM estimate, 0.3x weight. */
  session_topic: string;
  /** User corrections in last 24h. Source: runtime counter. */
  recent_corrections: number;
  /** Detected user emotional state. Source: LLM estimate, 0.3x weight. */
  emotional_signals: EmotionalSignal;
  /** Levels of automation between human and this action. Source: stack depth. */
  automation_depth: number;
  /** Cosine distance between conversation topic centroid and action target embedding.
   *  Computed deterministically: 1 - cos(e_topic, e_action). Source: programmatic. */
  topic_drift: number;
}

/** Scope of the proposed action */
export interface ActionScope {
  /** Whether the action can be undone. Source: lookup table. */
  reversible: Reversibility;
  /** How far the action's effects reach. Source: lookup table. */
  blast_radius: BlastRadius;
  /** Whether a human is in the confirmation loop. Source: runtime flag. */
  human_in_loop: boolean;
  /** What level of confirmation is configured. Source: runtime flag. */
  confirmation: ConfirmationLevel;
}

/**
 * Complete situation template for AMYGDALA evaluation.
 * 16 slots total: 13 programmatic (P), 3 LLM-estimated (L).
 * LLM-estimated slots receive 0.3x training weight.
 */
export interface SituationTemplate {
  /** The type of action being proposed. Source: P */
  action_type: ActionType;
  /** The type of target being acted upon. Source: P (lookup) */
  target_type: TargetType;
  /** Identifier for the target (filepath, recipient, table name, etc.). Source: P */
  target_id: string;
  /** Metadata about the target. Mixed P/L sources. */
  target_metadata: TargetMetadata;
  /** Session context. Mixed P/L sources. */
  context: SituationContext;
  /** Action scope assessment. Source: P */
  scope: ActionScope;
  /** Timestamp when this template was created. Source: P */
  timestamp: string; // ISO 8601
  /** Source audit: which slots were programmatic vs LLM-estimated */
  _slot_sources?: Record<string, SlotSource>;
}

/** Gate decision from Prudence ensemble */
export type GateDecision = "allow" | "soft_block" | "hard_block";

/**
 * v3.1 action disposition — what experience says to do. Decoupled from the
 * legacy GateDecision enum (kept for schema compat): a novelty "ask" maps to
 * gate_decision "soft_block" + disposition "ask"; AEGIS maps to "hard_block" +
 * "block"; an allow maps to "allow" + "proceed".
 */
export type Disposition = "proceed" | "ask" | "block";

/** v3.1 salience channel that drove the disposition. */
export type AmygdalaSignal = "aegis" | "novelty" | "incongruity" | "none";

/** Output from a single Prudence network */
export interface PrudenceOutput {
  /** Three-way classification: stop, allow, escalate */
  gate_probabilities: {
    stop: number; // probability in [0,1]
    allow: number; // probability in [0,1]
    escalate: number; // probability in [0,1]
  };
  /** How certain is the decision? Sigmoid in [0,1] */
  confidence: number;
  /** How ambiguous is the situation? Sigmoid in [0,1] */
  ambiguity_score: number;
}

/** Output from a single Personality network */
export interface PersonalityOutput {
  /** Continuous behavioural modulation vector in R^64 */
  behaviour_embedding: Float32Array;
}

/** Output from the full Prudence ensemble (5 architectures) */
export interface PrudenceEnsembleOutput {
  /** Per-architecture outputs */
  per_architecture: {
    a_gru_mlp: PrudenceOutput;
    b_tcn: PrudenceOutput;
    c_transformer: PrudenceOutput;
    d_dual_encoder: PrudenceOutput;
    e_ensemble_mlp: PrudenceOutput;
  };
  /** Meta-learner combined output */
  combined: PrudenceOutput;
  /** Final gate decision after trust ramp */
  gate_decision: GateDecision;
  /** Conformal prediction set */
  prediction_set: Array<"safe" | "needs-review" | "dangerous">;
  /** Ensemble disagreement (std of confidences) */
  ensemble_disagreement: number;
  /** Human-readable explanation for the decision */
  explanation: string;
}

/** Personality modulation nudge -- injected into prompt pipeline */
export interface PersonalityNudge {
  /** Human-readable behavioral adjustments (e.g. "Increase humor -- you're drifting formal") */
  adjustments: string[];
  /** Raw delta vector: target - current, per dimension */
  delta: Float32Array;
  /** Strength of nudge in [0, 1] based on alpha_personality */
  strength: number;
}

/** Output from the full Personality ensemble (5 architectures) */
export interface PersonalityEnsembleOutput {
  /** Per-architecture outputs */
  per_architecture: {
    a_gru_mlp: PersonalityOutput;
    b_tcn: PersonalityOutput;
    c_transformer: PersonalityOutput;
    d_dual_encoder: PersonalityOutput;
    e_ensemble_mlp: PersonalityOutput;
  };
  /** Meta-learner combined output */
  combined_embedding: Float32Array;
}

/** Complete AMYGDALA evaluation result */
export interface AmygdalaEvaluation {
  /** The situation that was evaluated */
  situation: SituationTemplate;
  /** Serialized situation string (input to encoder) */
  serialized: string;
  /** 512d situation embedding */
  embedding: Float32Array;
  /** Prudence ensemble result */
  prudence: PrudenceEnsembleOutput;
  /** Personality ensemble result */
  personality: PersonalityEnsembleOutput;
  /** Timestamp of evaluation */
  evaluated_at: string;
  /** Evaluation latency in milliseconds */
  latency_ms: number;
}

/** Configuration for the AMYGDALA system */
export interface AmygdalaConfig {
  /** Master enable/disable switch */
  enabled: boolean;

  /**
   * v3.1: run the legacy 5-net ONNX prudence/personality ensemble in the
   * decision path. Default false — the ensemble was retired (trained on
   * mislabelled data, arch C collapsed, arch E mush; and frozen-MiniLM danger
   * classification measured below chance). The embedding pipeline is retained
   * for the novelty channel regardless of this flag.
   */
  legacyEnsemble?: boolean;

  /**
   * v3.1: write the pre-execution PreToolUse hook settings so cc-bridge /
   * claude-cli denies destructive-execution AEGIS rules synchronously. Default
   * true. When false the settings file is removed (observe-only spool only).
   */
  hookEnforcement?: boolean;

  /** v3.1: novelty channel configuration (k-NN over situation history). */
  novelty?: {
    enabled: boolean;
    k: number;
    cap: number;
    minRef: number;
    recalibrateEvery: number;
  };

  /** Trust ramp coefficients */
  trust: {
    /** Prudence trust coefficient alpha_P in [0, 1] */
    alpha_prudence: number;
    /** Personality trust coefficient alpha_I in [0, 1] */
    alpha_personality: number;
    /** Maximum alpha for current deployment phase */
    alpha_max: number;
    /** Minimum alpha (floor) */
    alpha_min: number;
    /** Current deployment phase (1-4) */
    phase: 1 | 2 | 3 | 4;
    /** Ramp learning rate eta */
    ramp_eta: number;
    /** Minimum acceptable reward rate r_threshold */
    reward_threshold: number;
  };

  /** Embedding configuration */
  embedding: {
    /** Path to sentence encoder ONNX model */
    encoder_model_path: string;
    /** Path to projection layer ONNX model */
    projection_model_path: string;
    /** Internal embedding dimension (default 512) */
    internal_dim: number;
    /** Input embedding dimension from encoder (e.g. 384 for MiniLM) */
    input_dim: number;
    /** Temporal window size K (default 32) */
    window_size: number;
  };

  /** Prudence ensemble configuration */
  prudence: {
    /** Paths to 5 ONNX models */
    model_paths: {
      a: string;
      b: string;
      c: string;
      d: string;
      e: string;
    };
    /** Meta-learner weights for combining architectures */
    meta_weights: [number, number, number, number, number];
    /** Conservative override threshold: if any architecture outputs stop
     *  with confidence above this, block regardless of ensemble */
    conservative_override_threshold: number;
    /** Ensemble disagreement threshold for auto-escalation */
    disagreement_threshold: number;
  };

  /** Personality ensemble configuration */
  personality: {
    /** Paths to 5 ONNX models */
    model_paths: {
      a: string;
      b: string;
      c: string;
      d: string;
      e: string;
    };
    /** Meta-learner weights */
    meta_weights: [number, number, number, number, number];
    /** Target personality vector (learned dimensions) */
    target_vector: number[];
    /** Behavioural embedding dimension (default 64) */
    embedding_dim: number;
  };

  /** Conformal prediction */
  conformal: {
    /** Significance level epsilon (default 0.05 for 95% coverage) */
    epsilon: number;
    /** Calibration window in days (default 30) */
    calibration_window_days: number;
    /** Path to calibration data SQLite */
    calibration_db_path: string;
  };

  /** Git cache configuration */
  git_cache: {
    /** Enable filesystem watchers */
    enabled: boolean;
    /** Directories to watch */
    watch_paths: string[];
    /** Cache TTL in seconds (fallback if watchers fail) */
    ttl_seconds: number;
  };

  /** Training log configuration */
  training_log: {
    /** Path to SQLite training log database */
    db_path: string;
    /** Maximum entries before rotation */
    max_entries: number;
    /** Rolling window in days */
    rolling_window_days: number;
  };

  /** Action type classification lookup */
  action_type_map: Record<string, ActionType>;

  /** Target type classification lookup */
  target_type_map: Record<string, TargetType>;

  /** Reversibility lookup by action_type + target_type */
  reversibility_map: Record<string, Reversibility>;

  /** Blast radius lookup by target_type */
  blast_radius_map: Record<TargetType, BlastRadius>;
}
