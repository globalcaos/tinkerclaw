/**
 * Second-opinion family (design §5.3, paper §6.2): does the plan rest on the right reading of the request? At pre-tool
 * it also checks that a draft binds the user no harder than asked, that a step stays inside the request, and that no
 * standing fact is broken. It runs before safety, so the risk `observe` writes to the turn state is what safety reads.
 *
 * Ambiguity, three stages (redesign 2026-11-13; the first version judged the request alone and its evidence half never
 * ran, so 56 of 61 reviewed flags were noise and a flag could not be cleared within its turn):
 *   1. Screen with the full context: the owner's request next to the conversation before it and the standing facts.
 *   2. A flagged request needs redundant evidence: the agent lists the readings, names its pick and cites two
 *      independent sources. Code checks each source (a file it opened in this turn, or a quote found in the
 *      conversation; at least one must be a file), and only then the judge says whether they point to the pick.
 *   3. Not settled yet: a step that changes something is held with one way out each: one more source, or stop and
 *      ask the owner. The hold's need (`reading-sources`) is released by safety as soon as the reading settles.
 */
import { homedir } from "node:os";
import type { TurnState } from "../context.js";
import { severity } from "../respond.js";
import type { Seam, Situation, Verdict } from "../types.js";
import { clip, crossesId, OWNER_RELEASE, ownerAllowed, ownerAllowTurn, pick } from "./common.js";
import type { AskedQuestions, Family, FamilyResult } from "./types.js";
import type { FamilyDeps } from "./util.js";

const READING_LINE = /^\s*(?:[-*•]\s*)?reading\s*:\s*(.+?)\s*$/i;
const PICK_LINE = /^\s*(?:[-*•]\s*)?pick\s*:\s*(.+?)\s*$/i;
const SOURCE_LINE = /^\s*(?:[-*•]\s*)?source\s*:\s*(.+?)\s*$/i;
/** A path (`/…`, `~/…`) or a file name with a known extension. */
const PATH_IN =
  /(?:~|\/)[\w.@+-]*(?:\/[\w.@+-]+)+|\b[\w.-]+\.(?:md|json|jsonl|txt|ts|mjs|py|pdf|ya?ml|eml|csv)\b/g;
const QUOTE_IN = /"([^"\n]{12,300})"|“([^”\n]{12,300})”/g;
/** Steps that change something somebody may care about. Reads and searches gather the evidence, so they never wait. */
const CHANGES = new Set(["send", "spend", "delete", "local-write", "restart-own-system"]);

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();

/** The agent's `- reading:` / `- pick:` / `- source:` lines; the last pick wins. */
export function parseReadingNotes(text: string): {
  readings: string[];
  pick?: string;
  sources: string[];
} {
  const readings: string[] = [];
  const sources: string[] = [];
  let pick: string | undefined;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const r = READING_LINE.exec(line);
    if (r?.[1]) readings.push(clip(r[1], 120));
    const p = PICK_LINE.exec(line);
    if (p?.[1]) pick = clip(p[1], 120);
    const so = SOURCE_LINE.exec(line);
    if (so?.[1]) sources.push(so[1]);
  }
  return { readings, ...(pick ? { pick } : {}), sources };
}

/**
 * The sources that check out, as keys (`file:<name>` / `quote:<words>`), one per independent source: a file counts when
 * a call in this turn names it (opened, read, searched), a quote when its words are in the request, the conversation or
 * the standing facts. Two sources from the same file are one.
 */
