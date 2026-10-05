/**
 * The safety family (design doc §5.1, paper §6.1): decides how much proof a tool call needs before it runs, from how
 * irreversible the effect is (danger 0-3) and how likely the request is misread (set by second opinion in the turn
 * state). Pre-tool only. Pure: cut-offs come from the asked questions, never from numbers written here.
 */
import { basename } from "node:path";
import type { TurnState } from "../context.js";
import { adjustDanger, cellToResponse, type Danger, proofCell } from "../respond.js";
import type { EvidenceKind, Response, Seam, Situation, Verdict } from "../types.js";
import { clip, crosses, crossesId, isCannotTell, levelOf, optionProb, pick } from "./common.js";
import type { AskedQuestions, Family, FamilyResult } from "./types.js";
import type { FamilyDeps } from "./util.js";

const REMOTE_MENTION = /\b(scp|rsync|curl|wget|upload|share|publish)\b/i;
const OWN_SYSTEM_MENTION = /gateway|systemctl|openclaw/i;
const WIDE_DESTINATIONS = ["shared", "public"] as const;

/** Every piece of text a step exposes: command, argument values and target paths. */
function stepText(s: Situation): string {
  const parts: string[] = [];
  if (s.command.value) parts.push(s.command.value);
  if (s.args.value) parts.push(JSON.stringify(s.args.value));
  for (const t of s.targets.value ?? []) parts.push(t.path);
  return parts.join(" ");
}

function isPlainRead(s: Situation): boolean {
  if (s.effectClass.value !== "read") return false;
  return !(s.provenance.value ?? []).some((p) => p.instructionLike);
}

/** The step sends, spends, restarts the own system or deletes, or moves data to a URL/address/host/remote. */
function movesData(s: Situation): boolean {
  const targets = s.targets.value ?? [];
  return (
    s.effectClass.value === "send" ||
    targets.some((t) => t.kind === "url" || t.kind === "address" || t.kind === "host") ||
    REMOTE_MENTION.test(stepText(s))
  );
}

/**
 * Steps the destructive-worded quote question cannot speak for: they send, spend, restart the own system or move data.
 * A delete is NOT in this set on purpose: the question is about deletes and separates running from quoting well
 * (paper §5.4), so its "does not run" answer still silences a delete-classed step that only mentions one.
 */
function isExternal(s: Situation): boolean {
  const e = s.effectClass.value;
  return e === "send" || e === "spend" || e === "restart-own-system" || movesData(s);
}

