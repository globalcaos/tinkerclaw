import { describe, expect, it } from "vitest";
import {
  createRecall,
  docFromCard,
  docsFromCards,
  NAMED_SURFACES,
  stems,
  toHistoryItem,
  type RecallDoc,
} from "./enhancement-recall.js";

function doc(over: Partial<RecallDoc> & { id: string }): RecallDoc {
  const kind = over.id.split(":")[0] as RecallDoc["kind"];
  return {
    kind,
    slug: over.id.split(":")[1],
    title: over.id.split(":")[1],
    summary: "",
    tags: [],
    sections: [],
    composes: [],
    ...over,
  };
}

const CATALOG: RecallDoc[] = [
  doc({
    id: "recipe:Debug the crash",
    slug: "debug",
    title: "Debug: reproduce, prove the root cause, fix once",
    summary: "Find why something fails and fix it once.",
    tags: ["debug", "bug", "crash", "failing test"],
    sections: ["Reproduce the failure", "Prove the root cause"],
  }),
  doc({
    id: "recipe:Product comparison chart",
    slug: "product-comparison",
    title: "Product Comparison Chart: rank by what matters",
    summary: "Compare several products and rank them.",
    tags: ["compare", "ranking"],
    sections: [
      "Gather specs",
      "Render the comparison as an HTML table card",
      "Rank by price per unit",
    ],
  }),
  doc({
    id: "recipe:Plan a family trip",
    slug: "plan-family-trip",
    title: "Plan a family trip: flights, stays, budget",
    summary: "Holiday planning for the family.",
    tags: ["trip", "holiday"],
    composes: ["flight-search"],
  }),
  doc({
    id: "recipe:Flight search",
    slug: "flight-search",
    title: "Search flights",
    summary: "Find flight options.",
    tags: ["flights"],
  }),
  doc({
    id: "skill:youtube-ultimate",
    title: "youtube-ultimate",
    summary: "Work with videos on the video site.",
  }),
  doc({ id: "skill:outlook-hack", title: "outlook-hack", summary: "Read and draft work mail." }),
  doc({
    id: "skill:human-voice",
    title: "human-voice",
    summary: "Write like a person. Debug crash reports kindly.",
  }),
  doc({ id: "skill:gog", title: "gog", summary: "Google Workspace CLI." }),
];

const recall = createRecall(CATALOG);
const ids = (r: ReturnType<typeof recall.recall>) => r.map((c) => c.cardId);

describe("stems", () => {
  it("lower-cases, drops stop words and short words, and reduces inflections to one stem", () => {
    expect(stems("The Debugging of crashes, please")).toEqual(["debugg", "crash"]);
    expect(stems("tests testing tested")).toEqual(["test", "test", "test"]);
  });

  it("keeps accented words", () => {
    expect(stems("actualitza la resposta")).toContain("resposta");
  });
});

describe("text source", () => {
  it("finds a card through an inflection", () => {
    const r = recall.recall({
      text: "the app keeps crashing, can you debug it",
      sources: ["text"],
    });
    expect(ids(r)[0]).toBe("recipe:Debug the crash");
  });

  it("finds a card through a one-letter typo, ranked below the exact word", () => {
    const typo = recall.recall({ text: "rank these prodcts", sources: ["text"] });
    expect(ids(typo)).toContain("recipe:Product comparison chart");
  });

  it("finds a card from a trigger phrase that is outside its subject line", () => {
    const r = recall.recall({ text: "this failing test is driving me mad", sources: ["text"] });
    expect(ids(r)).toContain("recipe:Debug the crash");
  });

  it("finds a card through one section and names it, for inspiration", () => {
    const r = recall.recall({
      text: "show the results as a table card in html",
      sources: ["text"],
    });
    const hit = r.find((c) => c.cardId === "recipe:Product comparison chart");
    expect(hit).toBeDefined();
    expect(hit?.section).toBe("Render the comparison as an HTML table card");
  });

  it("does not name a section when the match is on the title", () => {
    const r = recall.recall({ text: "plan a family trip", sources: ["text"] });
    expect(r[0].cardId).toBe("recipe:Plan a family trip");
    expect(r[0].section).toBeUndefined();
  });

  it("returns nothing for a request with no usable word", () => {
    expect(recall.recall({ text: "ok", sources: ["text"] })).toEqual([]);
  });
});

describe("history source", () => {
  const history = [
    toHistoryItem("update on the mayor reply from the town council", ["skill:outlook-hack"]),
    toHistoryItem("a totally different request about colours", ["skill:gog"]),
  ];

  it("returns the card used on a similar earlier request even when no card text shares a word", () => {
    const r = recall.recall({
      text: "any news on the mayor reply from the council",
      history,
      sources: ["history"],
    });
    expect(ids(r)).toEqual(["skill:outlook-hack"]);
    expect(r[0].via).toEqual(["history"]);
  });

  it("uses only the history it is given (nothing leaks in)", () => {
    const r = recall.recall({
      text: "any news on the mayor reply from the council",
      history: [],
      sources: ["history"],
    });
    expect(r).toEqual([]);
  });

  it("ignores a card that is not in the catalogue", () => {
    const h = [
      toHistoryItem("update on the mayor reply from the council", ["skill:retired-thing"]),
    ];
    expect(
      recall.recall({ text: "update on the mayor reply from the council", history: h }),
    ).toEqual([]);
  });
});

