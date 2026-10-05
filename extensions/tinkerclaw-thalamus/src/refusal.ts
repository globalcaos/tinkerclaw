// Refusal detection and the retry pick (full deploy, 2026-10-02).
//
// WHAT THIS IS FOR. the architect's decision: refusals are DETECTED, never re-routed. When the end-of-turn outcome read
// (the same Jev call the amygdala was making anyway) says a turn was refused, the page needs to draw two buttons under
// that reply: "Rewind" and "Rewind and retry with ‹model›". This file produces the one fact the second button needs, as a
// gateway event (`thalamus.refusal`) and as a method (`thalamus.retryPick`), and nothing else:
//   - it changes no route and applies no veto (the router still never passes `refusals`);
//   - it sends no message and retries nothing (the page does that, on a click, through the rewind it already has);
//   - it writes no file (learning already records refusals for the night).
//
// WHICH MODEL REFUSED. The outcome read carries the session and the turn, not the model. The model comes from what this
// plugin has seen on the bus for that session: the gateway's own per-turn decision (`stream: "thalamus"`, phase
// `decision`, which names the model, the effort and the task's domain). A tab on a hand-picked model has no such
// decision, so `thalamus.retryPick` also takes the model from the caller (the page knows what the refused reply ran on).
// With no model known the answer is "no pick", never a guess.
//
// THE RETRY MODEL is `retryPick` (src/shared/thalamus-retry-pick.ts): the best model for the task's domain from another
// VENDOR, not cooling, not unfunded, and for a private source only from the providers approved for private content.
//
// ONE EVENT PER TURN. A turn's outcome can be read at more than one seam (post-tool, stop); the first sure "refused" per
// (session, turn) is announced and the rest are dropped.
//
// FAIL OPEN. Everything here is best effort: a throw is reported through `onError` and the run is untouched.

import {
  isPrivateSource,
  retryPick,
  supplyOfKey,
  type OutcomeRead,
  type RetryPick,
  type TaskDomain,
  type ThalamusBoardLike,
} from "openclaw/plugin-sdk/fork-thalamus";
import type { ThalamusConfig } from "./config.js";
import { sourceOfSessionKey } from "./context-view.js";

export type RefusalEvent = {
  sessionKey: string;
  /** The gateway run of the refused reply, when the bus showed one for the session. */
  runId?: string;
  /** The amygdala's turn id for the refused exchange. */
  turnId: string;
  /** The model that refused, `provider/model`, when known. */
  model?: string;
  /** The vendor (supply) of that model. */
  family?: string;
  domain: string;
  /** The model the retry button would use, or null with the reason there is none. */
  retry: { model: string; effort: string; family: string; reason: string } | null;
  retryReason?: string;
  ts: number;
};

export type RetryPickAnswer =
  | {
      ok: true;
      pick: RetryPick | null;
      refusing?: { model: string; family: string };
      reason?: string;
    }
  | { ok: false; error: string };

export type RefusalDeps = {
  cfg: () => ThalamusConfig;
  board: (nowMs: number) => ThalamusBoardLike | undefined;
  now: () => number;
  broadcast: (name: string, payload: unknown) => void;
  onError?: (err: unknown) => void;
};

type EventLike = {
  runId?: string;
  sessionKey?: string;
  stream?: string;
  data?: Record<string, unknown>;
};

type Seen = { runId?: string; model?: string; effort?: string; domain?: string };

const KEEP = 256;

