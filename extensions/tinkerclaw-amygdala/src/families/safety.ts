/**
 * The safety family (design doc §5.1, paper §6.1): decides how much proof a tool call needs before it runs, from how
 * irreversible the effect is (danger 0-3) and how likely the request is misread (set by second opinion in the turn
 * state). Pre-tool only. Pure: cut-offs come from the asked questions, never from numbers written here.
 */
import { basename } from "node:path";
import type { TurnState } from "../context.js";
import { stripHeredocs } from "../effect-class.js";
import {
  chatJid,
  type ChatHistory,
  FIRST_CONTACT_DAYS,
  whatsappChatHistory,
} from "../recipients.js";
import { adjustDanger, cellToResponse, type Danger, proofCell } from "../respond.js";
import type { EvidenceKind, Response, Seam, Situation, Verdict } from "../types.js";
import {
  clip,
  crosses,
  crossesId,
  isCannotTell,
  isOwnerTurn,
  levelOf,
  optionProb,
  OWNER_RELEASE,
  ownerAllowed,
  pick,
} from "./common.js";
import type { AskedQuestions, Family, FamilyResult } from "./types.js";
import type { FamilyDeps } from "./util.js";

const REMOTE_MENTION = /\b(scp|rsync|curl|wget|upload|share|publish)\b/i;
const OWN_SYSTEM_MENTION = /gateway|systemctl|openclaw/i;
const WIDE_DESTINATIONS = ["shared", "public"] as const;

/**
 * The outlook-hack CLI has no send endpoint: these subcommands make, move or read drafts and mail, and every one of them
 * is undone in the mail client. A draft whose body links to a shop is not data leaving the machine (2026-11-10: a
 * reply-draft update was held twice as a danger-2 proof, and the owner called the check wrong).
 */
const DRAFT_ONLY_CALL = /outlook\.mjs\s+mail\s+(\S+)/g;
const DRAFT_ONLY_SUBS = new Set([
  "draft",
  "reply-draft",
  "forward-draft",
  "check-draft",
  "move",
  "flag",
  "read",
  "list",
  "search",
  "conversation",
  "attachments",
  "attachment",
]);
const DRAFT_ONLY_WRAPPER = /\b(?:replace-reply-draft\.sh|zen-card-draft\.py)\b/;
const NETWORK_TOOL =
  /\b(?:ssh|scp|rsync|curl|wget|ncat|nc|sendmail|mutt|msmtp|wacli|gh)\b|\bgit\s+push\b|\bopenclaw\s+message\b|\bgog\b/;
/**
 * The draft routine's own programs: the outlook-hack scripts above and the voice check every outgoing text goes
 * through. The target parser lists a program a step runs as a target, and running one is not writing it (2026-11-10:
 * every real draft update listed them, so the draft-only test never passed one).
 */
const DRAFT_ROUTINE_PROGRAM =
  /\/skills\/(?:outlook-hack\/scripts\/(?:outlook\.mjs|replace-reply-draft\.sh|zen-card-draft\.py)|human-voice\/scripts\/voicecheck\.py)$/;
/**
 * A write into, or a run of, a path held in a shell variable. The target parser cannot resolve it (2026-10-29: a step
 * wrote a new draft wrapper into the skills folder through `cat > $S` and ran it with `bash $S`).
 */
