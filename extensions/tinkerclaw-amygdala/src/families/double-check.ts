import { hasCompletionVerb, missingFor, splitClaims, supportedBy } from "../claims.js";
/**
 * Double-check family (design doc §5.2, paper §6.3): the reply says something was done and the tool record does not
 * show it, the work was dodged, a live system is claimed fixed without a check, the reply refuses an allowed task,
 * or a step weakens the check that grades the agent's own work. Claims and the tool record come from code
 * (claims.ts, transcript.ts); the judge only says whether the record supports them.
 */
import type { TurnState } from "../context.js";
import { severity } from "../respond.js";
import { readTranscriptTail } from "../transcript.js";
import type { Claim, Response, Seam, Situation, ToolRecordEntry, Verdict } from "../types.js";
import { CANNOT_TELL, clip, crossesId, isCannotTell, pick } from "./common.js";
import type { AskedQuestions, Family, FamilyResult } from "./types.js";
import type { FamilyDeps } from "./util.js";

const CHECK_RE =
  /test|spec|__tests__|vitest|jest|pytest|\.github\/workflows|lint|threshold|coverage/i;
const WEAKENING_EFFECTS = new Set(["local-write", "other", "delete"]);

const PROBLEM: Record<string, string> = {
  placeholder: "leaves a placeholder",
  "handed-back": "hands the work back",
  "question-open": "leaves your question open",
  "promise-later": "promises later work that nothing will run",
  "unverified-fix": "reports a fix that was not verified in this task",
};

const replyOf = (s: Situation): string => (typeof s.reply?.value === "string" ? s.reply.value : "");
const recordOf = (s: Situation): ToolRecordEntry[] => s.toolRecord?.value ?? [];

/** Done claims; when the splitter found none but a sentence still carries a completion verb, the whole reply. */
function doneClaims(s: Situation): Claim[] {
  const claims = s.claims?.value ?? splitClaims(replyOf(s));
  const done = claims.filter((c) => c.kind === "done");
  if (done.length > 0) return done;
  const reply = replyOf(s);
  if (reply && hasCompletionVerb(reply))
    return [{ text: clip(reply, 120), kind: "done", source: null, support: null }];
  return [];
}

const stateClaims = (s: Situation): Claim[] =>
  (s.claims?.value ?? splitClaims(replyOf(s))).filter((c) => c.kind === "state");

function weakensCheckRelevant(s: Situation): boolean {
  const eff = s.effectClass?.value;
  if (!eff || !WEAKENING_EFFECTS.has(eff)) return false;
  const paths = (s.targets?.value ?? []).map((t) => t.path);
  return [s.command?.value ?? "", ...paths].some((x) => CHECK_RE.test(x));
}

/** Probability mass on the dodge options a family may act on (complete and cannot-tell never count). */
function dodgeOption(v: Verdict, asked: AskedQuestions, ignorePromise: boolean): string | null {
  if (isCannotTell(v)) return null;
  const skip = new Set(["complete", CANNOT_TELL, ...(ignorePromise ? ["promise-later"] : [])]);
  const probs = v.probs ?? { [String(v.answer)]: v.prob };
  let best: string | null = null;
  let mass = 0;
  for (const [o, p] of Object.entries(probs)) {
    if (skip.has(o)) continue;
    mass += p;
    if (best === null || p > (probs[best] ?? 0)) best = o;
  }
  const c = asked.get("dodged-work")?.cutoff;
  const at = c && c.kind === "choice" ? c.at : Number.POSITIVE_INFINITY;
  return mass >= at ? best : null;
}

