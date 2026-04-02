/**
 * FORK: Round Table extension entry point -- registers the `synapse_debate` tool.
 *
 * Wires the RAAC protocol debate engine into the OpenClaw plugin SDK as a
 * callable agent tool. Creates simulated debate participants that exercise the
 * full 5-phase protocol (Propose -> Challenge -> Defend -> Synthesize -> Ratify).
 *
 * Cross-extension discovery: writes `~/.openclaw/cognitive/round-table.json`
 * so other extensions (e.g. Total Recall) can detect Round Table availability.
 * If Total Recall is active, debate traces are persisted to its store; otherwise
 * falls back to `~/.openclaw/synapse/debates.jsonl`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { DEFAULT_PROVIDER_PROFILES, type ProviderProfile } from "./src/cognitive-diversity.js";
import { createPersistentDeliberation } from "./src/persistent-deliberation.js";
import {
  runDebate,
  DEFAULT_DEBATE_CONFIG,
  assignRoles,
  type DebateParticipant,
  type DebateConfig,
} from "./src/raac-protocol.js";

// -- Constants --

const COGNITIVE_DIR = join(homedir(), ".openclaw", "cognitive");
const DEFAULT_TRACES_DIR = join(homedir(), ".openclaw", "synapse");
const DEFAULT_TRACES_PATH = join(DEFAULT_TRACES_DIR, "traces.jsonl");
const DEFAULT_CONCLUSIONS_PATH = join(DEFAULT_TRACES_DIR, "conclusions.jsonl");
const ROUND_TABLE_STATE_PATH = join(COGNITIVE_DIR, "round-table.json");
const TOTAL_RECALL_STATE_PATH = join(COGNITIVE_DIR, "total-recall.json");

// -- Tool Schema (TypeBox) --

const SynapseDebateParams = Type.Object({
  topic: Type.String({ description: "The debate topic or question to deliberate on." }),
  depth: Type.Optional(
    Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")], {
      description: "Debate depth: quick (1-2 rounds), standard (3-4), deep (5-6).",
    }),
  ),
});

type SynapseDebateInput = Static<typeof SynapseDebateParams>;

// -- Depth -> Config mapping --

const DEPTH_CONFIGS: Record<string, Partial<DebateConfig>> = {
  quick: { maxRounds: 2, maxBudgetPerDebate: 1.0 },
  standard: { maxRounds: 4, maxBudgetPerDebate: 3.0 },
  deep: { maxRounds: 6, maxBudgetPerDebate: 8.0 },
};

// -- Simulated participant factory --

/**
 * Create a simulated debate participant that generates deterministic responses
 * based on the model profile. In production, these would be backed by real LLM
 * calls; here they demonstrate the protocol flow and produce meaningful traces.
 */
function createSimulatedParticipant(profile: ProviderProfile): DebateParticipant {
  return {
    modelId: profile.modelId,
    role: profile.role,
    profile,
    async propose(task: string, role: string, priorSynthesis?: string): Promise<string> {
      const base = `[${profile.modelId}/${role}] Proposal: `;
      if (priorSynthesis) {
        return `${base}Building on prior synthesis, I suggest approaching "${task}" by leveraging ${profile.strengths.join(", ")}. Refinement of: ${priorSynthesis.slice(0, 100)}`;
      }
      return `${base}For "${task}", I recommend focusing on ${profile.strengths.join(" and ")} as key considerations.`;
    },
    async challenge(proposal: string, role: string): Promise<string> {
      return `[${profile.modelId}/${role}] Challenge: The proposal overlooks ${profile.strengths[0]} implications. Specifically: ${proposal.slice(0, 80)}... needs deeper analysis.`;
    },
    async defend(attacks: string[], role: string): Promise<string> {
      return `[${profile.modelId}/${role}] Defense: Addressing ${attacks.length} challenge(s) -- my approach accounts for these through ${profile.strengths.join(", ")}.`;
    },
    async synthesize(
      proposals: string[],
      challenges: string[],
      defenses: string[],
    ): Promise<string> {
      return `Synthesis: After ${proposals.length} proposals, ${challenges.length} challenges, and ${defenses.length} defenses, the consensus approach integrates multiple perspectives for a balanced solution.`;
    },
    async ratify(_synthesis: string): Promise<"accept" | "reject" | "amend"> {
      return "accept";
    },
  };
}

// -- Cross-extension state helpers --

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeSharedState(): void {
  ensureDir(COGNITIVE_DIR);
  writeFileSync(
    ROUND_TABLE_STATE_PATH,
    JSON.stringify({ active: true, version: "1.0.0" }, null, 2),
    "utf-8",
  );
}

interface TotalRecallState {
  active: boolean;
  tracesPath?: string;
  conclusionsPath?: string;
}

