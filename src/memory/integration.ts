/**
 * Phase 8: Cognitive Orchestrator — wires ENGRAM + CORTEX + LIMBIC + SYNAPSE.
 *
 * Coordinates all 4 subsystems for a single conversational turn.
 * Each subsystem is feature-flag isolated and fails gracefully.
 */

import type { MemoryEvent, EventKind } from "./engram/event-types.js";
import type { EventStore } from "./engram/event-store.js";
import { estimateTokens } from "./engram/event-store.js";
import type { MetricsCollector } from "./engram/metrics.js";
import { buildPushPack, type ContextPack } from "./engram/push-pack.js";
import { runPointerCompaction, estimateCacheTokens, type ContextCache, type CompactionBudgets } from "./engram/pointer-compaction.js";
import { createDefaultTaskState, updateTaskState, type TaskState } from "./engram/task-state.js";
import type { EmbeddingWorker } from "./engram/embedding-worker.js";

import type { PersonaState } from "./cortex/persona-state.js";
import { createDefaultPersonaState, loadLatestPersonaState, savePersonaState } from "./cortex/persona-state.js";
import { getScheduledProbes, runAllScheduledProbes, loadProbeResults, type ProbeLLMFn, type ProbeResult } from "./cortex/behavioral-probes.js";
import { createDriftState, computeDriftScore, detectUserCorrections, type DriftState, type DriftScore } from "./cortex/drift-detection.js";
import { injectPersonaState, type InjectionResult } from "./cortex/priority-injection.js";

import { detectSensitiveCategories, computeSensitivityScore, type AudienceModel, type SensitivityResult } from "./limbic/sensitivity-gate.js";
import type { HumorAssociation } from "./limbic/humor-associations.js";

import { createPersistentDeliberation, type PersistentDeliberation, type DebateConclusion } from "./synapse/persistent-deliberation.js";
import type { ArchitectureResult } from "./synapse/debate-architectures.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CognitiveConfig {
	engram: { enabled: boolean; compactionMode: "engram" | "narrative" };
	cortex: { enabled: boolean; probeIntervalTurns: number };
	limbic: { enabled: boolean; humorFrequency: number };
	synapse: { enabled: boolean; autoDebateOnSevereDrift: boolean };
}

