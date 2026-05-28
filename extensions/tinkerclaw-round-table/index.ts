/**
 * FORK: Round Table extension entry point -- registers the `synapse_debate` tool.
 *
 * Wires the RAAC protocol debate engine into the OpenClaw plugin SDK as a
 * callable agent tool. Constructs real-LLM, CROSS-PROVIDER debate participants
 * (createRealParticipant) routed by role to Anthropic + OpenAI + Google models,
 * each exercising the full 5-phase RAAC protocol (Propose -> Challenge -> Defend
 * -> Synthesize -> Ratify). Each phase is a real model call dispatched via
 * fork.subagents.spawn and read back via agent.wait + chat.history.
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
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { DEFAULT_PROVIDER_PROFILES } from "./src/cognitive-diversity.js";
import { createPersistentDeliberation } from "./src/persistent-deliberation.js";
import {
  runDebate,
  DEFAULT_DEBATE_CONFIG,
  assignRoles,
  type DebateParticipant,
  type DebateConfig,
} from "./src/raac-protocol.js";
import { createRealParticipant, type Phase } from "./src/real-participant.js";

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

          const callModel = async ({
            model,
            prompt,
            role,
          }: {
            model: string;
            prompt: string;
            phase: Phase;
            role: string;
          }): Promise<string> => {
            // One real LLM call via the SAME fan-out fabric subagents use (shares
            // the cc-bridge billing harness + 8-worker fan-out budget). Spawn is
            // FIRE-AND-FORGET (no synchronous result); we read the child transcript
            // back ourselves via agent.wait + chat.history (the engine's own path).
            // callGatewayFromCli signature is (method, opts, params?, extra?) —
            // confirmed against src/cli/gateway-rpc.ts:22-30; NOT positional
            // (method, params). No awaitResult / res.result anywhere (do not exist).
            const RUN_TIMEOUT_S = 120;
            try {
              const spawn = (await callGatewayFromCli(
                "fork.subagents.spawn",
                // GatewayRpcOpts.timeout is a string (raw CLI --timeout <ms>).
                { timeout: String((RUN_TIMEOUT_S + 10) * 1000) },
                {
                  task: prompt,
                  model,
                  label: `debate:${role}`,
                  parentSessionKey: "agent:main:main",
                  runTimeoutSeconds: RUN_TIMEOUT_S,
                  // We read the transcript ourselves; do NOT post a farewell to the
                  // parent channel.
                  expectsCompletionMessage: false,
                },
                { progress: false },
              )) as { ok?: boolean; childSessionKey?: string; runId?: string; note?: string };
              if (!spawn?.ok || !spawn.childSessionKey || !spawn.runId) {
                api.logger.warn(
                  `[round-table] spawn failed for ${role}: ${spawn?.note ?? "no childSessionKey/runId"}`,
                );
                return `[${model}/${role}] (no response)`;
              }
              const { childSessionKey, runId } = spawn;

              // Block until the child run terminates (or timeout). Real RPC + params
              // (agent.wait schema: { runId, timeoutMs }).
              const wait = (await callGatewayFromCli(
                "agent.wait",
                { timeout: String(RUN_TIMEOUT_S * 1000 + 5_000) },
                { runId, timeoutMs: RUN_TIMEOUT_S * 1000 },
                { progress: false },
              )) as { status?: "ok" | "timeout" | "error"; error?: string };
              if (wait?.status === "error") {
                api.logger.warn(
                  `[round-table] child ${childSessionKey} errored: ${wait.error ?? "?"}`,
                );
                return `[${model}/${role}] (error)`;
              }

              // Read the final assistant text; retry for sessionFile flush
              // (mirrors readLatestSubagentOutputWithRetry: ~15s cap, 100ms interval).
              const deadline = Date.now() + 15_000;
              let finalText: string | undefined;
              do {
                const hist = (await callGatewayFromCli(
                  "chat.history",
                  { timeout: "10000" },
                  { sessionKey: childSessionKey, limit: 100 },
                  { progress: false },
                )) as { messages?: Array<{ role?: string; content?: unknown }> };
                const messages = Array.isArray(hist?.messages) ? hist.messages : [];
                for (let i = messages.length - 1; i >= 0; i--) {
                  const m = messages[i];
                  if (m?.role !== "assistant") continue;
                  const text =
                    typeof m.content === "string"
                      ? m.content
                      : Array.isArray(m.content)
                        ? m.content
                            .map((b: unknown) =>
                              typeof (b as { text?: unknown })?.text === "string"
                                ? (b as { text: string }).text
                                : "",
                            )
                            .join("")
                        : "";
                  if (text.trim()) {
                    finalText = text.trim();
                    break;
                  }
                }
                if (finalText || Date.now() >= deadline) break;
                await new Promise((r) => setTimeout(r, 100));
              } while (true);

              if (!finalText) {
                api.logger.warn(
                  `[round-table] child ${childSessionKey} produced no final assistant text (status=${wait?.status})`,
                );
                return `[${model}/${role}] (no response)`;
              }
              return finalText;
            } catch (err) {
              api.logger.warn(`[round-table] debate model call threw: ${String(err)}`);
              return `[${model}/${role}] (error)`;
            }
          };

          // Preserve the bipartite role assignment (assignRoles, raac-protocol.ts:117)
          // the ORIGINAL construction applied; route the ASSIGNED role into the profile
          // so modelForRole picks the right cross-provider model.
          const roleAssignment = assignRoles(profiles.map((p) => p.modelId));
          const participants: DebateParticipant[] = profiles.map((p) =>
            createRealParticipant(
              { ...p, role: roleAssignment[p.modelId] ?? p.role },
              { callModel },
            ),
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
