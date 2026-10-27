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
    text: `[Thu 2026-09-03 09:57 GMT+2] Did you forget we have a youtube skill?${DOCTRINE}`,
    classes: ["use_existing"],
    named: ["skill:youtube-ultimate"],
  },
  {
    text: "[Sun 2026-08-30 16:16 GMT+2] I don't need to share any tab, you have a gmail skill",
    classes: ["use_existing"],
    named: ["skill:gog"],
  },
  { text: "Remember we have a skill that overcomes this difficulty", classes: ["use_existing"] },
  {
    text: "El skill sharepoint-download permet descarregar els arxius, collons! Fes-lo servir per descarregar-te els putus arxius!!",
    classes: ["use_existing"],
    named: ["skill:sharepoint-download"],
  },
  {
    text: "Great work on the paper, but you forgot to inject in it napkin diagrams as our recipe calls for",
    classes: ["use_existing"],
  },
  {
    text: "Nope, you are not following the right script or recipe. Remember the one you used last time, the last version with the NN focus",
    classes: ["use_existing"],
  },
  {
    text: "Is amygdala done? If so, put it into production. You should have a skill to restart the gateway and the front-end",
    classes: ["use_existing"],
  },
  {
    text: "Update the wiki entry with the new IPs. Dude, you have the login and passwords of the wiki",
    classes: ["use_existing"],
  },
  // dont_ask (C5)
  {
    text: "I just sent a test to Goku and it still does not work. Make it work, don't ask me to run commands, fix it",
    classes: ["dont_ask"],
  },
  {
    text: "[Sat 2026-10-10 09:21 GMT+2] ok, do it yourself, you have the tab",
    classes: ["dont_ask"],
  },
  {
    text: "Do the sudo thing in the pi yourself, you have the root password",
    classes: ["use_existing", "dont_ask"],
  },
  { text: "why do you even ask?", classes: ["dont_ask"] },
  // simpler (C6)
  { text: "Simplify your explanation for me, will you?", classes: ["simpler"] },
  {
    text: "No clue, I don't understand anything here. Explain it as if I was a grandma without computer knowledge",
    classes: ["simpler"],
  },
  {
    text: "The title is way too complicated, bring it down to human terms, something we can all relate to.",
    classes: ["simpler"],
  },
  {
    text: "Expain better the invariant gate question, I don't understand it. Put it in human terms, things I can relate to",
    classes: ["simpler"],
  },
  // reply_language (C8)
  {
    text: "The rule is that if I speak in one language, you respond in the same one. Try again",
    classes: ["reply_language"],
    ambiguous: false,
  },
  {
    text: "Why did you switch language to Spanish? I would like this chat and the test itself to be entirely in English",
    classes: ["reply_language"],
  },
  { text: "Hello? Anybody hoe?? And let's switch to English please", classes: ["reply_language"] },
  // purple_line (C9)
  {
    text: "So, is it working now? I haven't seen the purple text in a long while. Why is that?",
    classes: ["purple_line"],
  },
  {
    text: "Ok, what about your humor? Revise the humor paper. Your humor will only go in the purple text",
    classes: ["purple_line"],
  },
  // keep_going (C4)
  { text: "[Wed 2026-07-08 16:48 GMT+2] keep going", classes: ["keep_going"] },
  { text: "Are you stuck? Keep going", classes: ["keep_going"] },
  { text: "I cannot see an answer yet, keep going", classes: ["keep_going"] },
  { text: "Good. Keep going", classes: ["keep_going"] },
  { text: "keep going with opus", classes: ["keep_going"] },
  { text: "continue where you left off", classes: ["keep_going"] },
  { text: "keep going, something interrupted your thinking", classes: ["keep_going"] },
  // Not a correction: a new request with the same words in it.
  { text: "Translate the pamiesvitae pdf into Spanish", classes: [], ambiguous: false },
  {
    text: "Ok, the key worked through the phone, you have the key stored properly. Test it",
    classes: [],
    ambiguous: false,
  },
  {
    // "I don't understand why" is a question, not "explain simpler". "still" is no cue for these classes: on the corpus
    // it sent 126 unrelated prompts to Jev.
    text: "I don't understand why there are still improvement notes that are not empty.",
    classes: [],
    ambiguous: false,
  },
  {
    text: "Let's create a linkedin skill. I want you to do something similar to what we did with the teams hack",
    classes: [],
    named: [],
  },
  {
    text: "Improve the 365 copilot skill, we need to inject the context in every llm call",
    classes: [],
    named: [],
  },
  {
    text: "Rename the skill to something more plain, like sharepoint-download.",
    classes: [],
    named: [],
  },
  {
    text: "Ok, confirmed, it works, keep going through the next phase",
    classes: [],
    ambiguous: true,
  },
  // A plain instruction names a card for THIS task; it is not a correction.
  {
    text: "Ara fes una cerca utilitzant el skill de linkedin que hem desenvolupat sense cremar la sessió compartida.",
    classes: [],
    named: ["skill:linkedin-hack"],
  },
  // Two cards share the word: never a guess.
  {
    text: "Use your amazon skill to search for micro SD and make me an html graph of price/capacity",
    classes: [],
    named: [],
  },
  // Weak cue, no class: Jev's.
  {
    text: "Keep going with the SV2 development and after giving the next job to the worker explain me the next remaining tasks to be done",
    classes: [],
    ambiguous: true,
  },
  {
    text: "Dude, how many times do I have to tell you?? Concentrate on page 4",
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
      typed(
        "[Wed 2026-09-23 17:08 GMT+2] Importa les dades del sharepoint, utilitza el skill sharepoint-download",
      ),
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
    t.cap.observe(typed("Remember we have a skill that overcomes this difficulty"));
    expect(t.store.listPins()).toEqual([]);
    expect(t.rows).toMatchObject([
      { name: "j.correction", record: { label: "use_existing", n1: 0 } },
    ]);
  });

  it("a corrective naming with no earlier task in the chat pins the current one", () => {
    const t = capture();
    t.cap.observe(typed("Did you forget we have a youtube skill?"));
    expect(t.store.listPins()).toMatchObject([{ taskId: "run-now", by: "correction" }]);
  });

  it("writes one row per class, the non-pin classes with n1 NULL", () => {
    const t = capture();
    t.cap.observe(typed("Do the sudo thing in the pi yourself, you have the root password"));
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
      typed(
        "Keep going with the SV2 development and after giving the next job explain me the remaining tasks",
      ),
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toEqual({
      id: "correction:run-now",
      request: {
        value:
          "Keep going with the SV2 development and after giving the next job explain me the remaining tasks",
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
    expect(closed.cap.observe(typed("how many times do I have to tell you?"))?.jev).toBeUndefined();
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
    const out = t.cap.observe(typed("how many times do I have to tell you?"));
    await expect(out?.jev).resolves.toBeUndefined();
    expect(t.rows).toEqual([]);
  });
});
