import type { OpenClawConfig } from "../../config/config.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  createMediaGenerationTaskLifecycle,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";

export type VideoGenerationTaskHandle = MediaGenerationTaskHandle;

const videoGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  toolName: "video_generate",
  taskKind: VIDEO_GENERATION_TASK_KIND,
  label: "Video generation",
  queuedProgressSummary: "Queued video generation",
  generatedLabel: "video",
  failureProgressSummary: "Video generation failed",
  eventSource: "video_generation",
  announceType: "video generation task",
  completionLabel: "video",
});

export const createVideoGenerationTaskRun = videoGenerationTaskLifecycle.createTaskRun;

export const recordVideoGenerationTaskProgress = videoGenerationTaskLifecycle.recordTaskProgress;

export const completeVideoGenerationTaskRun = videoGenerationTaskLifecycle.completeTaskRun;

export const failVideoGenerationTaskRun = videoGenerationTaskLifecycle.failTaskRun;

export async function wakeVideoGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: VideoGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
}) {
  await videoGenerationTaskLifecycle.wakeTaskCompletion(params);
}
