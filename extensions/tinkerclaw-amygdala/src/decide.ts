/**
 * The one entry every seam calls (design doc §3 M7). Pure over injected Jev, store, clock and families, so the
 * decision tables of Phase D are plain unit tests.
 *
 * Order (paper §7.2): hard rules first, then precedents, one Jev call for every question the families want,
 * each family's opinion, merge by severity, persist, emit.
 *
 * Judge unavailable (breaker open, timeout, error, or real situations not allowed to leave the machine) → judge
 * checks FAIL OPEN, the verdict rows say why, and the status line goes red. Hard rules are local and never depend
 * on Jev. `failClosedOnLevel3` flips only the level-3 external steps to hold.
 */
import { randomUUID } from "node:crypto";
import type { Companion } from "./companion.js";
import type { AmygdalaConfig } from "./config.js";
import { goalFingerprint, type TurnContexts, type TurnState } from "./context.js";
import { buildDecisionEvents, buildInterventionEvent, withDrivers } from "./events.js";
import type { Family } from "./families/types.js";
import { toHookAction, type HookAction } from "./hook-action.js";
import { noveltyKey } from "./learn/keys.js";
import type { QuestionBook } from "./question-book.js";
import { redactText } from "./redact.js";
import { limitNotes, mergeResponses, type Candidate } from "./respond.js";
import { evaluateRules, type RulesResult } from "./rules.js";
import { buildSituation, type SeamInput, type SessionContext } from "./situation.js";
import type { AmygdalaStore } from "./store.js";
import type {
  FamilyId,
  Cutoff,
  Decision,
  EffectClass,
  Question,
  Response,
  Seam,
  Situation,
  Verdict,
} from "./types.js";

export interface DecideDeps {
  jev: {
    ask(s: Situation, qs: Question[], o?: { budgetMs?: number }): Promise<Verdict[]>;
    /**
     * False while Jev is dormant (no token): nothing is asked and no verdict row is written, which is different from a
     * judge that is down. Absent means on.
     */
    on?(): boolean;
  };
  book: QuestionBook;
  store: AmygdalaStore;
  contexts: TurnContexts;
  families: Family[];
  config: Pick<AmygdalaConfig, "mode" | "failClosedOnLevel3"> &
    Partial<Pick<AmygdalaConfig, "enforceFamilies">>;
  /** Whether the hard-rule floor is active in this process (design doc C19). */
  floorActive: () => boolean;
  /** Jev budget per seam in ms (C5 budget minus 400 ms for the loopback). */
  budgetMs?: Partial<Record<Seam, number>>;
  now?: () => number;
  idGen?: () => string;
  emit?: (event: string, payload: unknown) => void;
  /**
   * Effective cut-off for a question at this step (a per-context override from the learning loop), or undefined for
   * the question's own. Applied before any family sees `asked`, so families never read an override themselves.
   */
  cutoffFor?: (q: Question, s: Situation) => Cutoff | undefined;
  /** Precedent lookup (Phase E). shouldHold raises the step's danger floor by one. */
  precedents?: (s: Situation) => { shouldHold: boolean; refs: string[] };
  rules?: (tool: string, args: string, o?: { enforcedOnly?: boolean }) => RulesResult;
  /** THALAMUS v4: routing questions that ride on this call. Their verdicts are taken out before any family sees them. */
  companion?: Companion;
}

export interface DecideInput {
  seam: Seam;
  payload: SeamInput;
  session: Pick<SessionContext, "workspaceRoot" | "homeDir"> & Partial<SessionContext>;
}

export interface DecideResult {
  id: string;
  decision: Decision;
  situation: Situation;
  verdicts: Verdict[];
  interventionId?: string;
  hard?: { rule: string; explanation: string };
  hook: HookAction;
  /** Interventions an `evidence-released` decision just closed (the runtime labels them as evidence outcomes). */
  released?: string[];
}

const DEFAULT_BUDGET: Record<Seam, number> = {
  prompt: 1600,
  "pre-tool": 2600,
  "post-tool": 1600,
  stop: 4600,
};

