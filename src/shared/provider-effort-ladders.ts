/**
 * What thinking efforts does the OFFICIAL provider actually expose for a model?
 *
 * FORK 2026-08-25 (the architect: "Make the official provider determine the different
 * thinking efforts, and be very careful not to hallucinate how smart any of the
 * models at any of the thinking efforts are").
 *
 * WHY THIS FILE EXISTS. The smartness×cost chart used to draw every model as a
 * six-bubble constellation — minimal · low · medium · high · xhigh · max — with
 * a hand-written smartness curve (0.9× … 1.12×) applied identically to all of
 * them. Both halves were fiction. Grok exposes NO effort control at all, GLM and
 * Kimi expose a plain on/off toggle, and nobody publishes an intelligence score
 * per effort level, so the vertical spread was invented outright.
 *
 * The gateway already knows the truth: every provider plugin declares its own
 * thinking profile through `resolveThinkingProfile`, and `resolveThinkingProfile`
 * in src/auto-reply/thinking.ts is what the runtime asks before offering a level.
 * Those declarations live inside extension entrypoints that drag Node-only
 * dependencies, so the browser bundle cannot import them directly. This module is
 * a PURE transcription of them, one row per provider, each citing the file that
 * declares it. `provider-effort-ladders.test.ts` pins the transcription.
 *
 * PROVENANCE — read these before editing a row:
 *   anthropic / claude-code  platform.claude.com/docs/en/build-with-claude/effort
 *                            (fetched 2026-08-27): low·medium·high·xhigh·max on
 *                            Opus 5 / Sonnet 5 / Fable 5 / Opus 4.8 / Opus 4.7.
 *                            Sonnet 4.6 supports max but NOT xhigh. `minimal` is
 *                            not in the published effort table for these models.
 *                            The in-tree plugin (provider-model-shared.ts) is
 *                            STALE — it still stops Opus 5 at high. The chart
 *                            follows the vendor page, not the plugin.
 *   openai / openai-codex /  developers.openai.com/api/docs/guides/latest-model
 *   codex                    (fetched 2026-08-27): GPT-5.6 = none·low·medium·high
 *                            ·xhigh·max. Older GPT-5.x keep the plugin allow-list.
 *   github-copilot           extensions/github-copilot/index.ts — the RESELLER's
 *                            ladder, not the lab's. Unchanged: we can only send
 *                            what Copilot exposes.
 *   google                   extensions/google/provider-hooks.ts:12
 *   xai                      docs.x.ai reasoning page (fetched 2026-08-27):
 *                            grok-4.6 = low·medium·high·xhigh; grok-4.5 =
 *                            low·medium·high. The in-tree plugin still declares
 *                            levels:[off] and strips reasoning_effort on the
 *                            wire — that is a send-path bug, not the vendor's
 *                            ladder. The chart follows the vendor page.
 *   zai                      docs.z.ai/guides/llm/glm-5.3 (fetched 2026-08-27):
 *                            GLM-5.3 = low·high·max (thinking always on).
 *   moonshot / kimi          github.com/MoonshotAI/Kimi-K3 (fetched 2026-08-27):
 *                            Kimi K3 = low·high·max (thinking always on).
 *   mistral                  extensions/mistral/index.ts:50
 *   ollama                   extensions/ollama/index.ts:226
 *
 * WHAT IS DELIBERATELY EXCLUDED FROM THE PLOTTED LEVELS:
 *   · "off"      — not a thinking effort, it is the absence of one.
 *   · "adaptive" — the MODEL picks the budget, so neither its cost nor its
 *                  smartness is a value we can place on an axis.
 * Both remain in the provider's real profile; they are simply not chart stops.
 */

/** How much effort control the official provider gives you over this model. */
export type EffortLadderKind =
  /** An ordered ladder of named levels (OpenAI, Anthropic, Google, Copilot). */
  | "graded"
  /** Thinking is a switch, not a dial (GLM, Kimi, Moonshot). */
  | "binary"
  /** The provider exposes no thinking control whatsoever (xAI). */
  | "none"
  /** We reach this model through no provider plugin of ours — the AA catalog
   *  tail. We do NOT know its ladder, and guessing one is the bug this file
   *  exists to prevent. */
  | "unknown";

export interface EffortLadder {
  kind: EffortLadderKind;
  /** Ordered thinking levels the provider exposes, "off" and "adaptive" removed.
   *  Empty for kind "none" and "unknown"; a single "low" for kind "binary". */
  levels: string[];
  /** The provider's OWN declared default, when it declares one. */
  defaultLevel?: string;
  /** Human-readable note for the tooltip — why this model has the stops it has. */
  note: string;
}

const CLAUDE_BASE = ["minimal", "low", "medium", "high"];
/** Anthropic effort table 2026-08-27 — no `minimal` on these models. */
const CLAUDE_EFFORT_5 = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_EFFORT_46 = ["low", "medium", "high", "max"]; // Sonnet 4.6 / Opus 4.6: max, no xhigh
const OPENAI_BASE = ["minimal", "low", "medium", "high"];
const OPENAI_56 = ["low", "medium", "high", "xhigh", "max"]; // GPT-5.6: no minimal; max is new