export function createSafetyFamily(_deps: FamilyDeps): Family {
  return {
    id: "safety",

    questionsFor(seam: Seam, s: Situation): string[] {
      if (seam !== "pre-tool") return [];
      if (isPlainRead(s)) return [];
      const effect = s.effectClass.value;
      const targets = s.targets.value ?? [];
      const text = stepText(s);
      const ids = ["runs-or-quotes", "danger-level", "instruction-source"];

      if (movesData(s)) ids.push("data-tier", "destination-privacy");
      if (
        (effect === "send" || effect === "spend" || effect === "delete") &&
        (s.toolRecord.value ?? []).length > 0
      ) {
        ids.push("repeat-effect");
      }
      if (targets.length > 0 && (s.targetHistory.value?.edits72h ?? 0) > 0) {
        ids.push("recent-investment");
      }
      if (effect === "restart-own-system" || OWN_SYSTEM_MENTION.test(text)) {
        ids.push("stops-own-system");
      }
      if ((s.recentHolds.value ?? []).length > 0) ids.push("same-goal-as-held");
      if ((s.holdNeeds.value ?? []).length > 0) ids.push("evidence-present");
      return ids;
    },

    decide(
      seam: Seam,
      s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): FamilyResult | null {
      if (seam !== "pre-tool") return null;

      // 1. A mention is not a step. Unanswered (judge out) is treated the same: no opinion. The question is worded
      // about destructive effects, so its "does not run" answer only silences steps that neither leave the machine
      // nor move data: a copy of a CV to a shared place is not destructive, and must still reach the table.
      const runs = pick(verdicts, "runs-or-quotes");
      const runsOk = runs !== undefined && crosses(asked.get("runs-or-quotes"), runs);
      if (!isExternal(s) && !runsOk) return null;

      // 2. Evidence release: the needs of an open hold are met by evidence, never by rephrasing.
      const needs = s.holdNeeds.value ?? [];
      const ev = pick(verdicts, "evidence-present");
      if (needs.length > 0 && ev && evidenceMet(needs, ev, asked)) {
        return {
          response: { kind: "proceed" },
          drivers: ["evidence-present"],
          reasonCode: "evidence-released",
        };
      }

      // 3. Planted instruction.
      if (crossesId(asked, verdicts, "instruction-source")) {
        return {
          response: { kind: "hold", ruleOrQuestion: "instruction-source", releasable: "user-only" },
          drivers: ["instruction-source"],
          reasonCode: "planted-instruction",
        };
      }

      // 4. Retry after a hold: same goal, new words.
      if (crossesId(asked, verdicts, "same-goal-as-held")) {
        return {
          response: { kind: "hold", ruleOrQuestion: "same-goal-as-held", releasable: "user-only" },
          drivers: ["same-goal-as-held"],
          reasonCode: "retry-after-hold",
        };
      }

      // 5. The proof table.
      const danger = pick(verdicts, "danger-level");
      if (!danger) return null;
      let base = Math.min(3, Math.max(0, Math.round(levelOf(danger)))) as Danger;
      // The danger cut-off is what the learning loop retunes, so it has to govern the table. At the seed value (2) the
      // plain rounding stands; a tightened cut-off (< 2) lifts a reading at or above it to at least danger 2, and a
      // loosened one (> 2) holds a reading below it at danger 2 at most.
      const dq = asked.get("danger-level")?.cutoff;
      if (dq?.kind === "level" && dq.atOrAbove !== undefined) {
        const level = levelOf(danger);
        if (dq.atOrAbove < 2 && level >= dq.atOrAbove) base = Math.max(base, 2) as Danger;
        else if (dq.atOrAbove > 2 && level < dq.atOrAbove) base = Math.min(base, 2) as Danger;
      }

      const recent = crossesId(asked, verdicts, "recent-investment");
      const stops = crossesId(asked, verdicts, "stops-own-system");
      const egress = egressTier3(verdicts, asked);
      const repeat =
        crossesId(asked, verdicts, "repeat-effect") && !failedEarlier(s, s.toolRecord.value ?? []);
      const precedent = state.precedentFloor > 0;
      const d = adjustDanger(base, {
        recentInvestment: recent,
        precedentShouldHold: precedent,
        stopsOwnSystem: stops,
        egressTier3: egress,
        repeatUnresolved: repeat,
      });

      const targets = s.targets.value ?? [];
      const request = s.request.value ?? "";
      const namedExact =
        targets.length > 0 && targets.every((t) => request.includes(basename(t.path)));
      const cell = proofCell(d, state.misreadingRisk, namedExact);
      if (cell.kind === "proceed") return null;

      const effect = s.effectClass.value ?? "other";
      const needList = proofNeeds(effect, { recent, repeat, stops, namedExact });
      const open = state.readings.filter((r) => r.status === "open").slice(0, 2);
      const response: Response = cellToResponse(cell, {
        slots: {
          what: `${effect} ${clip(targets[0]?.path ?? s.command.value ?? s.tool.value)}`,
          needs: needList.join(", "),
          reading: "the request as understood",
          fact: recent
            ? `edited ${s.targetHistory.value?.edits72h ?? "several"} times this week`
            : effect === "send" || effect === "spend"
              ? `effect: ${effect}`
              : "not in a scratch area",
        },
        needs: needList,
        askId: `ask-${s.id}`,
        options: [
          { id: "go", label: "Continue as understood" },
          ...open.map((r) => ({ id: r.id, label: r.label })),
          { id: "other", label: "Something else..." },
        ],
        preselect: "go",
        reason: "danger-level",
      });

      const drivers = ["danger-level"];
      const adjustments: [string, boolean][] = [
        ["recent-investment", recent],
        ["stops-own-system", stops],
        ["data-tier", egress],
        ["destination-privacy", egress],
        ["repeat-effect", repeat],
      ];
      for (const [id, on] of adjustments) if (on) drivers.push(id);
      return {
        response,
        drivers,
        reasonCode: `table-d${d}-${state.misreadingRisk}${cell.authorise ? "-authorise" : ""}`,
      };
    },
  };
}

/** Every needed kind reaches the cut-off and "none-shown" does not lead. */
function evidenceMet(needs: EvidenceKind[], v: Verdict, asked: AskedQuestions): boolean {
  const q = asked.get("evidence-present");
  if (!q || q.cutoff.kind !== "choice") return false;
  if (isCannotTell(v) || v.answer === "none-shown") return false;
  const at = q.cutoff.at;
  return needs.every(
    (n) => optionProb(v, n) >= at && optionProb(v, n) >= optionProb(v, "none-shown"),
  );
}

/** Data of the harmful tier goes to a shared or public place, both answers past their cut-offs. */
function egressTier3(verdicts: readonly Verdict[], asked: AskedQuestions): boolean {
  if (!crossesId(asked, verdicts, "data-tier")) return false;
  const dest = pick(verdicts, "destination-privacy");
  const q = asked.get("destination-privacy");
  if (!dest || !q || q.cutoff.kind !== "choice" || isCannotTell(dest)) return false;
  const at = q.cutoff.at;
  return WIDE_DESTINATIONS.some((o) => optionProb(dest, o) >= at);
}

/**
 * Has the agent shown that an earlier try of this very step failed? argsDigest is a short digest, not the command, so
 * a digest matches when every one of its tokens (basename for paths) appears among the command's tokens.
 */
function failedEarlier(
  s: Situation,
  record: readonly { tool: string; argsDigest: string; exit: number | null }[],
): boolean {
  const own = new Set(
    (s.command.value ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => basename(t)),
  );
  return record.some((e) => {
    if (e.exit === null || e.exit === 0) return false;
    const toks = e.argsDigest.split(/\s+/).filter(Boolean);
    return toks.length > 0 && toks.every((t) => own.has(basename(t)));
  });
}

function proofNeeds(
  effect: string,
  f: { recent: boolean; repeat: boolean; stops: boolean; namedExact: boolean },
): EvidenceKind[] {
  const out = new Set<EvidenceKind>();
  if (effect === "delete") {
    for (const k of ["listing", "references", "backup"] as const) out.add(k);
    if (!f.namedExact) out.add("user-request");
  }
  if (effect === "send" || effect === "spend" || f.stops) out.add("user-request");
  if (f.recent) out.add("backup");
  if (f.repeat) out.add("prior-failure");
  return out.size > 0 ? [...out] : ["user-request"];
}
