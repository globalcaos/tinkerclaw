import { describe, expect, it } from "vitest";
import { chatDoc, createPointerIndex, noteDoc, type PointerDoc } from "./thalamus-pointers.js";

const note = (name: string, description: string, body = ""): PointerDoc =>
  noteDoc(
    `/m/${name}.md`,
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`,
  ) as PointerDoc;

// Enough unrelated notes that a word shared by one of them is rare, as in a real bank.
const filler = Array.from({ length: 60 }, (_, i) =>
  note(`filler_${i}`, `Routine note number ${i} about meetings, mail and the weekly agenda`),
);
const bank = [
  note(
    "reference_pi_journal_user_unit",
    "On the Pi journalctl --user is empty; read crash stacks with journalctl --user-unit",
  ),
  note(
    "project_olive_oil_cooperative",
    "Olive oil cooperative signup form: the link and the break-even sheet from March",
  ),
  note("feedback_gateway_restart", "Gateway restarts go through the gateway-restart skill"),
  note(
    "feedback_restart_waits_for_quiet_house",
    "A background job never restarts the gateway while a chat moved in the last ten minutes",
  ),
  ...filler,
];

describe("memory pointers: a few notes that may hold what the prompt needs", () => {
  it("finds the note whose use key covers the prompt", () => {
    const idx = createPointerIndex(bank);
    const hits = idx.match("the pi gateway crashed again, where is the journal crash stack", {
      max: 2,
    });
    expect(hits[0]).toMatchObject({ kind: "note", id: "/m/reference_pi_journal_user_unit.md" });
    expect(hits[0].terms).toBeGreaterThanOrEqual(2);
  });

  it("gives nothing when nothing fits", () => {
    const idx = createPointerIndex(bank);
    expect(idx.match("what is the weather like in Valencia tomorrow", { max: 2 })).toEqual([]);
    expect(idx.match("hello", { max: 2 })).toEqual([]);
    expect(idx.match("", { max: 2 })).toEqual([]);
  });

  it("one shared word is a coincidence, not a match", () => {
    const idx = createPointerIndex(bank);
    expect(idx.match("cooperative", { max: 2 })).toEqual([]);
  });

  it("is not fooled by generic words when the prompt's subject is nowhere in the bank", () => {
    // "salary" and "band" are in no note; "routine weekly agenda" would match the filler on its own.
    const idx = createPointerIndex(bank);
    expect(
      idx.match("draft the routine weekly agenda reply about the salary band", { max: 2 }),
    ).toEqual([]);
  });

  it("finds the form from the post's example, the link we used last time", () => {
    const idx = createPointerIndex(bank);
    const hits = idx.match("send me the link of the olive oil cooperative form we used last time", {
      max: 1,
    });
    expect(hits.map((h) => h.id)).toEqual(["/m/project_olive_oil_cooperative.md"]);
  });

  it("keeps the cap, honours an exclusion and orders by cover", () => {
    const idx = createPointerIndex(bank);
    const text = "can you restart the gateway for me";
    const all = idx.match(text, { max: 5 });
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].cover).toBeGreaterThanOrEqual(all[i].cover);
    }
    expect(idx.match(text, { max: 1 })).toHaveLength(1);
    const rest = idx.match(text, { max: 5, exclude: (d) => d.id === all[0].id });
    expect(rest.map((h) => h.id)).not.toContain(all[0].id);
  });
});

describe("pointer docs from a note file and a catalogue row", () => {
  it("a note's use key is its frontmatter description, and its date the modified stamp", () => {
    const d = noteDoc(
      "/m/a.md",
      '---\nname: a_note\ndescription: "Use this when the phone app needs signing"\nmetadata:\n  modified: 2026-10-21T22:57:58.850Z\n---\n# Signing the app\nbody',
    );
    expect(d).toMatchObject({
      kind: "note",
      id: "/m/a.md",
      label: "Use this when the phone app needs signing",
      date: "2026-10-21",
    });
  });

  it("a note with no frontmatter is labelled by its heading, dated by its file time", () => {
    const d = noteDoc(
      "/k/jev-health.md",
      "# Jev health\n\nOne call tells why Jev did not fire.",
      Date.UTC(2026, 9, 13),
    );
    expect(d).toMatchObject({ label: "Jev health", date: "2026-10-13" });
  });

  it("an empty file gives no doc", () => {
    expect(noteDoc("/k/empty.md", "")).toBeUndefined();
  });

  it("a chat an agent started is never a past-chat pointer", () => {
    for (const title of [
      "# FRACTAL TRIAGE — read-only judge",
      "⟦AGENT:🌿 Fractal⟧ reflect",
      "🤖 The diagnosis report is at /tmp/x.md",
      "[System] resume",
    ]) {
      expect(chatDoc({ id: "s1", title }), title).toBeUndefined();
    }
    expect(
      chatDoc({ id: "s2", title: "Find jobs for Robin", lastWorkTs: "2026-10-24T00:18:11Z" }),
    ).toMatchObject({ kind: "chat", id: "s2", label: "Find jobs for Robin", date: "2026-10-24" });
  });
});