const VARIABLE_PATH =
  /(?:>{1,2}|\btee(?:\s+-\S+)*\s|\b(?:node|bash|sh|python3?|source)(?:\s+-\S+)*\s)\s*["']?\$(?!HOME\b|\{HOME\})/;
const RUN_PREFIX = String.raw`\b(?:node|bash|sh|python3?)\s+(?:-\S+\s+)*[^\s;&|<>()'"]*`;

/** Every mention of the program's file name in the command runs it: none is a redirect, an in-place edit or a copy. */
function onlyRun(cmd: string, path: string): boolean {
  const name = basename(path).replace(/[.]/g, "\\.");
  const mentions = cmd.match(new RegExp(name, "g"))?.length ?? 0;
  const runs = cmd.match(new RegExp(RUN_PREFIX + name, "g"))?.length ?? 0;
  return mentions > 0 && runs === mentions;
}

/**
 * A step whose only outward tool is a draft-only outlook-hack call, that sends, spends, deletes and restarts nothing,
 * runs no network tool, and writes only scratch (or files it made). It is reversible in the mail client. What it runs
 * is read outside heredoc bodies: a body is the text of a file, not a call.
 */
function draftOnlyStep(s: Situation): boolean {
  const cmd = s.command.value ?? "";
  const e = s.effectClass.value;
  if (!cmd || e === "send" || e === "spend" || e === "delete" || e === "restart-own-system")
    return false;
  if (NETWORK_TOOL.test(cmd)) return false;
  const run = stripHeredocs(cmd);
  if (VARIABLE_PATH.test(run)) return false;
  const subs = [...cmd.matchAll(DRAFT_ONLY_CALL)].map((m) => m[1]);
  if (run.search(DRAFT_ONLY_CALL) < 0 && !DRAFT_ONLY_WRAPPER.test(run)) return false;
  if (subs.some((sub) => !DRAFT_ONLY_SUBS.has(sub))) return false;
  const owned = new Set(
    (s.ownedTargets.value ?? [])
      .filter((o) => o.why === "created" || o.why === "scratch")
      .map((o) => o.path),
  );
  return (s.targets.value ?? [])
    .filter((t) => t.kind !== "url")
    .every(
      (t) =>
        t.path.startsWith("/tmp/") ||
        owned.has(t.path) ||
        (DRAFT_ROUTINE_PROGRAM.test(t.path) && onlyRun(run, t.path)),
    );
}

/**
 * The proof card's fact line when the step neither sends nor spends nor was edited lately (2026-11-10). It said "not in
 * a scratch area" every time, also next to a `/tmp/jarvis` target: 32 of the 209 proofs from the 10-28 enforce to
 * 11-10 named a `/tmp` path beside it, and the reviewer and the explainer passed it on as the cause. It now names the
 * first path outside `/tmp` that the step did not make (the file name kept, so the tail), or else the table cell.
 */
function tableFact(s: Situation, d: Danger, risk: string): string {
  const owned = new Set(
    (s.ownedTargets.value ?? [])
      .filter((o) => o.why === "created" || o.why === "scratch")
      .map((o) => o.path),
  );
  const out = (s.targets.value ?? []).find(
    (t) => t.kind !== "url" && !t.path.startsWith("/tmp/") && !owned.has(t.path),
  )?.path;
  if (!out) return `danger ${d} at ${risk} misreading risk`;
  return `${out.length > 80 ? `...${out.slice(-77)}` : out} is outside scratch`;
}

/** Every piece of text a step exposes: command, argument values and target paths. */
function stepText(s: Situation): string {
  const parts: string[] = [];
  if (s.command.value) parts.push(s.command.value);
  if (s.args.value) parts.push(JSON.stringify(s.args.value));
  for (const t of s.targets.value ?? []) parts.push(t.path);
  return parts.join(" ");
}

const DAY_MS = 86_400_000;

/**
 * The first WhatsApp recipient of a send whose chat has no message, either way, in the last 90 days, and whose number
 * the owner did not type in this request; null when there is none (FORK 2026-11-12). Asked for his sister, the agent
 * sent her packet to a contact labelled "Hermana" that it had never written to. Replayed on the sends recorded from
 * 10-02 to 11-12, this holds 7: that one, and six first messages he had ordered, five of them to a person the agent
 * found from "her", "him" or a description.
 */
export function firstContact(s: Situation, history: ChatHistory): string | null {
  if (s.effectClass.value !== "send" || !/whatsapp/i.test(stepText(s))) return null;
  const typed = (s.request.value ?? "").replace(/\D/g, "");
  for (const t of s.targets.value ?? []) {
    if (t.kind !== "address" || chatJid(t.path) === null) continue;
    const own = t.path.replace(/\D/g, "");
    if (typed.length > 0 && typed.includes(own.slice(-9))) continue;
    if (history(t.path, s.ts - FIRST_CONTACT_DAYS * DAY_MS) === 0) return t.path;
  }
  return null;
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

/**
 * Every target sits in a scratch folder and is the agent's own work (`created`, `scratch` or `fresh` in situation.ts
 * `ownedTargetsOf`). Both facts are required, so a step whose targets the guard could not place keeps the table.
 */
function ownScratchOnly(s: Situation): boolean {
  const targets = s.targets.value ?? [];
  if (targets.length === 0 || s.scratch.value !== true) return false;
  const why = new Map((s.ownedTargets?.value ?? []).map((o) => [o.path, o.why]));
  return targets.every((t) => ["created", "scratch", "fresh"].includes(why.get(t.path) ?? ""));
}

export function createSafetyFamily(deps: FamilyDeps): Family {
  const unlocked = deps.selfModification === "unlocked";
  const chatHistory = deps.chatHistory ?? whatsappChatHistory();
  /** The safety decision table itself (design 5.1); `decide` adds the reading-hold release on top. */
  const decideTable = (
    seam: Seam,
    s: Situation,
    verdicts: Verdict[],
    state: TurnState,
    asked: AskedQuestions,
  ): FamilyResult | null => {
    if (seam !== "pre-tool") return null;

    const needs = s.holdNeeds.value ?? [];
    const judged = needs.filter((n) => n !== "reading-sources");
    const readingMet = !needs.includes("reading-sources") || state.ambiguity !== "open";

    // 1. A mention is not a step. Unanswered (judge out) is treated the same: no opinion. The question is worded
    // about destructive effects, so its "does not run" answer only silences steps that neither leave the machine
    // nor move data: a copy of a CV to a shared place is not destructive, and must still reach the table.
    const runs = pick(verdicts, "runs-or-quotes");
    const runsOk = runs !== undefined && crosses(asked.get("runs-or-quotes"), runs);
    if (!isExternal(s) && !runsOk) return null;

    // 2. Evidence release: the needs of an open hold are met by evidence, never by rephrasing.
    // 2a. The owner's own release (2026-10-29): the Allow button under a held reply.
    if (needs.length > 0 && ownerAllowed(s)) return OWNER_RELEASE;
    const ev = pick(verdicts, "evidence-present");
    if (
      judged.length > 0 &&
      readingMet &&
      ev &&
      (isOwnerTurn(s) || !judged.includes("user-request")) &&
      evidenceMet(judged, ev, asked)
    ) {
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

    // 3b. A first message to a WhatsApp chat waits for the owner to confirm the person: no judge reads who a contact
    // is, and the contact's own label is what misled the agent on 2026-11-12.
    if (firstContact(s, chatHistory) !== null) {
      return {
        response: { kind: "hold", ruleOrQuestion: "first-contact", releasable: "user-only" },
        drivers: ["first-contact"],
        reasonCode: "first-contact",
      };
    }

    // A draft-only mail step is reversible in the mail client: no proof table.
    if (draftOnlyStep(s)) return null;

    // Unlocked: the agent may restart itself. A command that also sends or deletes classifies as that instead.
    if (unlocked && s.effectClass.value === "restart-own-system" && !movesData(s)) return null;

    // 4. Retry after a hold: same goal, new words. A hold that waits only for the reading is the second-opinion
    // family's: it checks the reading again on every retry, so the retry is not held for the owner here.
    const readingOnly = needs.length > 0 && judged.length === 0;
    if (!readingOnly && crossesId(asked, verdicts, "same-goal-as-held")) {
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

    // FORK 2026-11-13: own scratch work needs no reading. Removing or rewriting files the agent made in its scratch
    // folder does not depend on how the request is read, yet at a medium misreading risk the end-of-task clean-up
    // AGENTS.md asks for drew "worried deleting those temp comparison files was not clearly requested", and the
    // owner called the deletion guard wrong. From 11-01 to 11-13 the table noted 50 steps at a medium risk whose
    // targets were all the agent's own (created, scratch or fresh), 25 of them deletions at danger 1; replayed on
    // those records, this check skips 42 (all danger 1, all in scratch) and leaves every danger 2-3 row as it was.
    // Only at danger 0-1 and only on this machine: a higher danger, a send, a spend or data that moves keep the table.
    if (d <= 1 && !isExternal(s) && ownScratchOnly(s)) return null;

    const targets = s.targets.value ?? [];
    const request = s.request.value ?? "";
    const namedExact =
      targets.length > 0 && targets.every((t) => request.includes(basename(t.path)));
    const tableCell = proofCell(d, state.misreadingRisk, namedExact);
    if (tableCell.kind === "proceed") return null;

    const effect = s.effectClass.value ?? "other";
    const needList = proofNeeds(effect, { recent, repeat, stops, namedExact });
    // FORK 2026-11-12: a danger-2 proof that asks only "did the owner request this" is a note on record, not a hold.
    // Nothing the agent can show answers it: 27 of these from the 10-28 enforce to 11-12, the reviewer called none
    // useful (8 harmful, 2 noise), 18 were never released, 6 took the owner's click, 2 opened on evidence. The last
    // one held a build the owner had just ordered while `instruction-source` said "user" at 0.85. A proof that needs
    // something showable (a listing, a backup), danger 3, a high misreading risk and the hard rules are unchanged.
    const onlyOwnerWord =
      tableCell.kind === "proof" &&
      !tableCell.authorise &&
      needList.length === 1 &&
      needList[0] === "user-request";
    const cell = onlyOwnerWord
      ? ({ kind: "note", authorise: false, templateId: "relevant-fact" } as const)
      : tableCell;
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
            : tableFact(s, d, state.misreadingRisk),
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
  };

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
      if (!unlocked && (effect === "restart-own-system" || OWN_SYSTEM_MENTION.test(text))) {
        ids.push("stops-own-system");
      }
      if ((s.recentHolds.value ?? []).length > 0) ids.push("same-goal-as-held");
      // `reading-sources` is settled by the second-opinion family in code; the evidence judge reads only the others.
      if ((s.holdNeeds.value ?? []).some((n) => n !== "reading-sources"))
        ids.push("evidence-present");
      return ids;
    },

    decide(
      seam: Seam,
      s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): FamilyResult | null {
      const r = decideTable(seam, s, verdicts, state, asked);
      // 0. A hold that waits only for an unsettled reading (second-opinion, 2026-11-13) is met once this turn's reading
      // is no longer open: two sources and the judge settled it, or a later turn of the owner's carries no ambiguity.
      // Its release closes the hold only when nothing else here acts on the step: a dangerous step still meets the
      // table, a planted instruction still holds.
      const needs = s.holdNeeds.value ?? [];
      if (
        seam === "pre-tool" &&
        needs.length > 0 &&
        needs.every((n) => n === "reading-sources") &&
        state.ambiguity !== "open" &&
        (r === null || r.response.kind === "proceed")
      ) {
        return (
          r ?? {
            response: { kind: "proceed" },
            drivers: ["reading-sources"],
            reasonCode: "evidence-released",
          }
        );
      }
      return r;
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
