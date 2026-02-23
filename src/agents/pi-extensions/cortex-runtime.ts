/**
 * CORTEX Integration: Runtime persona state injection, SyncScore, and drift detection.
 *
 * Creates a CortexRuntime that:
 * - Loads PersonaState from SOUL.md + IDENTITY.md (or persona.json when present)
 * - Provides getPersonaBlock() for Tier 1 system prompt injection (cached)
 * - Evaluates SyncScore via computeConsistency with EWMA smoothing (α=0.1)
 * - Detects persona drift via computeDriftScore / detectUserCorrections
 * - Triggers re-injection when EWMA SyncScore < 0.6
 *
 * Registry pattern mirrors ingestion-runtime.ts / retrieval-runtime.ts.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import {
	createDefaultPersonaState,
	type PersonaState,
} from "../../memory/cortex/persona-state.js";
import { renderTier1A } from "../../memory/cortex/priority-injection.js";
import {
	computeConsistency,
	type ConsistencyResult,
} from "../../memory/cortex/consistency-metric.js";
import {
	computeDriftScore,
	createDriftState,
	detectUserCorrections,
	type DriftScore,
	type DriftState,
} from "../../memory/cortex/drift-detection.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// SyncScore EWMA smoothing factor (α)
export const SYNC_SCORE_ALPHA = 0.1;
// EWMA threshold below which drift re-injection is triggered
export const SYNC_SCORE_DRIFT_THRESHOLD = 0.6;

export interface CortexRuntimeOptions {
	/** Path to SOUL.md (persona description). Defaults to ~/.openclaw/SOUL.md */
	soulPath?: string;
	/** Path to IDENTITY.md (identity statement). Defaults to ~/.openclaw/IDENTITY.md */
	identityPath?: string;
	/** Override the resolved persona name. */
	name?: string;
	/** How many turns between SyncScore evaluations. Defaults to 10. */
	syncScoreInterval?: number;
}

/**
 * Result returned by evaluateSyncScore.
 */
export interface SyncScoreResult {
	/** Raw consistency metric C ∈ [0, 1] for this turn. */
	rawScore: number;
	/** EWMA-smoothed SyncScore ∈ [0, 1]. */
	ewmaScore: number;
	/** Whether drift re-injection should be triggered (ewmaScore < threshold). */
	needsReinjection: boolean;
	/** Turn number this evaluation ran on. */
	turnNumber: number;
	/** ISO timestamp. */
	timestamp: string;
	/** Underlying consistency breakdown. */
	consistency: ConsistencyResult;
}

export type DriftActionTier = "none" | "mild_reinforce" | "moderate_refresh" | "severe_rebase";

export interface DriftAssessment {
	score: DriftScore;
	isHostile: boolean;
	corrections: string[];
	action: DriftActionTier;
}

export interface CortexRuntime {
	/** Tier-1 persona block for system prompt injection. Cached after first call. */
	getPersonaBlock(): string;
	/**
	 * Evaluate SyncScore for the current turn.
	 *
	 * Runs every `syncScoreInterval` turns (default 10). Applies EWMA smoothing
	 * (α=0.1) and logs to ~/.openclaw/engram/sync-score-log.json (JSONL).
	 * Returns current EWMA score; sets needsReinjection when EWMA < 0.6.
	 *
	 * @param conversationMessages - Recent agent response strings for consistency analysis.
	 * @param turnNumber - Optional explicit turn number (auto-increments if omitted).
	 */
	evaluateSyncScore(conversationMessages: string[], turnNumber?: number): SyncScoreResult;
	/** Detect persona drift from recent messages (corrections + signals). */
	detectDrift(recentMessages: string[]): DriftAssessment;
	/** Current EWMA SyncScore ∈ [0, 1]. Starts at 1.0 (no data = assume healthy). */
	readonly ewmaSyncScore: number;
	/** Underlying PersonaState. */
	readonly persona: PersonaState;
}

// ---------------------------------------------------------------------------
// Markdown parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract persona name from the first H1/H2 heading ("# Persona: Name (v1)").
 */
