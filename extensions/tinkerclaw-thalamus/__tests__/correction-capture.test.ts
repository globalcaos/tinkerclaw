import type { JevQuestion, JevVerdict } from "openclaw/plugin-sdk/fork-jev";
import { seedCards, type EnhancementCard } from "openclaw/plugin-sdk/fork-thalamus";
import { describe, expect, it, vi } from "vitest";
import {
  correctionFromVerdict,
  createCorrectionCapture,
  readCorrection,
  type CorrectionAsk,
  type CorrectionClass,
} from "../src/correction-capture.js";
import { ThalamusStore } from "../src/store.js";

// The rules on the owner's own prompts. Every text below is one he typed in a Tinker chat between 2026-07-08 and
// 2026-10-10 (main-agent transcripts, user turns), cut to the sentence that matters where it was long. The stamp and the
// Fractal doctrine are kept on the ones whose raw prompt carried them, because the hook sees the raw prompt.

const cards: EnhancementCard[] = seedCards([
  {
    kind: "skill",
    name: "youtube-ultimate",
    description: "Download YouTube videos and transcripts.",
  },
  {
    kind: "skill",
    name: "gog",
    description: "Google Workspace CLI for Gmail, Calendar, Drive and Docs.",
  },
  { kind: "skill", name: "sharepoint-download", description: "Downloads a SharePoint file." },
  { kind: "skill", name: "linkedin-hack", description: "Searches LinkedIn for candidates." },
  {
    kind: "skill",
    name: "amazon-shopper",
    description: "Amazon shopping that ends in a decision.",
  },
  {
    kind: "skill",
    name: "amazon-product-search-api-skill",
    description: "Amazon product search API.",
  },
  { kind: "skill", name: "m365-copilot", description: "Microsoft 365 Copilot bridge." },
  { kind: "skill", name: "napkin-diagrams", description: "Conceptual diagrams from text." },
  { kind: "recipe", name: "plan-family-trip", description: "Plan a family trip." },
]);

const DOCTRINE =
  "\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** on its own line (blank line before it). " +
  "This is the doctrine that governs it:\n\n## Who Fractal is\n\nAfter the work is done, again, it asks what it meant.";

type Case = { text: string; classes: CorrectionClass[]; named?: string[]; ambiguous?: boolean };