export function createRefusalWatcher(d: RefusalDeps) {
  const bySession = new Map<string, Seen>();
  const announced = new Set<string>();
  let count = 0;
  let lastAt: number | undefined;

  const touch = (sessionKey: string): Seen => {
    let s = bySession.get(sessionKey);
    if (!s) {
      s = {};
      bySession.set(sessionKey, s);
      while (bySession.size > KEEP) bySession.delete(bySession.keys().next().value as string);
    }
    return s;
  };

  /** The bus: remember, per session, the run and the gateway's own pick for the latest turn. Cheap and never throws. */
  function noteEvent(evt: EventLike): void {
    try {
      const sessionKey = evt.sessionKey;
      if (!sessionKey || !evt.data) return;
      if (evt.stream === "lifecycle" && evt.data.phase === "start" && evt.runId) {
        touch(sessionKey).runId = evt.runId;
      } else if (evt.stream === "thalamus" && evt.data.phase === "decision") {
        const s = touch(sessionKey);
        if (typeof evt.data.model === "string") s.model = evt.data.model;
        if (typeof evt.data.effort === "string") s.effort = evt.data.effort;
        if (typeof evt.data.domain === "string") s.domain = evt.data.domain;
      }
    } catch (err) {
      d.onError?.(err);
    }
  }

  function pickFor(i: { sessionKey: string; model?: string; domain?: string }): RetryPickAnswer {
    const seen = bySession.get(i.sessionKey);
    const model = i.model || seen?.model;
    const domain = (i.domain || seen?.domain || "general") as TaskDomain;
    if (!model || model.indexOf("/") <= 0) {
      return { ok: true, pick: null, reason: "the model that refused is not known" };
    }
    const nowMs = d.now();
    const board = d.board(nowMs);
    if (!board) return { ok: true, pick: null, refusing: refusing(model), reason: "no board" };
    const cfg = d.cfg();
    const priv = isPrivateSource(sourceOfSessionKey(i.sessionKey), cfg.privacy.privateSources);
    const pick = retryPick({
      rungs: board.rungs,
      supplies: board.supplies,
      refusingKey: model,
      domain,
      cooling: board.cooling,
      unfunded:
        process.env.OPENCLAW_THALAMUS_ALLOW_OPENROUTER === "on"
          ? undefined
          : new Set(["openrouter"] as const),
      contextWindowFor: board.contextWindowFor,
      ...(priv ? { allowedProviders: cfg.privacy.approvedProviders } : {}),
      nowMs,
    });
    return {
      ok: true,
      pick: pick ?? null,
      refusing: refusing(model),
      ...(pick
        ? {}
        : {
            reason: priv
              ? "private source: no approved provider outside the one that refused"
              : "no model of another vendor can take the turn",
          }),
    };
  }

  const refusing = (model: string) => ({ model, family: supplyOfKey(model) });

  /** `thalamus.retryPick {sessionKey, model?, domain?}`. */
  function retryPickFor(i: {
    sessionKey?: unknown;
    model?: unknown;
    domain?: unknown;
  }): RetryPickAnswer {
    try {
      if (typeof i.sessionKey !== "string" || !i.sessionKey) {
        return { ok: false, error: "sessionKey is required" };
      }
      return pickFor({
        sessionKey: i.sessionKey,
        ...(typeof i.model === "string" ? { model: i.model } : {}),
        ...(typeof i.domain === "string" ? { domain: i.domain } : {}),
      });
    } catch (err) {
      d.onError?.(err);
      return { ok: false, error: String(err) };
    }
  }

  /** A routing outcome read from the provider. Announces the first sure "refused" per (session, turn). */
  function observeOutcome(r: { sessionKey: string; turnId: string; outcome: OutcomeRead }): void {
    try {
      const a = r.outcome.state;
      if (a.value !== "refused") return;
      if (a.source === "fallback" || a.conf < d.cfg().reads.confidenceFloor) return;
      const key = `${r.sessionKey}:${r.turnId}`;
      if (announced.has(key)) return;
      announced.add(key);
      while (announced.size > KEEP) announced.delete(announced.values().next().value as string);
      const seen = bySession.get(r.sessionKey);
      const ans = pickFor({ sessionKey: r.sessionKey });
      const pick = ans.ok ? ans.pick : null;
      const event: RefusalEvent = {
        sessionKey: r.sessionKey,
        ...(seen?.runId ? { runId: seen.runId } : {}),
        turnId: r.turnId,
        ...(seen?.model ? { model: seen.model, family: supplyOfKey(seen.model) } : {}),
        domain: seen?.domain ?? "general",
        retry: pick
          ? { model: pick.model, effort: pick.effort, family: pick.family, reason: pick.reason }
          : null,
        ...(ans.ok && !pick && ans.reason ? { retryReason: ans.reason } : {}),
        ts: d.now(),
      };
      count += 1;
      lastAt = event.ts;
      d.broadcast("thalamus.refusal", event);
    } catch (err) {
      d.onError?.(err);
    }
  }

  return {
    noteEvent,
    observeOutcome,
    retryPick: retryPickFor,
    stats: () => ({ refusals: count, ...(lastAt ? { lastAt } : {}) }),
  };
}

export type RefusalWatcher = ReturnType<typeof createRefusalWatcher>;
