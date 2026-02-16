/**
 * ENGRAM Phase 1C: Task State object.
 * Tracks the current task context for retrieval conditioning (ENGRAM §4.3).
 */

import { createHash } from "node:crypto";

export type TaskPhase = "planning" | "executing" | "debugging" | "reviewing" | "idle";

export interface TaskState {
	version: number;
	taskId: string;
	phase: TaskPhase;
	goals: string[];
	constraints: string[];
	openLoops: string[];
	nextActions: string[];
	keyEvents: string[];
	premiseVersion: string;
	extensions: Record<string, unknown>;
	updatedAt: string;
	updatedByTurn: number;
}

/**
 * Compute a premise hash from the task state's goals + constraints.
 */
export function computePremiseVersion(goals: string[], constraints: string[]): string {
	const input = [...goals, "---", ...constraints].join("\n");
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Create a default idle task state.
 */
export function createDefaultTaskState(taskId: string = "default"): TaskState {
	const goals: string[] = [];
	const constraints: string[] = [];
	return {
		version: 0,
		taskId,
		phase: "idle",
		goals,
		constraints,
		openLoops: [],
		nextActions: [],
		keyEvents: [],
		premiseVersion: computePremiseVersion(goals, constraints),
		extensions: {},
		updatedAt: new Date().toISOString(),
		updatedByTurn: 0,
	};
}

/**
 * Update a task state, incrementing version and recomputing premise.
 */
export function updateTaskState(
	current: TaskState,
	updates: Partial<Pick<TaskState, "phase" | "goals" | "constraints" | "openLoops" | "nextActions" | "keyEvents" | "extensions">>,
	turnId: number,
): TaskState {
	const goals = updates.goals ?? current.goals;
	const constraints = updates.constraints ?? current.constraints;
	return {
		...current,
		...updates,
		version: current.version + 1,
		premiseVersion: computePremiseVersion(goals, constraints),
		updatedAt: new Date().toISOString(),
		updatedByTurn: turnId,
	};
}

/**
 * Render task state for context injection.
 */
export function renderTaskState(taskState: TaskState): string {
	const parts = [`[Task: ${taskState.taskId} | Phase: ${taskState.phase} | v${taskState.version}]`];

	if (taskState.goals.length > 0) {
		parts.push(`Goals: ${taskState.goals.join("; ")}`);
	}
	if (taskState.constraints.length > 0) {
		parts.push(`Constraints: ${taskState.constraints.join("; ")}`);
	}
	if (taskState.openLoops.length > 0) {
		parts.push(`Open loops: ${taskState.openLoops.join("; ")}`);
	}
	if (taskState.nextActions.length > 0) {
		parts.push(`Next: ${taskState.nextActions.join("; ")}`);
	}

	return parts.join("\n");
}