const CASES: Case[] = [
  // use_existing (C3)
  {
    text: `[Thu 2026-09-03 09:57 GMT+2] Wait, you forgot that we have a youtube skill.${DOCTRINE}`,
    classes: ["use_existing"],
    named: ["skill:youtube-ultimate"],
  },
  {
    text: "[Sun 2026-08-30 16:16 GMT+2] No need for the browser, you have a gmail skill",
    classes: ["use_existing"],
    named: ["skill:gog"],
  },
  { text: "Remember we have a skill that handles this", classes: ["use_existing"] },
  {
    text: "Tens el skill sharepoint-download per baixar els arxius. Fes-lo servir!",
    classes: ["use_existing"],
    named: ["skill:sharepoint-download"],
  },
  {
    text: "Nice draft, but you forgot to run the spell check as our recipe says",
    classes: ["use_existing"],
  },
  {
    text: "Not quite, you are not using the right recipe. Remember the one you used for the March report",
    classes: ["use_existing"],
  },
  {
    text: "Is the build done? If so, ship it. You should have a skill to restart the server",
    classes: ["use_existing"],
  },
  {
    text: "Update the wiki page with the new dates. You already have a plugin for the wiki",
    classes: ["use_existing"],
  },
  // dont_ask (C5)
  {
    text: "I tried the export again and it still fails. Just fix it, don't ask me to run anything",
    classes: ["dont_ask"],
  },
  {
    text: "[Sat 2026-10-10 09:21 GMT+2] ok, do it yourself, you have access",
    classes: ["dont_ask"],
  },
  {
    text: "Run the install yourself, we have a recipe for it",
    classes: ["use_existing", "dont_ask"],
  },
  { text: "why would you even ask?", classes: ["dont_ask"] },
  // simpler (C6)
  { text: "Please simplify the answer a bit", classes: ["simpler"] },
  {
    text: "Sorry, I don't understand a word. Explain it like I am a grandma",
    classes: ["simpler"],
  },
  {
    text: "The summary is way too technical, say it in human terms.",
    classes: ["simpler"],
  },
  {
    text: "Expain better the second step, I don't understand it.",
    classes: ["simpler"],
  },
  // reply_language (C8)
  {
    text: "When I write in one language, please answer in the same one. Try again",
    classes: ["reply_language"],
    ambiguous: false,
  },
  {
    text: "Why did you switch language? Keep the whole report entirely in English",
    classes: ["reply_language"],
  },
  { text: "Hi again. Can we switch back to English?", classes: ["reply_language"] },
  // purple_line (C9)
  {
    text: "Is the voice working? I haven't seen the purple line today.",
    classes: ["purple_line"],
  },
  {
    text: "Put the jokes only in the purple text, please",
    classes: ["purple_line"],
  },
  // keep_going (C4)
  { text: "[Wed 2026-07-08 16:48 GMT+2] keep going", classes: ["keep_going"] },
  { text: "Are you stuck? Keep going", classes: ["keep_going"] },
  { text: "I can't see any progress, keep going", classes: ["keep_going"] },
  { text: "Good. Keep going", classes: ["keep_going"] },
  { text: "keep going with the next file", classes: ["keep_going"] },
  { text: "continue where you left off", classes: ["keep_going"] },
  { text: "something interrupted the run, keep going", classes: ["keep_going"] },
  // Not a correction: a new request with the same words in it.
  { text: "Translate the brochure into Spanish", classes: [], ambiguous: false },
  {
    text: "Ok, the token works now, you have the token saved. Test it",
    classes: [],
    ambiguous: false,
  },
  {
    // "I don't understand why" is a question, not "explain simpler". "still" is no cue for these classes: on the corpus
    // it sent 126 unrelated prompts to Jev.
    text: "I don't understand why there are still open items in the queue.",
    classes: [],
    ambiguous: false,
  },
  {
    text: "Let's create a linkedin skill, similar to the one we made for calendars",
    classes: [],
    named: [],
  },
  {
    text: "Improve the 365 copilot skill so it keeps the context",
    classes: [],
    named: [],
  },
  {
    text: "Give the skill a more plain name, like sharepoint-download.",
    classes: [],
    named: [],
  },
  {
    text: "Right, it works now, keep going through the next phase",
    classes: [],
    ambiguous: true,
  },
  // A plain instruction names a card for THIS task; it is not a correction.
  {
    text: "Cerca feines utilitzant el skill de linkedin, sense pressa.",
    classes: [],
    named: ["skill:linkedin-hack"],
  },
  // Two cards share the word: never a guess.
  {
    text: "Use your amazon skill to compare prices of hiking boots",
    classes: [],
    named: [],
  },
  // Weak cue, no class: Jev's.
  {
    text: "Keep going with the report and after the next section list the remaining tasks",
    classes: [],
    ambiguous: true,
  },
  {
    text: "How many times do I have to say it? Look at the second table",
    classes: [],
    ambiguous: true,
  },
];

const words = (raw: string) =>
  raw.replace(/^\[[^\]]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\]\s*/, "").split("\n\n---\n\n")[0];

describe("the correction rules on the owner's own prompts", () => {
  for (const c of CASES) {
    it(`${c.classes.join("+") || "no class"}: ${words(c.text).slice(0, 70)}`, () => {
      const r = readCorrection(words(c.text), cards);
      expect(r.classes).toEqual(c.classes);
      if (c.named) {
        expect(r.named.map((x) => x.id)).toEqual(c.named);
      }
      if (c.ambiguous !== undefined) {
        expect(r.ambiguous).toBe(c.ambiguous);
      }
    });
  }
});

// ─── the capture: scope, pins, rows, Jev ──────────────────────────────────────────────────────

const QUESTION: JevQuestion = {
  id: "correction-class",
  version: 1,
  type: "choice",
  criteria: { keep_going: "x", none: "y" },
  instructions: "Which?",
  fields: ["request"],
};

const verdict = (answer: string, prob: number, over: Partial<JevVerdict> = {}): JevVerdict => ({
  id: "v",
  situationId: "s",
  questionId: "correction-class",
  questionVersion: 1,
  type: "choice",
  answer,
  prob,
  confidence: prob,
  cacheHit: false,
  latencyMs: 300,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 0,
  ts: 1,
  ...over,
});

function capture(o: { ask?: CorrectionAsk; allowed?: boolean } = {}) {
  const store = new ThalamusStore(":memory:");
  const rows: Array<{ name: string; record: Record<string, unknown> }> = [];
  const cap = createCorrectionCapture({
    store: () => store,
    cards: () => cards,
    now: () => 1000,
    jev: { ask: o.ask, question: QUESTION, allowed: () => o.allowed ?? true, budgetMs: () => 500 },
    emit: (name, record = {}) =>
      void rows.push({ name, record: record as Record<string, unknown> }),
  });
  return { store, rows, cap };
}

const typed = (text: string, over: Record<string, unknown> = {}) => ({
  runId: "run-now",
  sessionKey: "agent:main:tinker:abc",
  text,
  source: "tinker",
  trigger: "user",
  ...over,
});