export const DEFAULT_COGNITIVE_CONFIG: CognitiveConfig = {
	engram: { enabled: true, compactionMode: "engram" },
	cortex: { enabled: true, probeIntervalTurns: 5 },
	limbic: { enabled: true, humorFrequency: 0.15 },
	synapse: { enabled: true, autoDebateOnSevereDrift: true },
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface TurnMetrics {
	turnNumber: number;
	totalMs: number;
	engramMs: number;
	cortexMs: number;
	limbicMs: number;
	synapseMs: number;
	errors: Array<{ subsystem: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Dependencies (injected)
// ---------------------------------------------------------------------------

export interface CognitiveOrchestratorDeps {
	eventStore: EventStore;
	metrics: MetricsCollector;
	config?: Partial<CognitiveConfig>;
	/** Optional LLM function for probes. If absent, probes are skipped. */
	probeLLMFn?: ProbeLLMFn;
	/** Optional embedding worker. If absent, embeddings are skipped. */
	embeddingWorker?: EmbeddingWorker;
	/** Optional audience model for humor gating. */
	audienceModel?: AudienceModel;
	/** Optional debate runner for SYNAPSE. */
	runDebateFn?: (task: string) => Promise<ArchitectureResult>;
	/** Context window size in tokens. */
	contextWindow?: number;
	/** System prompt. */
	systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class CognitiveOrchestrator {
	private readonly config: CognitiveConfig;
	private readonly store: EventStore;
	private readonly metrics: MetricsCollector;
	private readonly probeLLMFn?: ProbeLLMFn;
	private readonly embeddingWorker?: EmbeddingWorker;
	private readonly audienceModel?: AudienceModel;
	private readonly runDebateFn?: (task: string) => Promise<ArchitectureResult>;
	private readonly contextWindow: number;
	private readonly systemPrompt: string;

	private turnNumber = 0;
	private personaState: PersonaState;
	private taskState: TaskState;
	private driftState: DriftState;
	private contextCache: ContextCache;
	private deliberation?: PersistentDeliberation;
	private turnMetricsHistory: TurnMetrics[] = [];
	private errorCounts: Record<string, number> = { engram: 0, cortex: 0, limbic: 0, synapse: 0 };

	constructor(deps: CognitiveOrchestratorDeps) {
		const cfg = deps.config ?? {};
		this.config = {
			engram: { ...DEFAULT_COGNITIVE_CONFIG.engram, ...cfg.engram },
			cortex: { ...DEFAULT_COGNITIVE_CONFIG.cortex, ...cfg.cortex },
			limbic: { ...DEFAULT_COGNITIVE_CONFIG.limbic, ...cfg.limbic },
			synapse: { ...DEFAULT_COGNITIVE_CONFIG.synapse, ...cfg.synapse },
		};
		this.store = deps.eventStore;
		this.metrics = deps.metrics;
		this.probeLLMFn = deps.probeLLMFn;
		this.embeddingWorker = deps.embeddingWorker;
		this.audienceModel = deps.audienceModel;
		this.runDebateFn = deps.runDebateFn;
		this.contextWindow = deps.contextWindow ?? 128_000;
		this.systemPrompt = deps.systemPrompt ?? "You are a helpful assistant.";

		// Initialize subsystem state (graceful: if store is broken, use defaults)
		let loaded: PersonaState | null = null;
		try { loaded = loadLatestPersonaState(this.store); } catch { /* store may be broken */ }
		this.personaState = loaded ?? createDefaultPersonaState("Assistant", "A helpful AI assistant.");
		this.taskState = createDefaultTaskState();
		this.driftState = createDriftState();
		this.contextCache = { events: [], markers: [] };

		if (this.config.synapse.enabled) {
			this.deliberation = createPersistentDeliberation({ eventStore: this.store, metrics: this.metrics });
		}
	}

	// ── Public API ──

	/**
	 * Pre-turn: build the push pack for the LLM call.
	 * Call this before sending to the model.
	 */
	async buildPushPack(userMessage: string): Promise<{ pack: ContextPack; injections: string[] }> {
		this.turnNumber++;
		const turnMetrics: TurnMetrics = {
			turnNumber: this.turnNumber,
			totalMs: 0, engramMs: 0, cortexMs: 0, limbicMs: 0, synapseMs: 0, errors: [],
		};
		const start = performance.now();
		const injections: string[] = [];

		// ENGRAM: store user message
		let userEvent: MemoryEvent | undefined;
		if (this.config.engram.enabled) {
			const t0 = performance.now();
			try {
				userEvent = this.store.append({
					turnId: this.turnNumber,
					sessionKey: this.store.sessionKey,
					kind: "user_message",
					content: userMessage,
					tokens: estimateTokens(userMessage),
					metadata: {},
				});
				this.contextCache.events.push(userEvent);
			} catch (err) {
				this.recordError(turnMetrics, "engram", err);
			}
			turnMetrics.engramMs += performance.now() - t0;
		}

		// CORTEX: detect user corrections for drift
		if (this.config.cortex.enabled) {
			const t0 = performance.now();
			try {
				const corrections = detectUserCorrections(userMessage);
				this.driftState.userCorrectionWindow.push(corrections.length > 0);
				if (this.driftState.userCorrectionWindow.length > 20) {
					this.driftState.userCorrectionWindow.shift();
				}
			} catch (err) {
				this.recordError(turnMetrics, "cortex", err);
			}
			turnMetrics.cortexMs += performance.now() - t0;
		}

		// CORTEX: compute drift and inject reinforcement if needed
		if (this.config.cortex.enabled) {
			const t0 = performance.now();
			try {
				const probeResults = loadProbeResults(this.store, 10);
				const driftScore = computeDriftScore(this.driftState, this.turnNumber, probeResults);

				if (driftScore.ewmaScore > 0.5) {
					const severity = driftScore.ewmaScore > 0.75 ? "severe" : "moderate";
					injections.push(`[DRIFT ${severity.toUpperCase()}: score=${driftScore.ewmaScore.toFixed(2)}. Reinforce persona identity and voice.]`);
					this.metrics.record("cortex", "drift_injection", driftScore.ewmaScore, { severity });

					// SYNAPSE: trigger debate on severe drift
					if (severity === "severe" && this.config.synapse.enabled && this.config.synapse.autoDebateOnSevereDrift && this.runDebateFn) {
						const t1 = performance.now();
						try {
							const result = await this.runDebateFn("Correction strategy for severe persona drift");
							if (this.deliberation) {
								this.deliberation.storeConclusion({
									debateId: `drift-${this.turnNumber}`,
									task: "persona drift correction",
									architecture: "fan-out",
									finalSynthesis: result.output,
									participantModels: [],
									rounds: result.rounds,
									converged: true,
									totalCost: result.totalEstimatedCost,
									timestamp: new Date().toISOString(),
									metadata: { trigger: "severe_drift", turnNumber: this.turnNumber },
								});
							}
							injections.push(`[SYNAPSE correction: ${result.output}]`);
						} catch (err) {
							this.recordError(turnMetrics, "synapse", err);
						}
						turnMetrics.synapseMs += performance.now() - t1;
					}
				}
			} catch (err) {
				this.recordError(turnMetrics, "cortex", err);
			}
			turnMetrics.cortexMs += performance.now() - t0;
		}

		// LIMBIC: check humor opportunity
		if (this.config.limbic.enabled) {
			const t0 = performance.now();
			try {
				const sensitivity = computeSensitivityScore(userMessage, this.audienceModel);
				const humorThreshold = this.personaState.humor?.sensitivityThreshold ?? 0.5;
				if (sensitivity < humorThreshold && Math.random() < this.config.limbic.humorFrequency) {
					injections.push("[LIMBIC: humor opportunity detected — consider light humor if appropriate]");
					this.metrics.record("limbic", "humor_opportunity", 1);
				}
			} catch (err) {
				this.recordError(turnMetrics, "limbic", err);
			}
			turnMetrics.limbicMs += performance.now() - t0;
		}

		// ENGRAM: build push pack
		let pack: ContextPack;
		if (this.config.engram.enabled) {
			const t0 = performance.now();
			try {
				const systemWithInjections = injections.length > 0
					? `${this.systemPrompt}\n\n${injections.join("\n")}`
					: this.systemPrompt;

				pack = buildPushPack({
					systemPrompt: systemWithInjections,
					userMessage,
					taskState: this.taskState,
					recentTail: this.contextCache.events.slice(-20),
					markers: this.contextCache.markers,
					contextWindow: this.contextWindow,
				});
			} catch (err) {
				this.recordError(turnMetrics, "engram", err);
				// Fallback minimal pack
				pack = {
					blocks: [{ role: "system", content: this.systemPrompt, label: "system", tokens: estimateTokens(this.systemPrompt) },
						{ role: "user", content: userMessage, label: "user", tokens: estimateTokens(userMessage) }],
					totalTokens: estimateTokens(this.systemPrompt + userMessage),
					budgetUsed: {},
				};
			}
			turnMetrics.engramMs += performance.now() - t0;
		} else {
			pack = {
				blocks: [{ role: "system", content: this.systemPrompt, label: "system", tokens: estimateTokens(this.systemPrompt) },
					{ role: "user", content: userMessage, label: "user", tokens: estimateTokens(userMessage) }],
				totalTokens: estimateTokens(this.systemPrompt + userMessage),
				budgetUsed: {},
			};
		}

		turnMetrics.totalMs = performance.now() - start;
		this.turnMetricsHistory.push(turnMetrics);
		this.recordTurnMetrics(turnMetrics);

		return { pack, injections };
	}

	/**
	 * Post-turn: process the LLM response through all subsystems.
	 * Call this after receiving the model's response.
	 */
	async processResponse(response: string): Promise<TurnMetrics> {
		const turnMetrics: TurnMetrics = {
			turnNumber: this.turnNumber,
			totalMs: 0, engramMs: 0, cortexMs: 0, limbicMs: 0, synapseMs: 0, errors: [],
		};
		const start = performance.now();

		// ENGRAM: store response event
		if (this.config.engram.enabled) {
			const t0 = performance.now();
			try {
				const event = this.store.append({
					turnId: this.turnNumber,
					sessionKey: this.store.sessionKey,
					kind: "agent_message",
					content: response,
					tokens: estimateTokens(response),
					metadata: {},
				});
				this.contextCache.events.push(event);

				// Trigger async embedding
				if (this.embeddingWorker) {
					this.embeddingWorker.enqueue(event);
				}
			} catch (err) {
				this.recordError(turnMetrics, "engram", err);
			}
			turnMetrics.engramMs += performance.now() - t0;
		}

		// CORTEX: run scheduled probes (async, non-blocking)
		if (this.config.cortex.enabled && this.probeLLMFn) {
			const t0 = performance.now();
			try {
				const scheduledTypes = getScheduledProbes(this.turnNumber);
				if (scheduledTypes.length > 0) {
					// Run probes — results are stored directly in the event store
					const results = await runAllScheduledProbes(
						response,
						this.personaState,
						this.turnNumber,
						this.probeLLMFn,
						this.store,
					);
					for (const r of results) {
						this.metrics.record("cortex", `probe_${r.probeType}`, r.scores.overall ?? 1.0, {
							violations: r.violations.length,
						});
					}
				}
			} catch (err) {
				this.recordError(turnMetrics, "cortex", err);
			}
			turnMetrics.cortexMs += performance.now() - t0;
		}

		// LIMBIC: store humor associations if response contains humor
		if (this.config.limbic.enabled) {
			const t0 = performance.now();
			try {
				// Simple heuristic: if response has humor markers, store association
				const humorMarkers = /😂|😄|😆|🤣|haha|lol|joke|pun|funny/i;
				if (humorMarkers.test(response)) {
					this.store.append({
						turnId: this.turnNumber,
						sessionKey: this.store.sessionKey,
						kind: "humor_association",
						content: JSON.stringify({ turn: this.turnNumber, snippet: response.slice(0, 200) }),
						tokens: estimateTokens(response.slice(0, 200)),
						metadata: { tags: ["humor", "auto-detected"] },
					});
					this.metrics.record("limbic", "humor_landed", 1);
				}
			} catch (err) {
				this.recordError(turnMetrics, "limbic", err);
			}
			turnMetrics.limbicMs += performance.now() - t0;
		}

		// ENGRAM: pointer compaction if approaching context limit
		if (this.config.engram.enabled) {
			const t0 = performance.now();
			try {
				const cacheTokens = estimateCacheTokens(this.contextCache);
				const threshold = this.contextWindow * 0.8;
				if (cacheTokens > threshold) {
					const budgets: CompactionBudgets = {
						ctx: this.contextWindow,
						headroom: Math.floor(this.contextWindow * 0.1),
						hotTailTurns: 4,
						markerSoftCap: 10,
					};
					this.contextCache = runPointerCompaction(this.contextCache, budgets, this.metrics);
					this.metrics.record("engram", "compaction_triggered", cacheTokens);
				}
			} catch (err) {
				this.recordError(turnMetrics, "engram", err);
			}
			turnMetrics.engramMs += performance.now() - t0;
		}

		turnMetrics.totalMs = performance.now() - start;
		this.turnMetricsHistory.push(turnMetrics);
		this.recordTurnMetrics(turnMetrics);

		return turnMetrics;
	}

	// ── Accessors ──

	getTurnNumber(): number { return this.turnNumber; }
	getPersonaState(): PersonaState { return this.personaState; }
	getTaskState(): TaskState { return this.taskState; }
	getDriftState(): DriftState { return this.driftState; }
	getConfig(): CognitiveConfig { return this.config; }
	getTurnMetricsHistory(): TurnMetrics[] { return [...this.turnMetricsHistory]; }
	getErrorCounts(): Record<string, number> { return { ...this.errorCounts }; }

	// ── Private ──

	private recordError(turnMetrics: TurnMetrics, subsystem: string, err: unknown): void {
		const msg = err instanceof Error ? err.message : String(err);
		turnMetrics.errors.push({ subsystem, error: msg });
		this.errorCounts[subsystem] = (this.errorCounts[subsystem] ?? 0) + 1;
		this.metrics.record(subsystem, "error", 1, { message: msg });
	}

	private recordTurnMetrics(tm: TurnMetrics): void {
		this.metrics.record("orchestrator", "turn_total_ms", tm.totalMs, { turn: tm.turnNumber });
		if (tm.engramMs > 0) this.metrics.record("engram", "turn_ms", tm.engramMs, { turn: tm.turnNumber });
		if (tm.cortexMs > 0) this.metrics.record("cortex", "turn_ms", tm.cortexMs, { turn: tm.turnNumber });
		if (tm.limbicMs > 0) this.metrics.record("limbic", "turn_ms", tm.limbicMs, { turn: tm.turnNumber });
		if (tm.synapseMs > 0) this.metrics.record("synapse", "turn_ms", tm.synapseMs, { turn: tm.turnNumber });
	}
}
