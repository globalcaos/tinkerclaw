/**
 * synapse-tool — Agent tool for SYNAPSE multi-model debate/deliberation
 *
 * Exposes the SYNAPSE RAAC debate engine as a callable tool (`synapse_debate`).
 * Accepts a topic and debate depth (quick|standard|deep) and returns structured
 * output: consensus, dissenting opinions, confidence score, and action items.
 *
 * Wired in by: createOpenClawTools() in openclaw-tools.ts
 */
import { Type } from "@sinclair/typebox";
import { getSynapseRuntime } from "../pi-extensions/synapse-runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SynapseDebateSchema = Type.Object({
  topic: Type.String({
    description: "The topic or question to deliberate on.",
  }),
  mode: Type.Optional(
    Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")], {
      description: "Debate depth. quick=2 rounds, standard=4 rounds (default), deep=6 rounds.",
    }),
  ),
});

export function createSynapseDebateTool(): AnyAgentTool {
  return {
    label: "SYNAPSE Debate",
    name: "synapse_debate",
    description:
      "Run a structured multi-model deliberation (SYNAPSE RAAC protocol) on any topic or question. Returns consensus, dissenting opinions, confidence score, and action items. Use for complex decisions, trade-off analysis, or second-opinion reasoning.",
    parameters: SynapseDebateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const topic = readStringParam(params, "topic", { required: true });
      const rawMode = readStringParam(params, "mode");
      const mode = rawMode === "quick" || rawMode === "deep" ? rawMode : "standard";

      const runtime = getSynapseRuntime();
      if (!runtime) {
        return jsonResult({
          error: "SYNAPSE runtime is not initialised in this session.",
          hint: "The debate engine requires an EventStore; ensure the gateway has started with memory extensions enabled.",
        });
      }

      const result = await runtime.debate(topic, { depth: mode });

      return jsonResult({
        consensus: result.consensus,
        confidence: result.confidence,
        dissent: result.dissent,
        actionItems: result.actionItems,
        diversityScore: result.diversityScore,
        mode,
        topic,
      });
    },
  };
}