const EXTERNAL: EffectClass[] = ["send", "spend", "restart-own-system", "delete"];

function argsText(s: Situation): string {
  if (s.command.value) return s.command.value;
  return JSON.stringify(s.args.value ?? {});
}

export async function decide(deps: DecideDeps, input: DecideInput): Promise<DecideResult> {
  const now = deps.now?.() ?? Date.now();
  const idGen = deps.idGen ?? randomUUID;
  const { seam } = input;
  const state = deps.contexts.get(input.payload.sessionKey, input.payload.turnId);
  if (seam === "pre-tool") deps.contexts.beginCall(state);
  if (seam === "prompt") deps.contexts.notePrompt(input.payload.sessionKey, now);

  const session = deps.contexts.buildSessionContext(
    input.session,
    input.payload.sessionKey,
    input.payload.turnId,
  );
  const situation = buildSituation({ ...input.payload, seam, now }, session);
  // Novelty needs how often this exact thing was touched before (2026-10-03: never filled, so every step looked new).
  // Counted after each tool call, where novelty is asked.
  if (seam === "post-tool" && situation.contextCounts.value === null) {
    situation.contextCounts = {
      value: { seen: deps.store.seenBefore(noveltyKey(situation), now), alarms: 0 },
      origin: "derived",
    };
  }
  const decisionId = idGen();
  const enforceMode = deps.config.mode === "enforce";

  // 1. Hard rules: local, before any judge, never dependent on Jev.
  if (seam === "pre-tool" && situation.tool.value) {
    const rules = deps.rules ?? evaluateRules;
    const r = rules(situation.tool.value, argsText(situation), { enforcedOnly: true });
    if (r.decision === "hard_block" && r.rule) {
      state.turnHeld = true;
      const enforced = deps.floorActive();
      const decision: Decision = {
        situationId: situation.id,
        response: { kind: "hold", ruleOrQuestion: r.rule, releasable: "user-only" },
        family: "hard-rule",
        reasonCode: withDrivers(`hard-rule:${r.rule}`, []),
        verdictIds: [],
        mode: deps.config.mode,
        enforced,
        degraded: false,
      };
      return finish(deps, {
        decisionId,
        situation,
        verdicts: [],
        decision,
        state,
        hard: { rule: r.rule, explanation: r.explanation },
        now,
        toolUseId: input.payload.toolUseId,
      });
    }
  }

  // 2. Precedents (Phase E fills the lookup).
  const pr = deps.precedents?.(situation);
  if (pr) {
    state.precedentFloor = pr.shouldHold ? 1 : 0;
    if (pr.refs.length) situation.similarIncidents = { value: pr.refs, origin: "inferred" };
  }

  state.stepCount += 1;
  state.hurry = deps.contexts.hurry(situation.sessionKey);
  for (const f of deps.families) f.enrich?.(seam, situation, state);

  // 3. One Jev call for every question the families want at this step.
  const byId = new Map<string, Family>();
  const wanted: string[] = [];
  for (const f of deps.families) {
    for (const id of f.questionsFor(seam, situation, state)) {
      if (!wanted.includes(id)) wanted.push(id);
      byId.set(id, f);
    }
  }
  const questions: Question[] = [];
  for (const id of wanted) {
    const q = deps.book.get(id);
    if (q && q.status === "active" && q.seams.includes(seam)) questions.push(q);
  }
  // Dormant (no token): the hard rules above already ran; the judge's questions are simply not asked.
  const jevOn = deps.jev.on?.() ?? true;
  const dormantSkip = !jevOn && questions.length > 0;
  let verdicts: Verdict[] = [];
  if (questions.length && jevOn) {
    const extra = companionQuestions(deps, seam, situation);
    try {
      verdicts = await deps.jev.ask(
        situation,
        extra.length ? [...questions, ...extra] : questions,
        {
          budgetMs: deps.budgetMs?.[seam] ?? DEFAULT_BUDGET[seam],
        },
      );
    } catch (err) {
      console.error("[amygdala] jev.ask threw; treating every answer as unavailable", err);
      verdicts = [...questions, ...extra].map((q) => unavailable(situation, q, now, idGen()));
    }
    if (extra.length) verdicts = splitCompanion(deps, seam, situation, extra, verdicts);
  }
  const consulted = verdicts.some((v) => !v.skipped);
  const notAllowed = verdicts.length > 0 && verdicts.every((v) => v.skipped === "not-allowed");
  const degraded = verdicts.some((v) => v.skipped !== undefined && v.skipped !== "not-allowed");
  const judgeUnavailable = jevOn && questions.length > 0 && !consulted;

  // 4. Every family's opinion (observe first, so a family's state update is visible to the others at this step).
  const asked = new Map(
    questions.map((q) => {
      const c = deps.cutoffFor?.(q, situation);
      return [q.id, c ? { ...q, cutoff: c } : q] as const;
    }),
  );
  for (const f of deps.families) f.observe?.(seam, situation, verdicts, state, asked);
  const cands: Candidate[] = [];
  const driversByCand = new Map<Candidate, string[]>();
  // A family that found a refusal but returned something heavier (double-check: a claim send-back) flags it.
  let refusalInsideFamily = false;
  for (const f of deps.families) {
    const res = f.decide(seam, situation, verdicts, state, asked);
    if (!res) continue;
    if (res.alsoRefusal) refusalInsideFamily = true;
    const c: Candidate = { response: res.response, family: f.id, reasonCode: res.reasonCode };
    driversByCand.set(c, res.drivers);
    cands.push(c);
  }
  // Judge out (or dormant): level-3 external steps hold only when configured to fail closed; everything else proceeds.
  if ((judgeUnavailable || dormantSkip) && seam === "pre-tool") {
    const external =
      situation.effectClass.value !== null && EXTERNAL.includes(situation.effectClass.value);
    if (deps.config.failClosedOnLevel3 && external) {
      cands.push({
        response: { kind: "hold", ruleOrQuestion: "fallback-level3", releasable: "user-only" },
        family: "fallback",
        reasonCode: "fallback-level3",
      });
    }
  }

  // A refusal is logged for the router ALWAYS: whether or not the user ever presses Rewind, and even when a hold
  // outranks it in the merge below (paper §6.3).
  if (refusalInsideFamily || cands.some((c) => c.response.kind === "refusal")) {
    deps.emit?.("amygdala2.refusal", {
      sessionKey: situation.sessionKey,
      turnId: situation.turnId,
      ts: now,
      redactedExample: redactText(String(situation.reply.value ?? "").slice(0, 300), {
        homeDir: input.session.homeDir,
      }),
    });
  }

  // A held request gets no Rewind strip (paper §6.3); the event above already went out.
  const merged = state.turnHeld ? cands.filter((c) => c.response.kind !== "refusal") : cands;

  // 5. Merge by severity, then the note and send-back limits.
  let best = mergeResponses(merged);
  let drivers = driversByCand.get(best) ?? [];
  let response: Response = limitNotes(best.response, state);
  if (response.kind === "proceed" && best.response.kind === "note") {
    best = { response, family: best.family, reasonCode: "note-suppressed" };
    drivers = [];
  }
  if (response.kind === "send-back" && state.sendBackAttempts >= 2) {
    deps.emit?.("amygdala2.marker", {
      sessionKey: situation.sessionKey,
      turnId: situation.turnId,
      kind: "unsupported-after-two",
      items: drivers,
    });
    response = { kind: "proceed" };
    best = { response, family: best.family, reasonCode: "send-back-cap" };
  }

  // The refusal strip is an offer to the user, not an enforcement: when a note, proof check or send-back outranks it in
  // the merge, it is still offered (2026-09-30, CTO tab: a refusal hidden behind a claim send-back). A hold keeps the
  // paper §6.3 rule: no strip for a held request (`merged` already drops it once the turn is held).
  const refusalAlso =
    response.kind !== "refusal" &&
    response.kind !== "hold" &&
    (merged.some((c) => c.response.kind === "refusal") || (refusalInsideFamily && !state.turnHeld));

  const family =
    best.family === "fallback" || best.family === "hard-rule"
      ? best.family
      : (best.family as Decision["family"]);
  const fallbackCode = dormantSkip
    ? "jev-dormant"
    : judgeUnavailable
      ? notAllowed
        ? "jev-not-consulted"
        : "jev-unavailable"
      : null;
  const code = response.kind === "proceed" && fallbackCode ? fallbackCode : best.reasonCode;
  if (response.kind === "hold") state.turnHeld = true;
  const decision: Decision = {
    situationId: situation.id,
    response,
    family: response.kind === "proceed" && (judgeUnavailable || dormantSkip) ? "fallback" : family,
    reasonCode: withDrivers(code, response.kind === "proceed" ? [] : drivers),
    verdictIds: verdicts.map((v) => v.id),
    mode: deps.config.mode,
    // A family listed in `enforceFamilies` acts while the rest stays in shadow, and only with a note: it adds a line to
    // the agent's context and can never hold or block (the architect 2026-10-03, personality first).
    enforced:
      response.kind !== "proceed" &&
      (enforceMode ||
        (response.kind === "note" &&
          (deps.config.enforceFamilies ?? []).includes(family as FamilyId))),
    degraded,
  };
  return finish(deps, {
    decisionId,
    situation,
    verdicts,
    decision,
    state,
    now,
    toolUseId: input.payload.toolUseId,
    refusalAlso,
  });
}