export function verifiedSources(
  sources: readonly string[],
  ran: readonly string[],
  heard: string,
  home: string,
): string[] {
  const steps = norm(ran.join("\n"));
  const said = norm(heard);
  const keys: string[] = [];
  for (const src of sources) {
    let key: string | undefined;
    for (const m of src.matchAll(PATH_IN)) {
      const raw = m[0];
      const abs = raw.startsWith("~/") ? `${home}${raw.slice(1)}` : raw;
      const base = raw.split("/").pop() ?? raw;
      const opened =
        steps.includes(norm(raw)) ||
        steps.includes(norm(abs)) ||
        (base.length >= 6 && steps.includes(norm(base)));
      if (opened) {
        key = `file:${norm(base)}`;
        break;
      }
    }
    if (!key) {
      for (const m of src.matchAll(QUOTE_IN)) {
        const q = norm(m[1] ?? m[2] ?? "");
        if (q.split(" ").length >= 3 && said.includes(q)) {
          key = `quote:${q}`;
          break;
        }
      }
    }
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Two independent sources, at least one of them a file: the redundancy the judge needs before it may settle. */
export function redundant(keys: readonly string[]): boolean {
  return keys.length >= 2 && keys.some((k) => k.startsWith("file:"));
}

function heardOf(s: Situation): string {
  return [s.request.value ?? "", s.exchange?.value ?? "", ...(s.standingFacts.value ?? [])].join(
    "\n",
  );
}

function hasText(f: { value: string | null }): boolean {
  return typeof f.value === "string" && f.value.trim().length > 0;
}

/**
 * Every target of the step is one the agent created, keeps in scratch, or the owner named (situation.ts
 * `ownedTargetsOf`). A file it only edited before is still the owner's, so it does not count here.
 * A deletion does not reach a path its command only lists or reads (2026-11-13: a clean-up that ended on `ls` of the
 * repository folder was asked about, although everything it removed was the agent's own). A send does: what it reads
 * may be what leaves.
 */
function allOwned(s: Situation): boolean {
  const n = s.targets.value?.length ?? 0;
  const owned = (s.ownedTargets?.value ?? []).filter((o) => o.why !== "edited");
  if (n > 0 && owned.length >= n) return true;
  const read = new Set(s.readOnlyTargets?.value ?? []);
  if (s.effectClass.value !== "delete" || read.size === 0) return false;
  const own = new Set(owned.map((o) => o.path));
  const reached = (s.targets.value ?? []).filter((t) => !read.has(t.path));
  return reached.length > 0 && reached.every((t) => own.has(t.path));
}

export function createSecondOpinionFamily(_deps: FamilyDeps): Family {
  return {
    id: "second-opinion",

    enrich(seam: Seam, s: Situation, state: TurnState): void {
      if (state.ambiguity !== "open" || (seam !== "pre-tool" && seam !== "post-tool")) return;
      const text = s.restatement.value;
      if (typeof text !== "string") return;
      const notes = parseReadingNotes(text);
      for (const label of notes.readings) {
        if (!state.readings.some((r) => norm(r.label) === norm(label))) {
          state.readings.push({ id: `r${state.readings.length + 1}`, label, status: "open" });
        }
      }
      // A pick the record already ruled out is no pick: the agent has to choose again.
      const ruled = notes.pick
        ? state.readings.some(
            (r) => r.status === "ruled-out" && norm(r.label) === norm(notes.pick as string),
          )
        : false;
      state.readingPick = notes.pick && !ruled ? notes.pick : undefined;
      state.sourcesVerified = state.readingPick
        ? verifiedSources(notes.sources, s.turnSteps?.value ?? [], heardOf(s), homedir())
        : [];
    },

    questionsFor(seam: Seam, s: Situation, state: TurnState): string[] {
      const ids: string[] = [];
      if (seam === "prompt") {
        // Only the owner's own words can be misread: a job's wake-up or a reflection carries no new request.
        const kind = s.turnKind?.value;
        if (hasText(s.request) && kind !== "agent" && kind !== "reflection")
          ids.push("misreading-screen");
        return ids;
      }
      if (seam === "pre-tool") {
        if ((s.draftCommitments.value ?? []).length > 0) ids.push("commitment-changed");
        const effect = s.effectClass.value;
        // A step whose every target the agent made or the owner named cannot reach beyond what he named
        // (2026-10-25: excess-scope 81 % noise in the reviews, mostly deletes of the agent's own files).
        if (
          (effect === "send" || effect === "spend" || effect === "delete") &&
          (hasText(s.request) || hasText(s.restatement)) &&
          !allOwned(s)
        ) {
          ids.push("excess-scope");
        }
        if ((s.standingFacts.value ?? []).length > 0) ids.push("standing-fact-clash");
      }
      // Only once the agent has picked a reading: is it ruled out, and (with two sources that check out) confirmed?
      if (
        (seam === "pre-tool" || seam === "post-tool") &&
        state.ambiguity === "open" &&
        state.readingPick
      ) {
        ids.push("reading-ruled-out");
        if (redundant(state.sourcesVerified)) ids.push("reading-confirmed");
      }
      return ids;
    },

    observe(
      seam: Seam,
      _s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): void {
      if (seam === "prompt") {
        if (!pick(verdicts, "misreading-screen")) return;
        const flagged = crossesId(asked, verdicts, "misreading-screen");
        state.ambiguity = flagged ? "open" : "none";
        state.misreadingRisk = flagged ? "medium" : "low";
        return;
      }
      if (seam !== "pre-tool" && seam !== "post-tool") return;
      if (state.ambiguity !== "open" || !state.readingPick) return;
      const chosen = norm(state.readingPick);
      let lead = state.readings.find((r) => norm(r.label) === chosen);
      if (!lead) {
        lead = { id: `r${state.readings.length + 1}`, label: state.readingPick, status: "open" };
        state.readings.push(lead);
      }
      if (crossesId(asked, verdicts, "reading-ruled-out")) {
        lead.status = "ruled-out";
        state.readingPick = undefined;
        state.sourcesVerified = [];
        return;
      }
      if (redundant(state.sourcesVerified) && crossesId(asked, verdicts, "reading-confirmed")) {
        lead.status = "confirmed";
        state.ambiguity = "settled";
        state.misreadingRisk = "low";
      }
    },

    decide(
      seam: Seam,
      s: Situation,
      verdicts: Verdict[],
      state: TurnState,
      asked: AskedQuestions,
    ): FamilyResult | null {
      if (seam === "prompt") {
        if (!crossesId(asked, verdicts, "misreading-screen")) return null;
        return {
          response: {
            kind: "note",
            templateId: "reading-evidence",
            slots: {},
            channel: "additionalContext",
          },
          drivers: ["misreading-screen"],
          reasonCode: "screen-flagged",
        };
      }
      if (seam !== "pre-tool") return null;

      const cands: FamilyResult[] = [];
      // Stage 3: the reading is still open and this step changes something outside what the agent owns.
      if (
        state.ambiguity === "open" &&
        CHANGES.has(s.effectClass.value ?? "") &&
        s.scratch.value !== true &&
        !allOwned(s)
      ) {
        if (ownerAllowed(s) || ownerAllowTurn(s)) {
          cands.push(OWNER_RELEASE);
        } else {
          cands.push({
            response: {
              kind: "proof",
              templateId: "reading-proof",
              slots: {
                pick: state.readingPick ? `"${clip(state.readingPick, 100)}"` : "none named yet",
                sources: String(state.sourcesVerified.length),
              },
              needs: ["reading-sources"],
            },
            drivers: ["misreading-screen"],
            reasonCode: "reading-unsettled",
          });
        }
      }
      if (crossesId(asked, verdicts, "commitment-changed")) {
        cands.push({
          response: {
            kind: "ask",
            askId: `commitment-${s.id}`,
            options: [
              { id: "as-drafted", label: "Send it as drafted" },
              { id: "restore", label: "Restore what you asked for" },
              { id: "other", label: "Something else…" },
            ],
            preselect: "restore",
          },
          drivers: ["commitment-changed"],
          reasonCode: "commitment-changed",
        });
      }
      if (crossesId(asked, verdicts, "excess-scope") && !allOwned(s)) {
        cands.push({
          response: {
            kind: "ask",
            askId: `scope-${s.id}`,
            options: [
              { id: "only-asked", label: "Do only what you asked" },
              { id: "go-beyond", label: "Go ahead beyond it" },
              { id: "other", label: "Something else…" },
            ],
            preselect: "only-asked",
          },
          drivers: ["excess-scope"],
          reasonCode: "excess-scope",
        });
      }
      if (crossesId(asked, verdicts, "standing-fact-clash")) {
        const fact = clashedFact(
          pick(verdicts, "standing-fact-clash"),
          s.standingFacts.value ?? [],
        );
        if (fact !== undefined) {
          cands.push({
            response: {
              kind: "note",
              templateId: "relevant-fact",
              slots: { fact: `the plan contradicts a standing fact: ${clip(fact)}` },
              channel: "additionalContext",
            },
            drivers: ["standing-fact-clash"],
            reasonCode: "standing-fact-clash",
          });
        }
      }
      // An ask whose wait ran out keeps its Allow under the reply (2026-10-31): the click answers it.
      const allowed =
        cands.some((c) => c.response.kind === "ask") && (ownerAllowed(s) || ownerAllowTurn(s));
      // Most severe wins; the first in table order wins a tie.
      let best: FamilyResult | null = allowed ? OWNER_RELEASE : null;
      for (const c of cands) {
        if (allowed && c.response.kind === "ask") continue;
        if (!best || severity(c.response) > severity(best.response)) best = c;
      }
      return best;
    },
  };
}

/** `fact-N` names the Nth standing fact; an index outside the list means nothing to say. */
function clashedFact(v: Verdict | undefined, facts: readonly string[]): string | undefined {
  if (!v) return undefined;
  let key = v.answer;
  if (typeof key !== "string" || !/^fact-\d+$/.test(key)) {
    // The top pick was "none" but enough mass sits on a fact to cross: name the likeliest one.
    const probs = Object.entries(v.probs ?? {}).filter(([o]) => /^fact-\d+$/.test(o));
    probs.sort((a, b) => b[1] - a[1]);
    key = probs[0]?.[0] ?? "";
  }
  const m = /^fact-(\d+)$/.exec(String(key));
  if (!m) return undefined;
  return facts[Number(m[1]) - 1];
}