describe("session source", () => {
  it("returns the running recipe, the recipes it composes, and the cards the chat used lately", () => {
    const r = recall.recall({
      text: "continue",
      active: ["recipe:Plan a family trip"],
      recent: ["skill:outlook-hack"],
      sources: ["session"],
    });
    expect(ids(r)).toEqual([
      "recipe:Plan a family trip",
      "recipe:Flight search",
      "skill:outlook-hack",
    ]);
  });

  it("also returns the parent of a running child recipe", () => {
    const r = recall.recall({
      text: "continue",
      active: ["recipe:Flight search"],
      sources: ["session"],
    });
    expect(ids(r)).toContain("recipe:Plan a family trip");
  });
});

describe("surface source", () => {
  it("maps a named product to its skill, first", () => {
    const r = recall.recall({ text: "upload this to YouTube tonight", sources: ["surface"] });
    expect(ids(r)).toEqual(["skill:youtube-ultimate"]);
  });

  it("takes the surface map from the caller when one is given", () => {
    const custom = createRecall(CATALOG, {
      surfaces: [{ id: "mail", re: /\bpost office\b/i, cards: ["skill:outlook-hack"] }],
    });
    expect(ids(custom.recall({ text: "go to the post office", sources: ["surface"] }))).toEqual([
      "skill:outlook-hack",
    ]);
    expect(custom.recall({ text: "upload this to youtube", sources: ["surface"] })).toEqual([]);
  });

  it("drops a mapped card the catalogue does not hold", () => {
    expect(ids(recall.recall({ text: "look in sharepoint", sources: ["surface"] }))).toEqual([]);
  });

  it("every entry names a skill: or recipe: slug and has a pattern", () => {
    for (const s of NAMED_SURFACES) {
      expect(s.re).toBeInstanceOf(RegExp);
      for (const c of s.cards) expect(c).toMatch(/^(skill|recipe):[a-z0-9-]+$/);
    }
  });
});

describe("the merge", () => {
  it("puts a card found by several sources above one found by one", () => {
    const r = recall.recall({
      text: "upload this to youtube",
      recent: ["skill:youtube-ultimate", "skill:gog"],
    });
    expect(ids(r)[0]).toBe("skill:youtube-ultimate");
    expect(r[0].via).toEqual(expect.arrayContaining(["surface", "session"]));
  });

  it("never returns a house rule, even when its text matches", () => {
    const r = recall.recall({ text: "debug this crash report", recent: ["skill:human-voice"] });
    expect(ids(r)).not.toContain("skill:human-voice");
  });

  it("gives a runtime notice nothing", () => {
    const text = "[Thu [number]:56 GMT+2] [System] The gateway restarted: debug the crash";
    expect(recall.recall({ text, recent: ["skill:gog"] })).toEqual([]);
    expect(recall.recall({ text: "⟦AGENT:Thalamus⟧ Turn 01: debug the crash" })).toEqual([]);
  });

  it("reads the request, not the harness envelope around it", () => {
    const raw =
      'Sender (untrusted metadata):\n```json\n{"label":"x"}\n```\n\n[Tue [number]:05 GMT+2] upload to youtube\n\n---\n\n**After your reply, append a 🌿 FRACTAL reflection section** debug debug debug crash';
    expect(ids(recall.recall({ text: raw }))).toEqual(["skill:youtube-ultimate"]);
  });

  it("caps the list at max and is deterministic", () => {
    const big = createRecall(
      Array.from({ length: 60 }, (_, i) =>
        doc({ id: `skill:report-tool-${i}`, summary: "report builder tool" }),
      ),
    );
    const a = big.recall({ text: "build a report with a tool" });
    const b = big.recall({ text: "build a report with a tool" });
    expect(a).toHaveLength(15);
    expect(a).toEqual(b);
    expect(big.recall({ text: "build a report with a tool", max: 4 })).toHaveLength(4);
  });

  it("runs only the sources it is asked to", () => {
    const only = recall.recall({
      text: "upload this to youtube",
      recent: ["skill:gog"],
      sources: ["session"],
    });
    expect(ids(only)).toEqual(["skill:gog"]);
  });

  it("stays fast on a catalogue the size of the real one", () => {
    const words = [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
      "juliet",
    ];
    const catalog = Array.from({ length: 320 }, (_, i) =>
      doc({
        id: `skill:card-${i}`,
        summary: `${words[i % 10]} ${words[(i * 3) % 10]} handler number ${i}`,
        tags: [words[(i * 7) % 10]],
        sections: [`${words[(i * 2) % 10]} step ${i}`],
      }),
    );
    const r = createRecall(catalog);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++)
      r.recall({ text: "please run the alpha golf handler and then the india step" });
    expect((performance.now() - t0) / 20).toBeLessThan(50);
  });
});

