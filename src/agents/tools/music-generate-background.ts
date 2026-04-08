import type { OpenClawConfig } from "../../config/config.js";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

export type MusicGenerationTaskHandle = MediaGenerationTaskHandle;

const musicGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  toolName: "music_generate",
  taskKind: MUSIC_GENERATION_TASK_KIND,
  label: "Music generation",
  queuedProgressSummary: "Queued music generation",
  generatedLabel: "track",
  failureProgressSummary: "Music generation failed",
  eventSource: "music_generation",
  announceType: "music generation task",
  completionLabel: "music",
});

export const createMusicGenerationTaskRun = musicGenerationTaskLifecycle.createTaskRun;

export const recordMusicGenerationTaskProgress = musicGenerationTaskLifecycle.recordTaskProgress;

export const completeMusicGenerationTaskRun = musicGenerationTaskLifecycle.completeTaskRun;

export const failMusicGenerationTaskRun = musicGenerationTaskLifecycle.failTaskRun;

export async function wakeMusicGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MusicGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
}) {
  await musicGenerationTaskLifecycle.wakeTaskCompletion(params);
}
