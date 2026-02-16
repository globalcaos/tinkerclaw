/**
 * ENGRAM Phase 2B: Task-conditioned scoring.
 * Scoring function with prem, phase, sup, task_rel modifiers (ENGRAM §5.2, Annex A.3).
 */

import type { MemoryEvent, EventKind } from "./event-types.js";
import type { TaskState, TaskPhase } from "./task-state.js";

/** Maximum score multiplier cap. */
const M_MAX = 10.0;

/** Discount applied to events superseded by newer versions. */
const SUPERSESSION_DISCOUNT = 0.1;

/** Decay applied to events from a different task. */
const CROSS_TASK_DECAY = 0.3;

/** Minimum score for constraint-tagged events. */
const CONSTRAINT_FLOOR = 3.0;

/**
 * Phase salience table — how much each event kind matters in each task phase.
 * From the ENGRAM paper.
 */
const PHASE_SALIENCE: Record<TaskPhase, Partial<Record<EventKind, number>>> = {
	planning: {
		user_message: 1.0,
		agent_message: 1.0,
		tool_call: 0.5,
		tool_result: 0.5,
		system_event: 1.0,
		compaction_marker: 1.0,
		artifact_reference: 0.8,
	},
	debugging: {
		user_message: 1.0,
		agent_message: 1.0,
		tool_call: 1.5,
		tool_result: 2.0,
		system_event: 1.0,
		compaction_marker: 1.0,
		artifact_reference: 1.2,
	},
	executing: {
		user_message: 1.0,
		agent_message: 1.0,
		tool_call: 1.5,
		tool_result: 1.5,
		system_event: 1.0,
		compaction_marker: 1.0,
		artifact_reference: 1.0,
	},
	reviewing: {
		user_message: 1.5,
		agent_message: 1.5,
		tool_call: 0.3,
		tool_result: 0.5,
		system_event: 1.0,
		compaction_marker: 1.0,
		artifact_reference: 1.0,
	},
	idle: {
		user_message: 1.0,
		agent_message: 1.0,
		tool_call: 0.5,
		tool_result: 0.5,
		system_event: 1.0,
		compaction_marker: 1.0,
		artifact_reference: 0.8,
	},
};

/**
 * Compute premise compatibility between an event's premise ref and the current task state.
 * Returns 1.0 for matching premises, 0.5 for missing premise info, lower for mismatched.
 */
export function premiseCompatibility(eventPremiseRef: string | undefined, currentPremiseVersion: string): number {
	if (!eventPremiseRef) return 0.5; // No premise info → neutral
	if (eventPremiseRef === currentPremiseVersion) return 1.0; // Exact match
	// Different premise — partial decay
	return 0.4;
}

/**
 * Get phase salience multiplier for an event kind in the current task phase.
 */
export function phaseSalience(phase: TaskPhase, kind: EventKind): number {
	return PHASE_SALIENCE[phase]?.[kind] ?? 1.0;
}

/**
 * Compute the task-conditioned modifier for an event given the current task state.
 * This multiplies the base retrieval score.
 */
export function taskConditionedModifier(event: MemoryEvent, taskState: TaskState): number {
	// Cross-task decay
	if (event.metadata.taskId && event.metadata.taskId !== taskState.taskId) {
		return CROSS_TASK_DECAY;
	}

	let m = 1.0;

	// Supersession discount
	if (event.metadata.supersededBy) {
		m *= SUPERSESSION_DISCOUNT;
	}

	// Premise compatibility
	m *= premiseCompatibility(event.metadata.premiseRef, taskState.premiseVersion);

	// Phase salience
	m *= phaseSalience(taskState.phase, event.kind);

	// Constraint protection — floor at CONSTRAINT_FLOOR
	if (event.metadata.tags?.includes("constraint")) {
		m = Math.max(m, CONSTRAINT_FLOOR);
	}

	return Math.min(m, M_MAX);
}

/**
 * Full task-conditioned score: base similarity score × task modifier.
 */
export function taskConditionedScore(
	event: MemoryEvent,
	baseScore: number,
	taskState: TaskState,
): number {
	return baseScore * taskConditionedModifier(event, taskState);
}
