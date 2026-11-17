import { provenByOutput, reportedDefects, splitClaims, uncheckedAdmissions } from "../claims.js";
/**
 * Double-check family (design doc §5.2, paper §6.3): the reply says something was done and the tool record does not
 * show it, the work was dodged, a live system is claimed fixed without a check, the reply refuses an allowed task,
 * or a step weakens the check that grades the agent's own work. Claims and the tool record come from code
 * (claims.ts, transcript.ts); the judge only says whether the record supports them.
 */
import type { TurnState } from "../context.js";
import { allInRepos, inCheckout, ownRepoRoots } from "../own-repo.js";
import { severity } from "../respond.js";
import { readTranscriptTail } from "../transcript.js";
import type { Seam, Situation, Verdict } from "../types.js";
import { clip, crossesId, OWNER_RELEASE, ownerAllowed } from "./common.js";
import type { AskedQuestions, Family, FamilyResult } from "./types.js";
import type { FamilyDeps } from "./util.js";

const CHECK_RE =
  /test|spec|__tests__|e2e|vitest|jest|pytest|\.github\/workflows|lint|threshold|coverage/i;
/** A shell step with no resolved target can only change a check if the command itself writes. */
const COMMAND_WRITES =
  /\bsed\s+-\S*i|\bperl\s+-\S*i|\btee\b|\b(?:cp|mv|rm|truncate)\s|>>?\s*[^\s&]|\bopen\(|writeFile|\.write(?:_text|_bytes)?\(/;
/** A word that reads as a path, in any spelling: relative, `~/`, `$W/`, absolute or a glob. */
const PATH_WORD = /[~$\w.*@{}-]*\/[\w.*@{}/-]+|[\w.*-]+\.\w+/g;
const WEAKENING_EFFECTS = new Set(["local-write", "other", "delete"]);

const replyOf = (s: Situation): string => (typeof s.reply?.value === "string" ? s.reply.value : "");
/** A provider failure in the reply slot (Claude Code's "API Error: …" or the gateway envelope), not agent prose.
 *  2026-10-16: two safeguard refusals were judged as dodged work; there was no work to dodge. */
const PROVIDER_ERROR_RE = /^\s*(?:__ERR_ENV__:|API Error:)/;
/** The provider's own safety classifier refused the turn ("Opus 5.5's safeguards flagged this message").
 *  2026-10-18, the owner: this IS a refusal for the strip. Rewind and Rewind-and-retry stay buttons he presses. */
const PROVIDER_SAFEGUARD_RE = /safeguards flagged|anthropic\.com\/legal\/aup/i;

/** /tmp is scratch, except a checkout there: a worktree in /tmp is the real project, and its tests grade real work. */
const isScratch = (p: string): boolean => p.startsWith("/tmp/") && !inCheckout(p);

/**
 * Does the command's text name a check outside scratch? The target parser does not read a heredoc and cannot follow `$W/`,
 * so `targets` alone can look like scratch while the step edits a live test (2026-11-01: over the stored steps the judge
 * crossed, trusting `targets` stopped asking on 92 of 558, most of them real test edits). A relative word is scratch only
 * when the command starts in scratch.
 */
function namesLiveCheck(command: string): boolean {
  const cwd = /^\s*cd\s+([^\s;&|]+)/.exec(command)?.[1];
  const startsInScratch = cwd !== undefined && isScratch(cwd);
  return (command.match(PATH_WORD) ?? []).some((w) => {
    if (!CHECK_RE.test(w)) return false;
    if (w.startsWith("/")) return !isScratch(w);
    return /^[~$]/.test(w) || !startsInScratch;
  });
}

function weakensCheckRelevant(s: Situation): boolean {
  const eff = s.effectClass?.value;
  if (!eff || !WEAKENING_EFFECTS.has(eff)) return false;
  const targets = s.targets?.value ?? [];
  const command = s.command?.value ?? "";
  // Only a step that can change a live check counts: running a test, or a copy in /tmp, changes nothing that grades work.
  // A plain `cp` changes only its destination, so the test it copies from is merely read.
  const changed = /^\s*cp\s/.test(command) && !/[;&|]/.test(command) ? targets.slice(-1) : targets;
  const live = changed.filter((t) => !isScratch(t.path));
  if (changed.length > 0 && live.length === 0 && !namesLiveCheck(command)) return false;
  if (live.some((t) => CHECK_RE.test(t.path))) return true;
  if (/^\s*cp\s/.test(command)) return false;
  return CHECK_RE.test(command) && (eff === "delete" || COMMAND_WRITES.test(command));
}

export function createDoubleCheckFamily(deps: FamilyDeps): Family {
  const ownCodeFree = (s: Situation): boolean =>
    deps.selfModification === "unlocked" &&
    allInRepos(s.targets?.value ?? [], (deps.ownRepoRoots ?? ownRepoRoots)());
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
        state.outputEvidence = tail.evidence;
        const record = s.toolRecord?.value ?? [];
        for (const c of s.claims.value ?? []) {
          if (c.support !== null || !provenByOutput(c, tail.evidence, record)) continue;
          c.support = true;
          c.source = "observed";
        }
      }
    },

    questionsFor(seam: Seam, s: Situation): string[] {
      if (seam === "pre-tool")
        return weakensCheckRelevant(s) && !ownCodeFree(s) ? ["weakens-own-check"] : [];
      if (seam !== "stop" || !replyOf(s)) return [];
      if (PROVIDER_ERROR_RE.test(replyOf(s)) || reportedDefects(replyOf(s)).length > 0) return [];
      // FORK 2026-11-08: only the refusal question is asked here; the claim, dodged-work and stale-state questions fed
      // send-backs that are gone.
      return ["refusal"];
    },

    decide(
      seam: Seam,
      s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): FamilyResult | null {
      if (seam === "pre-tool") {
        if (!crossesId(asked, verdicts, "weakens-own-check")) return null;
        // A hold whose wait ran out keeps its Allow under the reply (2026-10-31): the click is the release it waited for.
        if (ownerAllowed(s)) return OWNER_RELEASE;
        return {
          response: {
            kind: "hold",
            ruleOrQuestion: "weakens-own-check",
            releasable: "user-only",
          },
          drivers: ["weakens-own-check"],
          reasonCode: "weakens-own-check",
        };
      }
      if (seam !== "stop") return null;

      // Deterministic, no Jev call: the reply slot holds the provider's refusal, not agent prose.
      const reply = replyOf(s);
      if (PROVIDER_ERROR_RE.test(reply)) {
        return PROVIDER_SAFEGUARD_RE.test(reply)
          ? { response: { kind: "refusal" }, drivers: [], reasonCode: "provider-safeguard" }
          : null;
      }

      // The agent said a check is wrong instead of editing it: the owner hears it, and the reply is not sent back.
      const defect = reportedDefects(reply)[0];
      if (defect) {
        return {
          response: {
            kind: "note",
            templateId: "defect-reported",
            slots: { what: clip(defect, 160) },
            channel: "additionalContext",
          },
          drivers: [],
          reasonCode: "report-defect",
        };
      }

      const cands: FamilyResult[] = [];
      if (crossesId(asked, verdicts, "refusal"))
        cands.push({ response: { kind: "refusal" }, drivers: ["refusal"], reasonCode: "refusal" });

      // FORK 2026-11-08: the stop seam no longer sends a reply back (unsupported claim, dodged work, stale state). The
      // owner reads the reply and the effect card (effects.ts); a send-back only made the agent re-justify itself.

      // FORK 2026-11-10: the one send-back that stays is for what the reply itself admits it did not check. No judge:
      // the agent's own words are the evidence. Once per reply (decide.ts caps it). A reflection turn's open questions
      // are the point of its note, so it is left alone.
      const unchecked =
        s.turnKind?.value === "reflection" || state.sendBackAttempts >= 1
          ? []
          : uncheckedAdmissions(reply);
      if (unchecked.length > 0) {
        cands.push({
          response: {
            kind: "send-back",
            templateId: "send-back-unchecked",
            slots: {
              what:
                `"${clip(unchecked[0] as string, 200)}"` +
                (unchecked.length > 1 ? `, and ${unchecked.length - 1} more like it` : ""),
            },
            attempt: 1,
          },
          drivers: [],
          reasonCode: "unchecked-admission",
        });
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