export function createDoubleCheckFamily(_deps: FamilyDeps): Family {
  return {
    id: "double-check",

    enrich(seam: Seam, s: Situation, state: TurnState): void {
      if (seam !== "stop") return;
      if (!s.claims || s.claims.value == null)
        s.claims = { value: splitClaims(replyOf(s)), origin: "derived" };
      if (state.transcriptPath) {
        const tail = readTranscriptTail(state.transcriptPath);
        const have = s.toolRecord?.value;
        if (!have || have.length < tail.toolRecord.length)
          s.toolRecord = { value: tail.toolRecord, origin: "observed" };
      }
    },

    questionsFor(seam: Seam, s: Situation): string[] {
      if (seam === "pre-tool") return weakensCheckRelevant(s) ? ["weakens-own-check"] : [];
      if (seam !== "stop") return [];
      const ids: string[] = [];
      if (replyOf(s)) ids.push("refusal");
      ids.push("dodged-work");
      if (doneClaims(s).length > 0) ids.push("claim-record", "claim-support", "claim-source");
      if (stateClaims(s).length > 0) ids.push("stale-state-claim");
      return ids;
    },

    decide(
      seam: Seam,
      s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): FamilyResult | null {
      if (seam === "pre-tool") {
        return crossesId(asked, verdicts, "weakens-own-check")
          ? {
              response: {
                kind: "hold",
                ruleOrQuestion: "weakens-own-check",
                releasable: "user-only",
              },
              drivers: ["weakens-own-check"],
              reasonCode: "weakens-own-check",
            }
          : null;
      }
      if (seam !== "stop") return null;

      const cands: FamilyResult[] = [];
      const record = recordOf(s);
      const sendBack = (templateId: string, slots: Record<string, string>): Response => ({
        kind: "send-back",
        templateId,
        slots,
        attempt: state.sendBackAttempts >= 1 ? 2 : 1,
      });

      if (crossesId(asked, verdicts, "refusal"))
        cands.push({ response: { kind: "refusal" }, drivers: ["refusal"], reasonCode: "refusal" });

      if (state.sendBackAttempts < 2) {
        // 2. done claims
        const support = pick(verdicts, "claim-support");
        const supportAt = asked.get("claim-support")?.cutoff;
        const weakSupport =
          support !== undefined &&
          supportAt?.kind === "prob" &&
          !isCannotTell(support) &&
          support.prob < supportAt.at;
        const drivers: string[] = [];
        if (crossesId(asked, verdicts, "claim-record")) drivers.push("claim-record");
        if (weakSupport) drivers.push("claim-support");
        if (drivers.length > 0) {
          const done = doneClaims(s);
          const claim = done.find((c) => c.support === false || !supportedBy(c, record)) ?? done[0];
          if (claim) {
            cands.push({
              response: sendBack("send-back-claim", {
                claim: clip(claim.text),
                missing: missingFor(claim, record),
              }),
              drivers,
              reasonCode: "claim-unsupported",
            });
          }
        }

        // 3. dodged work
        const dodge = pick(verdicts, "dodged-work");
        if (dodge) {
          const ignorePromise = (s.scheduledJobs?.value ?? []).length > 0;
          const option = dodgeOption(dodge, asked, ignorePromise);
          if (option && PROBLEM[option]) {
            cands.push({
              response: sendBack("send-back-dodged", { problem: PROBLEM[option] }),
              drivers: ["dodged-work"],
              reasonCode: "dodged-work",
            });
          }
        }

        // 4. stale state
        if (crossesId(asked, verdicts, "stale-state-claim")) {
          const claim = stateClaims(s)[0] ?? doneClaims(s)[0];
          cands.push({
            response: sendBack("send-back-claim", {
              claim: clip(claim?.text ?? replyOf(s)),
              missing: "no check of the running state in this task",
            }),
            drivers: ["stale-state-claim"],
            reasonCode: "stale-state",
          });
        }
      }

      let best: FamilyResult | null = null;
      for (const c of cands) if (!best || severity(c.response) > severity(best.response)) best = c;
      // A claim send-back outranks the refusal here, but the refusal is still true (2026-09-30, CTO tab): say so.
      if (
        best &&
        best.response.kind !== "refusal" &&
        cands.some((c) => c.response.kind === "refusal")
      ) {
        best = { ...best, alsoRefusal: true };
      }
      return best;
    },
  };
}