function readTotalRecallState(): TotalRecallState | null {
  try {
    if (existsSync(TOTAL_RECALL_STATE_PATH)) {
      return JSON.parse(readFileSync(TOTAL_RECALL_STATE_PATH, "utf-8")) as TotalRecallState;
    }
  } catch {
    // Malformed or missing -- fall back
  }
  return null;
}

function resolvePersistencePaths(): { tracesPath: string; conclusionsPath: string } {
  const totalRecall = readTotalRecallState();
  if (totalRecall?.active && totalRecall.tracesPath && totalRecall.conclusionsPath) {
    return {
      tracesPath: totalRecall.tracesPath,
      conclusionsPath: totalRecall.conclusionsPath,
    };
  }
  ensureDir(DEFAULT_TRACES_DIR);
  return { tracesPath: DEFAULT_TRACES_PATH, conclusionsPath: DEFAULT_CONCLUSIONS_PATH };
}

// -- Plugin Entry --

export default definePluginEntry({
  id: "tinkerclaw-round-table",
  name: "Round Table",
  description: "SYNAPSE -- Multi-model debate via RAAC protocol with cognitive diversity scoring.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const defaultDepth = (cfg.defaultDepth as string) ?? "standard";
    const maxRoundsOverride = cfg.maxRounds as number | undefined;

    // Write cross-extension state for discovery
    try {
      writeSharedState();
    } catch (err) {
      api.logger.warn(`[round-table] failed to write shared state: ${err}`);
    }

    // Resolve persistence paths (Total Recall integration)
    const paths = resolvePersistencePaths();
    const deliberation = createPersistentDeliberation(paths);

    // Register the synapse_debate tool
    api.registerTool(
      () => ({
        name: "synapse_debate",
        label: "SYNAPSE Debate",
        description:
          "Run a structured multi-model debate on a topic using the RAAC protocol. " +
          "Produces a synthesized consensus with confidence scoring and full debate traces.",
        parameters: SynapseDebateParams,
        async execute(_toolCallId: string, params: SynapseDebateInput) {
          const { topic } = params;
          const depth = params.depth ?? defaultDepth;

          const depthConfig = DEPTH_CONFIGS[depth] ?? DEPTH_CONFIGS.standard;
          const config: DebateConfig = {
            ...DEFAULT_DEBATE_CONFIG,
            ...depthConfig,
            ...(maxRoundsOverride != null ? { maxRounds: maxRoundsOverride } : {}),
          };

          // Select and assign participants
          const profiles = DEFAULT_PROVIDER_PROFILES.slice(0, depth === "quick" ? 3 : 5);
          const roleAssignment = assignRoles(profiles.map((p) => p.modelId));

          const participants: DebateParticipant[] = profiles.map((p) =>
            createSimulatedParticipant({ ...p, role: roleAssignment[p.modelId] ?? p.role }),
          );

          // Run the debate
          const result = await runDebate(topic, participants, config);

          // Persist traces
          try {
            deliberation.updateDeliberationMemory(result, "full-synapse");
          } catch (err) {
            api.logger.warn(`[round-table] trace persistence failed: ${err}`);
          }

          // Compute confidence from convergence + ratification
          const lastRound = result.rounds[result.rounds.length - 1];
          const acceptCount = lastRound
            ? Object.values(lastRound.ratification).filter((v) => v === "accept").length
            : 0;
          const totalVoters = lastRound ? Object.values(lastRound.ratification).length : 1;
          const confidence = result.converged
            ? 0.7 + 0.3 * (acceptCount / totalVoters)
            : 0.3 + 0.4 * (acceptCount / totalVoters);

          // Collect dissent
          const dissent: string[] = [];
          if (lastRound) {
            for (const [modelId, vote] of Object.entries(lastRound.ratification)) {
              if (vote !== "accept") {
                dissent.push(`${modelId}: ${vote}`);
              }
            }
          }

          // Build response matching types.ts DebateResult shape
          const toolResult = {
            consensus: result.finalSynthesis,
            confidence,
            dissent,
            actionItems: [
              `Review debate traces (${result.rounds.length} rounds)`,
              ...(result.converged ? [] : ["Consider re-running with deeper analysis"]),
            ],
            diversityScore: profiles.length / 5,
            rounds: result.rounds.map((r) => ({
              number: r.roundNumber,
              proposals: Object.entries(r.proposals).map(([role, position]) => ({
                role,
                position,
                reasoning: `Based on ${role} perspective`,
              })),
              challenges: Object.values(r.challenges).flatMap((c) => Object.values(c)),
              resolution: r.synthesis,
            })),
          };

          return {
            content: [{ type: "text" as const, text: JSON.stringify(toolResult, null, 2) }],
            details: toolResult,
          };
        },
      }),
      { optional: true },
    );

    api.logger.info(`[round-table] ready (depth=${defaultDepth}, traces=${paths.tracesPath})`);
  },
});