describe("the capture", () => {
  it("pins a plainly named card on the current task, `by: named`, with no correction row", () => {
    const t = capture();
    const out = t.cap.observe(
      typed("[Wed 2026-09-23 17:08 GMT+2] Baixa l'informe, utilitza el skill sharepoint-download"),
    );
    expect(out?.pins).toEqual([
      { taskId: "run-now", cardId: "skill:sharepoint-download", by: "named" },
    ]);
    expect(t.store.listPins()).toMatchObject([
      { id: "run-now:skill:sharepoint-download", by: "named" },
    ]);
    expect(t.rows).toEqual([]);
  });

  it("an unnamed 'you have a skill' writes the row with n1 = 0 and no pin", () => {
    const t = capture();
    t.cap.observe(typed("Remember we have a skill that handles this"));
    expect(t.store.listPins()).toEqual([]);
    expect(t.rows).toMatchObject([
      { name: "j.correction", record: { label: "use_existing", n1: 0 } },
    ]);
  });

  it("a corrective naming with no earlier task in the chat pins the current one", () => {
    const t = capture();
    t.cap.observe(typed("Wait, you forgot that we have a youtube skill."));
    expect(t.store.listPins()).toMatchObject([{ taskId: "run-now", by: "correction" }]);
  });

  it("writes one row per class, the non-pin classes with n1 NULL", () => {
    const t = capture();
    t.cap.observe(typed("Run the install yourself, we have a recipe for it"));
    expect(t.rows.map((r) => [r.record.label, r.record.n1, r.record.fields])).toEqual([
      ["use_existing", 0, { via: "rule" }],
      ["dont_ask", null, { via: "rule" }],
    ]);
  });

  it("stays out of anything but a typed home-chat turn", () => {
    const t = capture();
    expect(
      t.cap.observe(typed("keep going", { sessionKey: "agent:main:subagent:x" })),
    ).toBeUndefined();
    expect(
      t.cap.observe(typed("keep going", { sessionKey: "agent:main:whatsapp:group:1" })),
    ).toBeUndefined();
    expect(t.cap.observe(typed("keep going", { trigger: "cron" }))).toBeUndefined();
    expect(t.cap.observe(typed("⟦AGENT:🌿 Fractal · prompt 3⟧ keep going"))).toBeUndefined();
    expect(t.cap.observe(typed("[System · longjob] keep going"))).toBeUndefined();
    expect(t.rows).toEqual([]);
  });

  it("does not take the doctrine's words for his: a plain request with the doctrine behind it is no correction", () => {
    const t = capture();
    const out = t.cap.observe(
      typed(`[Fri 2026-10-02 14:36 GMT+2] Find a cozy place for the weekend${DOCTRINE}`),
    );
    expect(out?.read).toMatchObject({ classes: [], ambiguous: false });
    expect(t.rows).toEqual([]);
  });

  it("asks Jev only for an ambiguous prompt, and rows its answer `via: jev`", async () => {
    const ask = vi.fn<CorrectionAsk>(async () => [verdict("keep_going", 0.82)]);
    const t = capture({ ask });
    t.cap.observe(typed("keep going"));
    expect(ask).not.toHaveBeenCalled();

    const out = t.cap.observe(
      typed("Keep going with the report and after the next section list the remaining tasks"),
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toEqual({
      id: "correction:run-now",
      request: {
        value: "Keep going with the report and after the next section list the remaining tasks",
      },
    });
    await expect(out?.jev).resolves.toBe("keep_going");
    expect(t.rows.at(-1)).toMatchObject({
      record: { label: "keep_going", n1: null, fields: { via: "jev" } },
    });
  });

  it("never asks Jev when the privacy gate says no, and drops a weak or `none` answer", async () => {
    const ask = vi.fn<CorrectionAsk>(async () => [verdict("keep_going", 0.9)]);
    const closed = capture({ ask, allowed: false });
    expect(closed.cap.observe(typed("how many times do I have to say it?"))?.jev).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();

    expect(correctionFromVerdict(verdict("keep_going", 0.4))).toBeUndefined();
    expect(correctionFromVerdict(verdict("none", 0.95))).toBeUndefined();
    expect(
      correctionFromVerdict(verdict("keep_going", 0.9, { skipped: "timeout" })),
    ).toBeUndefined();
    expect(correctionFromVerdict(verdict("simpler", 0.7))).toBe("simpler");
  });

  it("a failing Jev call writes nothing and throws nothing", async () => {
    const t = capture({
      ask: async () => {
        throw new Error("down");
      },
    });
    const out = t.cap.observe(typed("how many times do I have to say it?"));
    await expect(out?.jev).resolves.toBeUndefined();
    expect(t.rows).toEqual([]);
  });
});
