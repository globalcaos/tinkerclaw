// THALAMUS v4 — the orchestrate leaf resolver (charter phase E, first consumer; design doc section 12).
//
// WHAT THIS IS FOR. `openclaw-orchestrate` scripts call `agent(task, { model: "auto" })`. This picks the model for that one
// unit: the unit is priced as a fresh point through `routeCall`, exactly as the scheduler prices a plan's units, over the
// rungs of the providers the owner allows (charter ruling C2: `claude-code` only until widened). Effort comes with it.
//
// SHADOW PICKS NOTHING. In shadow the resolver writes down the model it would pick and answers nothing, so `"auto"` is an
// omitted model, as it is with the plugin off. Only `enforce` with `enforce.orchestrateAuto` hands the choice back.
//
// NO PROMPT TEXT IS STORED. The record carries the model, the effort, the price and how many changes the script declared.
//
// FAIL OPEN. No board, no option, a throw: no answer, and the runtime uses its default leaf model.
//
// EVERY OWNED SITE (2026-10-03). The same pricing answers the places that used to name a fixed model: a leaf with no
// model, a sub-agent spawned with no model, the Claude roles of a round-table (`ModelChoiceSite`). `orchestrate-auto`
// acts under `enforce.orchestrateAuto` as before; the rest act under `enforce.ownModelChoices`. Each caller keeps its
// fixed model as the fallback, so an empty answer changes nothing.

import {
  approxTokens,
  classifyTaskDomain,
  type LeafModelChoice,
  type LeafModelRequest,
  type LeafModelResolver,
  type ModelChoiceSite,
  type ThalamusBoardLike,
  type Unit,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusConfig } from "./config.js";
import type { PlanRequest, Scheduler } from "./scheduler.js";
import type { FreshPointRow } from "./store.js";

/** Expected answer size of a leaf unit with no estimate of its own; the script does not declare one. */
export const LEAF_EXPECTED_OUT_TOKENS = 1500;
/** What every spawn adds to the prompt: the persona, the tools, the moral code. A coarse allowance. */
export const LEAF_PROMPT_OVERHEAD_TOKENS = 500;

export type LeafResolverDeps = {
  cfg: () => ThalamusConfig;
  board: (nowMs: number) => ThalamusBoardLike | undefined;
  /** The scheduler's pricing of one unit (its `priceUnit`). */
  priceUnit: Scheduler["priceUnit"];
  now: () => number;
  record: (row: Omit<FreshPointRow, "ts" | "mode">) => void;
  onError?: (err: unknown) => void;
};

/** Whether a pick for this site is handed back, or only written down. */
export function leafActsFor(cfg: ThalamusConfig, site: ModelChoiceSite): boolean {
  if (cfg.mode !== "enforce") return false;
  return site === "orchestrate-auto" ? cfg.enforce.orchestrateAuto : cfg.enforce.ownModelChoices;
}

export function createLeafResolver(
  d: LeafResolverDeps,
): LeafModelResolver & { picks: () => number } {
  let n = 0;
  let picks = 0;
  return {
    picks: () => picks,
    owns(site: ModelChoiceSite): boolean {
      try {
        return leafActsFor(d.cfg(), site);
      } catch {
        return false;
      }
    },
    resolve(req: LeafModelRequest): LeafModelChoice | undefined {
      try {
        const cfg = d.cfg();
        const site = req.site ?? "orchestrate-auto";
        if (cfg.mode === "off") return undefined;
        const nowMs = d.now();
        const full = d.board(nowMs);
        if (!full) return undefined;
        const allowed = new Set(cfg.orchestrate.allowedLeafProviders);
        const board: ThalamusBoardLike = {
          ...full,
          rungs: full.rungs.filter((r) =>
            allowed.has(r.key.slice(0, Math.max(0, r.key.indexOf("/")))),
          ),
        };
        const id = `leaf:${nowMs}:${++n}`;
        const unit: Unit = {
          id,
          task: "",
          kind: "work",
          inputs: [],
          outputs: [],
          writes: req.writes ?? [],
          estIn: Math.max(1, approxTokens(req.prompt) + LEAF_PROMPT_OVERHEAD_TOKENS),
          estOut: LEAF_EXPECTED_OUT_TOKENS,
          model: "auto",
          urgency: "today",
          private: false,
        };
        const plan: PlanRequest = {
          id,
          units: [unit],
          task: { kind: classifyTaskDomain(req.prompt), urgency: "today", shape: "answer" },
        };
        const dec = d.priceUnit(
          plan,
          unit,
          { nowMs, ledger: new Map(), conversationKey: id, slackSec: 0, index: 0 },
          board,
        );
        const acts = leafActsFor(cfg, site);
        if (!dec) {
          d.record({
            id,
            runId: id,
            kind: "leaf",
            acted: false,
            reason: "no-option",
            detail: { label: req.label, site },
          });
          return undefined;
        }
        const key = dec.chosen.rung.key;
        const effort = dec.chosen.rung.effort;
        d.record({
          id,
          runId: id,
          kind: "leaf",
          acted: acts,
          reason: acts ? "picked" : "would-pick",
          model: key,
          detail: {
            effort,
            price: dec.chosen.price,
            site,
            ...(req.label ? { label: req.label } : {}),
            declaredWrites: (req.writes ?? []).length,
            declaredReads: (req.reads ?? []).length,
            ...(req.thinking ? { scriptEffort: req.thinking } : {}),
          },
        });
        if (!acts) return undefined;
        picks += 1;
        return { model: key, ...(effort ? { thinking: effort } : {}) };
      } catch (err) {
        d.onError?.(err);
        return undefined;
      }
    },
  };
}