/** extensions/openai/openai-provider.ts:62 — verbatim. */
const OPENAI_XHIGH_IDS = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
];

/** extensions/openai/openai-codex-provider.ts:94 — verbatim. */
const OPENAI_CODEX_XHIGH_IDS = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.3",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
];

/** extensions/github-copilot/index.ts:27 — verbatim. */
const COPILOT_XHIGH_IDS = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.2-codex"];

function bare(modelId: string): string {
  const trimmed = (modelId || "").trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function withXHigh(base: string[], id: string, ids: string[]): string[] {
  return ids.includes(id) ? [...base, "xhigh"] : base;
}

/**
 * The ladder the OFFICIAL provider exposes for this model.
 *
 * `provider` is the route (openai, github-copilot, claude-code, openrouter, …)
 * — deliberately NOT the lab that trained the model, because the effort control
 * belongs to whoever serves the API. Anthropic's own ladder does not apply to a
 * Claude model re-sold through Copilot; Copilot's does.
 */
export function resolveProviderEffortLadder(provider: string, modelId: string): EffortLadder {
  const p = (provider || "").trim().toLowerCase();
  const id = bare(modelId);

  if (p === "anthropic" || p === "claude-code") {
    // Vendor page (effort.md, 2026-08-27), not the in-tree plugin. Opus 5 / Fable 5
    // / Sonnet 5 / Opus 4.8 / Opus 4.7 expose low→max including xhigh. Sonnet 4.6
    // and Opus 4.6 expose max but not xhigh. Older Claude keeps the plugin's
    // minimal→high base.
    // FORK 2026-09-02: `fable-5[.-]1` is listed FIRST and explicitly. The trailing
    // `(?![.\d])` exists to stop `opus-4-7` swallowing an `opus-4-70`, but it also
    // blocked every POINT RELEASE of the 5 class, so Claude Fable 5.1 fell through to
    // the minimal→high base below — losing `xhigh` and `max`, which are precisely its
    // two best rungs (AA 64.8016 and 65.6529, the highest scores on the whole board),
    // while gaining a `minimal` rung Anthropic does not expose for this class.
    // Named rather than generalised: AA publishes low/medium/high/xhigh/max for THIS
    // model, which is evidence for this id and not a licence to loosen the lookahead
    // for every future point release.
    if (/(?:fable-5[.-]1|opus-5|fable-5|sonnet-5|opus-4[.-]8|opus-4[.-]7)(?![.\d])/.test(id)) {
      return {
        kind: "graded",
        levels: [...CLAUDE_EFFORT_5],
        defaultLevel: "high",
        note: "Anthropic effort: low→max (vendor page 2026-08-27)",
      };
    }
    if (/(?:sonnet-4[.-]6|opus-4[.-]6)(?![.\d])/.test(id)) {
      return {
        kind: "graded",
        levels: [...CLAUDE_EFFORT_46],
        defaultLevel: "high",
        note: "Anthropic effort: low/medium/high/max — no xhigh on 4.6",
      };
    }
    return {
      kind: "graded",
      levels: CLAUDE_BASE,
      note: "Anthropic exposes minimal→high for this model class",
    };
  }

  if (p === "openai") {
    if (/gpt-5\.6|gpt-5-6/.test(id)) {
      return {
        kind: "graded",
        levels: [...OPENAI_56],
        defaultLevel: "medium",
        note: "OpenAI GPT-5.6 reasoning_effort: low→max (vendor page 2026-08-27)",
      };
    }
    return {
      kind: "graded",
      levels: withXHigh(OPENAI_BASE, id, OPENAI_XHIGH_IDS),
      note: "OpenAI reasoning_effort",
    };
  }

  if (p === "openai-codex") {
    if (/gpt-5\.6|gpt-5-6/.test(id)) {
      return {
        kind: "graded",
        levels: [...OPENAI_56],
        defaultLevel: "medium",
        note: "OpenAI Codex GPT-5.6 reasoning_effort: low→max",
      };
    }
    return {
      kind: "graded",
      levels: withXHigh(OPENAI_BASE, id, OPENAI_CODEX_XHIGH_IDS),
      note: "OpenAI Codex reasoning_effort",
    };
  }

  if (p === "codex") {
    if (/gpt-5\.6|gpt-5-6/.test(id)) {
      return {
        kind: "graded",
        levels: [...OPENAI_56],
        defaultLevel: "medium",
        note: "Codex CLI GPT-5.6 reasoning_effort: low→max",
      };
    }
    // extensions/codex/provider.ts:247 — a broad prefix test, not an id list.
    const xhigh = /^gpt-5|^o3|^o4/.test(id) || id.includes("codex");
    return {
      kind: "graded",
      levels: xhigh ? [...OPENAI_BASE, "xhigh"] : OPENAI_BASE,
      note: "Codex CLI reasoning_effort",
    };
  }

  if (p === "github-copilot") {
    return {
      kind: "graded",
      levels: withXHigh(OPENAI_BASE, id, COPILOT_XHIGH_IDS),
      note: "Copilot's own ladder — not the original lab's",
    };
  }

  if (p === "google") {
    // extensions/google/provider-hooks.ts:12 — "adaptive" dropped per the note
    // at the top of this file.
    return /gemini-3.*pro/.test(id)
      ? {
          kind: "graded",
          levels: ["low", "high"],
          note: "Gemini 3 Pro exposes low and high only",
        }
      : {
          kind: "graded",
          levels: ["minimal", "low", "medium", "high"],
          note: "Gemini thinkingBudget tiers",
        };
  }

  if (p === "xai") {
    // docs.x.ai reasoning page, fetched 2026-08-27. The in-tree plugin still
    // declares levels:[off] and strips reasoning_effort on the wire — that is a
    // send-path bug, not the vendor's ladder. The chart follows the vendor.
    if (/grok-4\.6|grok-4-6/.test(id)) {
      return {
        kind: "graded",
        levels: ["low", "medium", "high", "xhigh"],
        defaultLevel: "high",
        note: "xAI grok-4.6: low/medium/high/xhigh (vendor page 2026-08-27)",
      };
    }
    if (/grok-4\.5|grok-4-5/.test(id)) {
      return {
        kind: "graded",
        levels: ["low", "medium", "high"],
        defaultLevel: "high",
        note: "xAI grok-4.5: low/medium/high — xhigh is treated as high",
      };
    }
    return {
      kind: "none",
      levels: [],
      defaultLevel: "off",
      note: "xAI: no documented reasoning_effort for this model",
    };
  }

  if (p === "zai") {
    if (/glm-5\.3|glm-5-3/.test(id)) {
      return {
        kind: "graded",
        levels: ["low", "high", "max"],
        defaultLevel: "max",
        note: "Z.AI GLM-5.3: low/high/max, thinking always on (docs.z.ai 2026-08-27)",
      };
    }
    return {
      kind: "binary",
      levels: ["low"],
      defaultLevel: "off",
      note: "thinking is an on/off switch, not a dial",
    };
  }

  if (p === "moonshot" || p === "kimi-coding") {
    if (/kimi-k3|kimi_k3/.test(id)) {
      return {
        kind: "graded",
        levels: ["low", "high", "max"],
        defaultLevel: "max",
        note: "Kimi K3: low/high/max, thinking always on (Moonshot 2026-08-27)",
      };
    }
    return {
      kind: "binary",
      levels: ["low"],
      defaultLevel: "off",
      note: "thinking is an on/off switch, not a dial",
    };
  }

  if (p === "mistral") {
    return id === "mistral-small-latest"
      ? {
          kind: "graded",
          levels: ["high"],
          defaultLevel: "off",
          note: "Mistral Small: off or high",
        }
      : { kind: "graded", levels: OPENAI_BASE, note: "Mistral default ladder" };
  }

  if (p === "ollama") {
    return {
      kind: "graded",
      levels: ["low", "medium", "high", "max"],
      defaultLevel: "off",
      note: "local reasoning model",
    };
  }

  if (p === "openrouter") {
    // OpenRouter forwards reasoning_effort; the lab still owns the enum. When the
    // id names a lab we have a vendor page for, use that ladder. Anything else
    // stays unknown — we do not invent one for Qwen, MiniMax, etc.
    const segs = (modelId || "").toLowerCase().split("/");
    const vendor = segs.length >= 2 ? segs[segs.length - 2] : "";
    const lab =
      vendor === "x-ai" || vendor === "xai"
        ? "xai"
        : vendor === "z-ai" || vendor === "zai"
          ? "zai"
          : vendor === "moonshotai" || vendor === "moonshot"
            ? "moonshot"
            : vendor === "anthropic"
              ? "anthropic"
              : vendor === "openai"
                ? "openai"
                : vendor === "google"
                  ? "google"
                  : /kimi-k3/.test(id)
                    ? "moonshot"
                    : /glm-5[.-]3/.test(id)
                      ? "zai"
                      : /grok-4/.test(id)
                        ? "xai"
                        : /claude-/.test(id)
                          ? "anthropic"
                          : /gpt-5/.test(id)
                            ? "openai"
                            : /gemini-/.test(id)
                              ? "google"
                              : "";
    if (lab) return resolveProviderEffortLadder(lab, id);
  }

  // The AA catalog tail: labs we hold no plugin for and cannot name a vendor
  // page. Inventing a ladder here is precisely the fabrication this module was
  // written to delete.
  return {
    kind: "unknown",
    levels: [],
    note: "no provider plugin — effort ladder unknown, so none is drawn",
  };
}
