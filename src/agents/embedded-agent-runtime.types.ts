import type { RunEmbeddedPiAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedPiRunResult } from "./embedded-agent-runner/types.js";

export type RunEmbeddedPiAgentFn = (
  params: RunEmbeddedPiAgentParams,
) => Promise<EmbeddedPiRunResult>;

export type RunEmbeddedAgentFn = RunEmbeddedPiAgentFn;