describe("docFromCard", () => {
  const md = [
    "---",
    "title: Master-worker coding",
    "summary: Two chained tabs.",
    "tags: [coding, build]",
    "triggers:",
    "  - long build",
    "composes: [verification]",
    "---",
    "## Steps",
    "### 1. Write the charter",
    "### 2. Dispatch one turn",
    "## Safety Notes",
    "## Failures Overcome",
    "## Delivery format",
  ].join("\n");

  it("reads tags, triggers and composes, and keeps step titles and headings but not boilerplate", () => {
    const d = docFromCard(
      {
        id: "recipe:Master-worker",
        kind: "recipe",
        name: "Master-worker",
        purpose: "Seed purpose.",
        path: "/r/master-worker-coding/recipe.md",
      },
      md,
    );
    expect(d.slug).toBe("master-worker-coding");
    expect(d.title).toBe("Master-worker coding");
    expect(d.tags).toEqual(["coding", "build", "long build"]);
    expect(d.composes).toEqual(["verification"]);
    expect(d.sections).toEqual(["Write the charter", "Dispatch one turn", "Delivery format"]);
    expect(d.summary).toContain("Seed purpose.");
  });

  it("takes the slug from the folder for a skill and from the stem for a flat recipe file", () => {
    expect(
      docFromCard({
        id: "skill:x",
        kind: "skill",
        name: "x",
        purpose: "",
        path: "/s/outlook-hack/SKILL.md",
      }).slug,
    ).toBe("outlook-hack");
    expect(
      docFromCard({
        id: "recipe:y",
        kind: "recipe",
        name: "y",
        purpose: "",
        path: "/r/coding/feature.recipe.md",
      }).slug,
    ).toBe("feature");
  });

  it("falls back to the card when the file is missing or its frontmatter is broken", () => {
    const none = docFromCard({ id: "skill:z", kind: "skill", name: "z", purpose: "Does z." });
    expect(none).toMatchObject({ title: "z", summary: "Does z.", tags: [], sections: [] });
    const broken = docFromCard(
      { id: "skill:w", kind: "skill", name: "w", purpose: "W." },
      "---\n: : bad: [\n---\n## Real heading",
    );
    expect(broken.sections).toEqual(["Real heading"]);
  });
});

// Broca retrieval v2, phase F: what the nightly loop learned about a card (`alsoServed`) is matchable.
describe("learned phrases (alsoServed) in the catalogue", () => {
  const base = {
    id: "skill:patent-writer",
    kind: "skill" as const,
    name: "patent-writer",
    purpose: "Drafts a patent application.",
  };

  it("become trigger tags and part of the text Jev reads", () => {
    const doc = docFromCard({ ...base, alsoServed: ["dog toilet, utility model"] });
    expect(doc.tags).toContain("dog toilet, utility model");
    expect(doc.summary).toContain("Also served: dog toilet, utility model");
    expect(docFromCard(base).tags).toEqual([]);
  });

  it("let recall find a card by the words of a task its author never had in mind", () => {
    const plain = createRecall([
      docFromCard(base),
      docFromCard({
        id: "skill:other",
        kind: "skill",
        name: "other",
        purpose: "Does something else entirely.",
      }),
    ]);
    const learned = createRecall([
      docFromCard({ ...base, alsoServed: ["dog toilet, utility model"] }),
      docFromCard({
        id: "skill:other",
        kind: "skill",
        name: "other",
        purpose: "Does something else entirely.",
      }),
    ]);
    const q = { text: "update the dog toilet utility model drawings", sources: ["text" as const] };
    expect(plain.recall(q).map((c) => c.cardId)).not.toContain("skill:patent-writer");
    expect(learned.recall(q)[0].cardId).toBe("skill:patent-writer");
  });

  it("docsFromCards reads each card's file through the injected reader and leaves retired cards out", () => {
    const docs = docsFromCards(
      [
        { ...base, path: "/s/pw/SKILL.md", alsoServed: ["dog toilet"], status: "active" },
        { id: "skill:old", kind: "skill", name: "old", purpose: "Retired.", status: "retired" },
      ],
      (p) =>
        p === "/s/pw/SKILL.md"
          ? "---\ntitle: Patent writer\n---\n## Claims\n## Drawings\n"
          : undefined,
    );
    expect(docs.map((d) => d.id)).toEqual(["skill:patent-writer"]);
    expect(docs[0].title).toBe("Patent writer");
    expect(docs[0].sections).toEqual(["Claims", "Drawings"]);
  });
});