function parseNameFromMarkdown(content: string): string {
	const match = content.match(/^#{1,2}\s+(?:Persona:\s*)?([^\n(]+)/m);
	if (match) {
		return match[1].trim().replace(/\s*\(v\d+\)$/, "").trim();
	}
	return "JarvisOne";
}

/**
 * Extract identity statement from "## Identity" section.
 */
function parseIdentityFromMarkdown(content: string): string {
	const match = content.match(/##\s+Identity\s*\n([\s\S]*?)(?:\n##|\s*$)/);
	if (match) {
		const body = match[1].trim();
		if (body) return body;
	}
	// Fallback: first non-heading, non-empty line
	const line = content
		.split("\n")
		.find((l) => l.trim() && !l.startsWith("#"));
	return line?.trim() ?? "AI assistant";
}

// ---------------------------------------------------------------------------
// Persona loader
// ---------------------------------------------------------------------------

const OPENCLAW_DIR = join(process.env.HOME ?? "~", ".openclaw");

function loadPersonaFromFiles(options: CortexRuntimeOptions): PersonaState {
	const soulPath = options.soulPath ?? join(OPENCLAW_DIR, "SOUL.md");
	const identityPath = options.identityPath ?? join(OPENCLAW_DIR, "IDENTITY.md");
	const personaJsonPath = join(OPENCLAW_DIR, "persona.json");

	// persona.json takes priority — already structured and validated
	if (existsSync(personaJsonPath)) {
		try {
			const raw = JSON.parse(readFileSync(personaJsonPath, "utf8")) as PersonaState;
			if (raw.name && raw.identityStatement && raw.version) {
				return raw;
			}
		} catch {
			// fall through to markdown parsing
		}
	}

	// engram/persona-state.json — auto-generated structured persona state (secondary fallback)
	const engramPersonaPath = join(OPENCLAW_DIR, "engram", "persona-state.json");
	if (existsSync(engramPersonaPath)) {
		try {
			const raw = JSON.parse(readFileSync(engramPersonaPath, "utf8")) as PersonaState;
			if (raw.name && raw.identityStatement && raw.version) {
				return raw;
			}
		} catch {
			// fall through to markdown parsing
		}
	}

	let name = options.name ?? "JarvisOne";
	let identity = "AI assistant and extension of the user";
	let soulContent = "";

	// Parse SOUL.md for name, identity, and voice markers
	if (existsSync(soulPath)) {
		soulContent = readFileSync(soulPath, "utf8");
		if (!options.name) {
			name = parseNameFromMarkdown(soulContent);
		}
		const embeddedIdentity = parseIdentityFromMarkdown(soulContent);
		if (embeddedIdentity) identity = embeddedIdentity;
	}

	// IDENTITY.md overrides the inline identity if it exists
	if (existsSync(identityPath)) {
		const identityContent = readFileSync(identityPath, "utf8").trim();
		if (identityContent) identity = identityContent;
	}

	const ps = createDefaultPersonaState(name, identity);

	// Parse voice markers from SOUL.md when available
	if (soulContent) {
		const sentLen = soulContent.match(/Avg sentence length:\s*(\d+)/i);
		if (sentLen) ps.voiceMarkers.avgSentenceLength = parseInt(sentLen[1], 10);

		const vocab = soulContent.match(/Vocabulary:\s*(casual|standard|technical|academic)/i);
		if (vocab) {
			ps.voiceMarkers.vocabularyTier =
				vocab[1].toLowerCase() as typeof ps.voiceMarkers.vocabularyTier;
		}

		const hedging = soulContent.match(/Hedging:\s*(never|rare|moderate|frequent)/i);
		if (hedging) {
			ps.voiceMarkers.hedgingLevel =
				hedging[1].toLowerCase() as typeof ps.voiceMarkers.hedgingLevel;
		}

		const emoji = soulContent.match(/Emoji:\s*(never|rare|moderate|frequent)/i);
		if (emoji) {
			ps.voiceMarkers.emojiUsage =
				emoji[1].toLowerCase() as typeof ps.voiceMarkers.emojiUsage;
		}

		const humorFreq = soulContent.match(/Frequency:\s*([\d.]+)/i);
		if (humorFreq) ps.humor.humorFrequency = parseFloat(humorFreq[1]);

		const sensitivity = soulContent.match(/Sensitivity:\s*([\d.]+)/i);
		if (sensitivity) ps.humor.sensitivityThreshold = parseFloat(sensitivity[1]);
	}

	return ps;
}

// ---------------------------------------------------------------------------
// Drift action from EWMA score
// ---------------------------------------------------------------------------

function actionFromEwma(ewmaScore: number): DriftActionTier {
	if (ewmaScore > 0.5) return "severe_rebase";
	if (ewmaScore > 0.3) return "moderate_refresh";
	if (ewmaScore > 0.1) return "mild_reinforce";
	return "none";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SyncScore logging
// ---------------------------------------------------------------------------

/**
 * Resolve the sync score log path at call time (not module load time)
 * so that HOME overrides in tests work correctly.
 */
function getSyncScoreLogPath(): string {
	const home = process.env.HOME ?? "~";
	return join(home, ".openclaw", "engram", "sync-score-log.json");
}

/**
 * Append a SyncScoreResult as a JSONL line to the sync score log.
 * Creates the engram directory if needed. Silently no-ops on I/O errors.
 */
function appendSyncScoreLog(entry: SyncScoreResult): void {
	try {
		const logPath = getSyncScoreLogPath();
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
	} catch {
		// Non-fatal: logging failures must not crash the runtime
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CortexRuntime from SOUL.md + IDENTITY.md (or persona.json).
 *
 * - `getPersonaBlock()` returns the Tier 1A immutable core block, cached.
 * - `evaluateSyncScore()` runs computeConsistency every syncScoreInterval turns,
 *   applies EWMA smoothing (α=0.1), logs to ~/.openclaw/engram/sync-score-log.json,
 *   and flags needsReinjection when EWMA < 0.6.
 * - `detectDrift()` accumulates EWMA drift across the provided messages.
 */
export function createCortexRuntime(options: CortexRuntimeOptions = {}): CortexRuntime {
	const persona = loadPersonaFromFiles(options);
	const syncScoreInterval = options.syncScoreInterval ?? 10;
	let cachedPersonaBlock: string | null = null;
	const driftState: DriftState = createDriftState();
	let turnCounter = 0;
	let syncTurnCounter = 0;
	// EWMA SyncScore: starts at 1.0 (no data → assume healthy)
	let ewmaSyncScore = 1.0;

	return {
		get persona() {
			return persona;
		},

		get ewmaSyncScore() {
			return ewmaSyncScore;
		},

		getPersonaBlock(): string {
			if (cachedPersonaBlock !== null) return cachedPersonaBlock;
			// Tier 1A is the immutable core; always cached for system prompt injection
			cachedPersonaBlock = renderTier1A(persona);
			return cachedPersonaBlock;
		},

		evaluateSyncScore(
			conversationMessages: string[],
			turnNumber?: number,
		): SyncScoreResult {
			// Determine effective turn number
			const effectiveTurn = turnNumber ?? ++syncTurnCounter;

			// Only run a full consistency evaluation on schedule.
			// On off-turns return the current EWMA without recomputing or logging.
			const isDue = effectiveTurn % syncScoreInterval === 0;

			if (!isDue) {
				return {
					rawScore: ewmaSyncScore, // best estimate when not recomputing
					ewmaScore: ewmaSyncScore,
					needsReinjection: ewmaSyncScore < SYNC_SCORE_DRIFT_THRESHOLD,
					turnNumber: effectiveTurn,
					timestamp: new Date().toISOString(),
					consistency: computeConsistency([], conversationMessages),
				};
			}

			// Full evaluation on scheduled turns
			const consistency = computeConsistency([], conversationMessages);
			const rawScore = consistency.C;

			// EWMA smoothing: α=0.1 (slow-moving — persona consistency changes gradually)
			ewmaSyncScore =
				SYNC_SCORE_ALPHA * rawScore + (1 - SYNC_SCORE_ALPHA) * ewmaSyncScore;

			const needsReinjection = ewmaSyncScore < SYNC_SCORE_DRIFT_THRESHOLD;

			const result: SyncScoreResult = {
				rawScore,
				ewmaScore: ewmaSyncScore,
				needsReinjection,
				turnNumber: effectiveTurn,
				timestamp: new Date().toISOString(),
				consistency,
			};

			// Persist to JSONL log
			appendSyncScoreLog(result);

			return result;
		},

		detectDrift(recentMessages: string[]): DriftAssessment {
			if (recentMessages.length === 0) {
				const emptyScore: DriftScore = {
					turnNumber: turnCounter,
					timestamp: new Date().toISOString(),
					rawScore: 0,
					ewmaScore: driftState.ewmaScore,
					Su: 0,
					Sp: 0,
					wu: 0.7,
					wp: 0.3,
					userDensity: 0,
				};
				return { score: emptyScore, isHostile: false, corrections: [], action: "none" };
			}

			const allCorrections: string[] = [];
			let lastScore: DriftScore | null = null;

			for (const msg of recentMessages) {
				turnCounter++;
				const corrections = detectUserCorrections(msg);
				allCorrections.push(...corrections);
				// No probe results available at runtime (probes are async / scheduled)
				lastScore = computeDriftScore(msg, [], driftState, turnCounter);
			}

			// lastScore is guaranteed non-null since recentMessages.length > 0
			const score = lastScore!;

			return {
				score,
				isHostile: score.Su > 0,
				corrections: allCorrections,
				action: actionFromEwma(score.ewmaScore),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Registry (WeakMap keyed by SessionManager, same pattern as ingestion/retrieval)
// ---------------------------------------------------------------------------

const registry = createSessionManagerRuntimeRegistry<CortexRuntime>();

/** Store a CortexRuntime for a given session manager instance. */
export const setCortexRuntime = registry.set;

/** Retrieve the CortexRuntime for a given session manager instance, or null. */
export const getCortexRuntime = registry.get;
