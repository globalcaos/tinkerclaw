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
import {
  DEFAULT_PROVIDER_PROFILES,
  assertProviderDiversity,
  selectBackupParticipant,
  selectModelsForDebateWithProviderDiversity,
  type ProviderProfile,
} from "./src/cognitive-diversity.js";
import { createPersistentDeliberation } from "./src/persistent-deliberation.js";
import {
  runDebate,
  DEFAULT_DEBATE_CONFIG,
  ROLE_AFFINITY,
  type DebateParticipant,
  type DebateConfig,
  type RecoveryHooks,
} from "./src/raac-protocol.js";
import {
  createRealParticipant,
  modelForRole,
  type Phase,
  type RoleModels,
} from "./src/real-participant.js";
import {
  assignRolesViaHook,
  resolveSpeakerSelection,
  type SpeakerSelectionHook,
  type SpeakerSelectionMode,
} from "./src/speaker-selection-api.js";

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
    // 7A/7B/7C config (all declared in openclaw.plugin.json:configSchema —
    // additionalProperties:false rejects any key not declared there).
    const speakerSelectionMode = (cfg.speakerSelectionMode as SpeakerSelectionMode) ?? "builtin";
    const roleModels = (cfg.roleModels as RoleModels) ?? {};
    const enforceProviderDiversity = (cfg.enforceProviderDiversity as boolean) ?? false;

    // 7A: an external AG2 speaker-selection hook may be exported by a sibling plugin.
    // The INTERFACE lives in this extension; the PROVIDER is resolved lazily so the
    // substrate stays open without a hard dependency. Absent provider => builtin.
    let externalSpeakerHook: SpeakerSelectionHook | null = null;
    const loadExternalSpeakerHook = async (): Promise<SpeakerSelectionHook | null> => {
      if (speakerSelectionMode === "builtin") return null;
      if (externalSpeakerHook) return externalSpeakerHook;
      try {
        const res = (await callGatewayFromCli(
          "plugins.getSpeakerSelectionHook",
          { timeout: "5000" },
          {},
          { progress: false },
        )) as { ok?: boolean; hook?: SpeakerSelectionHook } | null;
        externalSpeakerHook = res?.ok && res.hook ? res.hook : null;
      } catch {
        // RPC absent or errored — builtin fallback (never hard-fail; recon Risk 4).
        externalSpeakerHook = null;
      }
      return externalSpeakerHook;
    };

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

          // Select and assign participants.
          // 7C: when enforceProviderDiversity is on, the selection guarantees <=1
          // participant per RESOLVED provider (provider derived from modelForRole's
          // ref, not the cosmetic modelId), greedily dropping the lowest-affinity
          // duplicate. Otherwise keep the original depth-based slice.
          const candidateProfiles = DEFAULT_PROVIDER_PROFILES.slice(0, depth === "quick" ? 3 : 5);
          // resolveRef wires 7C's provider derivation to 7B's role->ref mapping so the
          // two upgrades agree on what "provider" means for each profile.
          const resolveRef = (p: ProviderProfile): string => modelForRole(p.role, roleModels);
          const profiles: ProviderProfile[] = enforceProviderDiversity
            ? selectModelsForDebateWithProviderDiversity(candidateProfiles, {
                resolveRef,
                affinity: ROLE_AFFINITY,
                onWarn: (msg) => api.logger.warn(msg),
              })
            : candidateProfiles;

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
              if (wait?.status === "timeout") {
                api.logger.warn(
                  `[round-table] child ${childSessionKey} timed out (no completion within ${RUN_TIMEOUT_S}s)`,
                );
                return `[${model}/${role}] (no response)`;
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
              api.logger.warn(
                `[round-table] debate model call threw: ${err instanceof Error ? err.message : String(err)}`,
              );
              return `[${model}/${role}] (error)`;
            }
          };

          // 7A: resolve role assignment via the pluggable speaker-selection hook.
          // Builtin mode reproduces assignRoles byte-for-byte; ag2-hook/auto modes let
          // an external manager drive it. assignRolesViaHook guarantees a builtin
          // fallback on null/throw/empty/invalid (so the debate never hard-fails).
          const activeHook = resolveSpeakerSelection(
            speakerSelectionMode,
            await loadExternalSpeakerHook(),
          );
          const roleAssignment = await assignRolesViaHook(
            {
              profiles,
              roles: ["architect", "critic", "pragmatist", "researcher", "synthesizer"],
              task: topic,
            },
            activeHook,
            (msg) => api.logger.warn(msg),
          );
          // Route the ASSIGNED role into each profile so modelForRole (with 7B
          // overrides) picks the right cross-provider model.
          const assignedProfiles: ProviderProfile[] = profiles.map((p) => ({
            ...p,
            role: roleAssignment[p.modelId] ?? p.role,
          }));
          const participants: DebateParticipant[] = assignedProfiles.map((p) =>
            createRealParticipant(p, { callModel }, roleModels),
          );

          // 7C: log the provider mix at debate start so a diversity collapse is
          // visible in the trace (the empirical backbone of the paper's claim).
          const debateRefs = assignedProfiles.map((p) => modelForRole(p.role, roleModels));
          const providerMix = assertProviderDiversity(debateRefs);
          api.logger.info(
            `[round-table] debate_providers=${Object.keys(providerMix).join(",")} ` +
              `mix=${JSON.stringify(providerMix)}`,
          );

          // 7E: dropout recovery — promote a backup participant when a phase response
          // is a failure sentinel, rather than letting the sentinel poison the
          // synthesis. The backup respects the 7C provider lock and is charged like any
          // other call (one attempt per slot).
          const activeIds = new Set(assignedProfiles.map((p) => p.modelId));
          const recovery: RecoveryHooks = {
            selectBackup: (role, currentlyActive) =>
              ((): DebateParticipant | null => {
                const backupProfile = selectBackupParticipant(
                  DEFAULT_PROVIDER_PROFILES,
                  new Set([...activeIds, ...currentlyActive]),
                  role,
                  {
                    resolveRef,
                    activeRefs: debateRefs,
                    affinity: ROLE_AFFINITY,
                  },
                );
                if (!backupProfile) return null;
                return createRealParticipant({ ...backupProfile, role }, { callModel }, roleModels);
              })(),
            callBackup: async (backup, phase) => {
              switch (phase) {
                case "propose":
                  return backup.propose(topic, backup.role);
                default:
                  return backup.propose(topic, backup.role);
              }
            },
          };

          // Run the debate (with dropout recovery wired in)
          const result = await runDebate(topic, participants, config, recovery);

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
