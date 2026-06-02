import { runEmbeddedAttempt } from "../embedded-agent-runner/run/attempt.js";
import type { AgentHarness } from "./types.js";

export function createPiAgentHarness(): AgentHarness {
  return {
    id: "pi",
    label: "PI embedded agent",
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: runEmbeddedAttempt,
  };
}