/** The companion's questions for this step; none when there is no companion or it fails. */
function companionQuestions(deps: DecideDeps, seam: Seam, s: Situation): Question[] {
  try {
    return deps.companion?.questionsFor(seam, s) ?? [];
  } catch {
    return [];
  }
}

/** Hand the companion its verdicts and return the rest: the amygdala's own logic sees only its own answers. */
function splitCompanion(
  deps: DecideDeps,
  seam: Seam,
  s: Situation,
  extra: Question[],
  all: Verdict[],
): Verdict[] {
  const ids = new Set(extra.map((q) => q.id));
  try {
    deps.companion?.observe(
      seam,
      s,
      all.filter((v) => ids.has(v.questionId)),
    );
  } catch {
    /* the routing side never breaks the guard */
  }
  return all.filter((v) => !ids.has(v.questionId));
}

function unavailable(s: Situation, q: Question, ts: number, id: string): Verdict {
  return {
    id,
    situationId: s.id,
    questionId: q.id,
    questionVersion: q.version,
    type: q.type,
    answer: q.type === "choice" ? "" : 0,
    prob: 0,
    confidence: 0,
    cacheHit: false,
    latencyMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    skipped: "error",
    ts,
  };
}

interface Finish {
  decisionId: string;
  situation: Situation;
  verdicts: Verdict[];
  decision: Decision;
  state: TurnState;
  hard?: { rule: string; explanation: string };
  now: number;
  toolUseId?: string;
  /** A refusal lost the merge to a note, proof check or send-back: offer its strip as a second intervention. */
  refusalAlso?: boolean;
}

