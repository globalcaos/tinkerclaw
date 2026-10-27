/**
 * tinkerclaw-forget — forget one fact everywhere this machine keeps it, and hand back a receipt.
 *
 * "Some things you want gone for good, like a phone number you shared by mistake. Then the agent
 * follows every copy and deletes it, even the line in the chat record. It hands you a receipt that
 * lists every place, including the one it can't reach: the AI provider's own copy."
 *
 * Tool `forget` (owner only, optional: list it in tools.alsoAllow) and gateway method
 * `memory.forget` (operator.admin). Both take { fact, variants?, label?, confirm? }.
 *
 * Mode `preview` (default): search every place and report, change nothing. Mode `apply`: the
 * preview hands out a one-time confirm code; passing it back redacts. Mode `off`: nothing loads.
 * See src/forget.ts for the flow and README.md for the places and what each status means.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import {
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { claudeAutoMemoryDir } from "openclaw/plugin-sdk/memory-engram";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  compactReceipt,
  FactError,
  formatReceipt,
  runForget,
  stopFollowUps,
  type ForgetConfig,
  type ForgetEnv,
  type ForgetMode,
  type ForgetRequest,
} from "./src/forget.js";
import type { MemoryIndexManager } from "./src/indexes.js";

const ForgetParams = Type.Object({
  fact: Type.String({
    description:
      "The exact text to forget: a phone number, an address, a sentence. Numbers match with any " +
      "spacing; text matches case-insensitively as whole words.",
  }),
  variants: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Other spellings of the same fact (at most 5), e.g. the number without its country code.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      description:
        'A few words naming what this was, without the fact itself ("my old phone number"). ' +
        "The receipt keeps the label, never the fact.",
    }),
  ),
  confirm: Type.Optional(
    Type.String({
      description:
        "Leave empty for a preview (finds every copy, changes nothing). Pass the code a preview " +
        "returned to forget for real.",
    }),
  ),
});

type ForgetInput = Static<typeof ForgetParams>;

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "")
    : [];
}

export function resolveForgetConfig(raw: unknown, stateDir: string): ForgetConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode: ForgetMode = c.mode === "off" || c.mode === "apply" ? c.mode : "preview";
  const mb =
    typeof c.maxBinaryScanMB === "number" && c.maxBinaryScanMB > 0 ? c.maxBinaryScanMB : 2048;
  return {
    mode,
    extraRoots: strings(c.extraRoots),
    backupDirs: c.backupDirs === undefined ? [join(stateDir, "backups")] : strings(c.backupDirs),
    remoteCopies: strings(c.remoteCopies),
    claudeCode: c.claudeCode !== false,
    gitHistory: c.gitHistory !== false,
    maxBinaryScanMB: mb,
  };
}

export default definePluginEntry({
  id: "tinkerclaw-forget",
  name: "Forget",
  description:
    "Forget one fact in every place it was copied (notes, old versions, search indexes, summaries, chat records, backups) and hand back a receipt that names the places it cannot reach.",
  register(api: OpenClawPluginApi) {
    const stateDir = resolveStateDir();
    const config = resolveForgetConfig(api.pluginConfig, stateDir);
    if (config.mode === "off") {
      api.logger.info("[forget] off (mode=off)");
      return;
    }

    const envFor = (cfg: OpenClawConfig): ForgetEnv => {
      const defaultAgentId = resolveDefaultAgentId(cfg);
      const agentIds = [
        ...new Set([defaultAgentId, ...(cfg.agents?.list ?? []).map((a) => a.id).filter(Boolean)]),
      ];
      const workspaceDirs = agentIds
        .map((id) => {
          try {
            return api.runtime.agent.resolveAgentWorkspaceDir(cfg, id);
          } catch {
            return undefined;
          }
        })
        .filter((d): d is string => Boolean(d));
      return {
        stateDir,
        home: homedir(),
        workspaceDirs: [...new Set(workspaceDirs)],
        agentIds,
        memoryExtraPaths: strings(cfg.agents?.defaults?.memorySearch?.extraPaths),
        autoMemoryDir: claudeAutoMemoryDir(),
        config,
        getMemoryManager: async (agentId) => {
          const got = await getActiveMemorySearchManager({ cfg, agentId });
          return { manager: got.manager as MemoryIndexManager | null, error: got.error };
        },
        log: (m) => api.logger.info(m),
      };
    };

    const run = async (req: ForgetRequest, cfg: OpenClawConfig = api.config) => {
      try {
        const receipt = await runForget(req, envFor(cfg));
        return { ok: true as const, receipt, text: formatReceipt(receipt) };
      } catch (err) {
        if (err instanceof FactError) {
          return { ok: false as const, error: err.message };
        }
        console.error("[forget] run failed", err);
        return { ok: false as const, error: `forget failed: ${String(err)}` };
      }
    };

    // Owner only, never sandboxed: a preview alone tells the caller where a fact sits across every
    // chat, and an apply rewrites other chats' records. Everyone else does not see the tool at all.
    api.registerTool(
      (ctx: OpenClawPluginToolContext) =>
        ctx.senderIsOwner === true && ctx.sandboxed !== true
          ? {
              name: "forget",
              label: "Forget",
              description:
                "Forget one fact (a phone number, an address, a sentence) everywhere this machine keeps " +
                "it: memory notes, their old versions, the search indexes, summaries, chat records and " +
                "backups. Only when the owner asks for something to be gone for good. First call " +
                "without confirm: a preview that finds every copy and changes nothing; show the owner " +
                "the receipt. Then, if the owner agrees, call again with the same fact and the confirm " +
                "code. Never repeat the fact in your reply: quote the label instead.",
              parameters: ForgetParams,
              async execute(_toolCallId: string, params: ForgetInput) {
                const out = await run(
                  params,
                  ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config,
                );
                return {
                  content: [{ type: "text" as const, text: out.ok ? out.text : out.error }],
                  details: out.ok ? compactReceipt(out.receipt) : out,
                };
              },
            }
          : null,
      { optional: true },
    );

    api.registerGatewayMethod(
      "memory.forget",
      async ({ params, respond }) => {
        const out = await run((params ?? {}) as ForgetRequest);
        respond(true, out.ok ? { ok: true, receipt: out.receipt, text: out.text } : out);
      },
      { scope: "operator.admin" },
    );

    api.on("gateway_stop", async () => {
      stopFollowUps();
    });

    api.logger.info(
      `[forget] ${config.mode}: tool forget (owner, optional) and gateway method memory.forget; receipts in ${stateDir}/data/forget`,
    );
  },
});