/** Persist, track holds and send-backs, emit events, and work out what the hook should do. */
function finish(deps: DecideDeps, f: Finish): DecideResult {
  const { decision, situation, verdicts, state } = f;
  const kind = decision.response.kind;
  const idGen = deps.idGen ?? randomUUID;

  deps.store.saveSituation(situation, null);
  if (verdicts.length) deps.store.saveVerdicts(verdicts);
  deps.store.saveDecision(decision, { id: f.decisionId, seam: situation.seam, ts: f.now });

  // Evidence released a hold (safety, design 5.1 row "proof outstanding"): settle the hold and its intervention.
  const released: string[] = [];
  if (decision.reasonCode.startsWith("evidence-released")) {
    const hold = deps.store.getOpenHold(goalFingerprint(situation));
    if (hold) {
      deps.store.updateHold(hold.id, { state: "released", releasedBy: "evidence" });
      for (const iv of deps.store.listInterventions({ state: "open" })) {
        if (iv.decisionId === hold.decisionId) {
          deps.store.closeIntervention(iv.id, "released", f.now, "evidence");
          released.push(iv.id);
        }
      }
    }
  }

  let interventionId: string | undefined;
  if (kind !== "proceed") {
    interventionId = idGen();
    // Only enforced decisions can be open or denied. In shadow the row is a record of what WOULD have happened.
    const istate = interventionState(decision, kind, f.hard !== undefined);
    deps.store.openIntervention({
      id: interventionId,
      decisionId: f.decisionId,
      kind,
      state: istate,
      ts: f.now,
      ...(istate !== "open" ? { closedTs: f.now } : {}),
    });
    if (decision.enforced && (kind === "hold" || kind === "proof" || kind === "ask")) {
      const goalFp = goalFingerprint(situation);
      deps.store.saveHold({
        id: idGen(),
        decisionId: f.decisionId,
        stepSig: goalFp,
        goalFp,
        needs: decision.response.kind === "proof" ? decision.response.needs : [],
        ts: f.now,
      });
      deps.contexts.recordHold(situation.sessionKey, goalFp, f.now);
    }
    if (decision.enforced && kind === "send-back") deps.contexts.bumpSendBack(state);
  }

  let refusalIv: { id: string; state: "open" | "settled" } | undefined;
  if (f.refusalAlso) {
    // Same state a refusal gets when it wins: open when enforcing, a record in shadow.
    refusalIv = { id: idGen(), state: deps.config.mode === "enforce" ? "open" : "settled" };
    deps.store.openIntervention({
      id: refusalIv.id,
      decisionId: f.decisionId,
      kind: "refusal",
      state: refusalIv.state,
      ts: f.now,
      ...(refusalIv.state !== "open" ? { closedTs: f.now } : {}),
    });
  }

  const ctx = {
    situation,
    verdicts,
    decision,
    decisionId: f.decisionId,
    book: deps.book,
    interventionId,
    toolUseId: f.toolUseId,
  };
  if (deps.emit) {
    // The judge did not answer (real steps stay local by default, or it is down): say so once per step, so the chat can
    // show "not consulted" instead of an empty window that reads as "nothing was checked".
    if (
      situation.seam === "pre-tool" &&
      /^jev-(not-consulted|unavailable)/.test(decision.reasonCode)
    ) {
      deps.emit("amygdala2.consult", {
        sessionKey: situation.sessionKey,
        turnId: situation.turnId,
        ts: f.now,
        state: decision.reasonCode.startsWith("jev-not-consulted")
          ? "real-steps-stay-local"
          : "judge-down",
      });
    }
    for (const e of buildDecisionEvents(ctx)) deps.emit("amygdala2.decision", e);
    const ie = buildInterventionEvent({
      ...ctx,
      state: interventionState(decision, kind, f.hard !== undefined),
    });
    if (ie) deps.emit("amygdala2.intervention", ie);
    if (refusalIv) {
      const re = buildInterventionEvent({
        ...ctx,
        decision: { ...decision, response: { kind: "refusal" } },
        interventionId: refusalIv.id,
        state: refusalIv.state,
      });
      if (re) deps.emit("amygdala2.intervention", re);
    }
  }

  const hook = toHookAction(situation.seam, { decision, interventionId, hard: f.hard });
  return {
    id: f.decisionId,
    decision,
    situation,
    verdicts,
    interventionId,
    hard: f.hard,
    hook,
    ...(released.length ? { released } : {}),
  };
}

function interventionState(
  d: Decision,
  kind: Response["kind"],
  hard: boolean,
): "open" | "denied" | "settled" {
  if (!d.enforced) return "settled";
  if (hard) return "denied";
  return kind === "note" ? "settled" : "open";
}
