import { describe, expect, it } from "vitest";
import { goalFingerprint } from "../src/context.js";
import {
  createSecondOpinionFamily,
  parseReadingNotes,
  redundant,
  verifiedSources,
} from "../src/families/second-opinion.js";
import { proofGrantCode } from "../src/grant-code.js";
import { readSeeds } from "../src/question-book.js";
import { buildSituation } from "../src/situation.js";
import { renderTemplate } from "../src/templates.js";
import type { Response, Situation } from "../src/types.js";
import {
  book,
  caseSituation,
  freshState,
  loadCaseFile,
  meetsCeiling,
  meetsFloor,
  respond,
  result,
  seedDir,
  V,
  verdictsFromCase,
} from "./helpers/family-harness.js";

const fam = createSecondOpinionFamily({ book });
const F = <T>(value: T) => ({ value, origin: "observed" as const });
const sit = (seam: "prompt" | "pre-tool" | "post-tool", extra: Partial<Situation> = {}) =>
  caseSituation(null, seam, {}, extra);
const commitment = {
  payer: "user",
  amount: "1 EUR",
  date: null,
  condition: null,
  firmness: "owed",
} as const;

function renders(r: Response) {
  if (r.kind === "note") expect(() => renderTemplate(r.templateId, r.slots)).not.toThrow();
}

describe("reading notes and sources (2026-11-13)", () => {
  it("reads the reading, pick and source lines; the last pick wins", () => {
    const n = parseReadingNotes(
      "Two ways to read it.\n- reading: the rebuild\n- reading: the PDF\n- pick: the PDF\n- source: /m/a.md — he asked\n- pick: the rebuild",
    );
    expect(n.readings).toEqual(["the rebuild", "the PDF"]);
    expect(n.pick).toBe("the rebuild");
    expect(n.sources).toEqual(["/m/a.md — he asked"]);
  });
  it("a file counts once a call in this turn opened it; a quote only when the conversation has it", () => {
    const ran = ["Read /home/u/mem/project_x.md", "Bash grep -n bruno /home/u/mem/people/bruno.md"];
    const heard = "owner: send the supplier quote to Bruno today\nagent: done";
    expect(
      verifiedSources(
        [
          "~/mem/project_x.md — names the supplier Bruno",
          "/home/u/mem/people/bruno.md — the supplier",
          '"send the supplier quote to Bruno" — his words',
          "/home/u/never-opened.md — invented",
          '"words nobody said at all" — invented',
        ],
        ran,
        heard,
        "/home/u",
      ),
    ).toEqual(["file:project_x.md", "file:bruno.md", "quote:send the supplier quote to bruno"]);
  });
  it("the same file twice is one source, and two quotes without a file are not redundant", () => {
    expect(verifiedSources(["/m/a.md — x", "/m/a.md — y"], ["Read /m/a.md"], "", "/h")).toEqual([
      "file:a.md",
    ]);
    expect(redundant(["quote:a b c", "quote:d e f"])).toBe(false);
    expect(redundant(["file:a.md", "quote:d e f"])).toBe(true);
    expect(redundant(["file:a.md"])).toBe(false);
  });
  it("enrich reads the agent's lines only while the reading is open", () => {
    const text =
      "- reading: A\n- reading: B\n- pick: B\n- source: /m/b.md — shows B\n- source: /m/c.md — shows B";
    const s = sit("pre-tool", {
      restatement: F(text),
      turnSteps: F(["Read /m/b.md", "Read /m/c.md"]),
    });
    const open = freshState({ ambiguity: "open" });
    fam.enrich?.("pre-tool", s, open);
    expect(open.readings.map((r) => r.label)).toEqual(["A", "B"]);
    expect(open.readingPick).toBe("B");
    expect(open.sourcesVerified).toEqual(["file:b.md", "file:c.md"]);
    const none = freshState();
    fam.enrich?.("pre-tool", s, none);
    expect(none.readings).toEqual([]);
  });
  it("a pick the record ruled out is no pick", () => {
    const st = freshState({
      ambiguity: "open",
      readings: [{ id: "r1", label: "B", status: "ruled-out" }],
    });
    fam.enrich?.("pre-tool", sit("pre-tool", { restatement: F("- pick: B") }), st);
    expect(st.readingPick).toBeUndefined();
  });
});

describe("questionsFor", () => {
  it("prompt: the screen when a request exists", () => {
    expect(
      fam.questionsFor("prompt", sit("prompt", { request: F("do it") }), freshState()),
    ).toEqual(["misreading-screen"]);
    expect(fam.questionsFor("prompt", sit("prompt"), freshState())).toEqual([]);
  });
  it("pre-tool: each question only when relevant", () => {
    expect(fam.questionsFor("pre-tool", sit("pre-tool"), freshState())).toEqual([]);
    const s = sit("pre-tool", {
      request: F("r"),
      effectClass: F("send"),
      draftCommitments: F([commitment]),
      standingFacts: F(["f"]),
    });
    expect(fam.questionsFor("pre-tool", s, freshState())).toEqual([
      "commitment-changed",
      "excess-scope",
      "standing-fact-clash",
    ]);
    const read = sit("pre-tool", { request: F("r"), effectClass: F("read") });
    expect(fam.questionsFor("pre-tool", read, freshState())).toEqual([]);
  });
  it("pre-tool: excess-scope is not asked when every target is the agent's own or one the owner named (2026-10-25)", () => {
    const file = (path: string) => ({ path, kind: "file" as const, resolvedFrom: path });
    const del = (owned: Situation["ownedTargets"]["value"]) =>
      fam.questionsFor(
        "pre-tool",
        sit("pre-tool", {
          request: F("tidy up"),
          effectClass: F("delete"),
          targets: F([file("/w/a.log"), file("/w/b.log")]),
          ownedTargets: F(owned),
        }),
        freshState(),
      );
    expect(del([])).toEqual(["excess-scope"]);
    expect(del([{ path: "/w/a.log", why: "created" }])).toEqual(["excess-scope"]);
    expect(
      del([
        { path: "/w/a.log", why: "created" },
        { path: "/w/b.log", why: "named" },
      ]),
    ).toEqual([]);
    // A file the agent only edited is still the owner's: the question stays.
    expect(
      del([
        { path: "/w/a.log", why: "scratch" },
        { path: "/w/b.log", why: "edited" },
      ]),
    ).toEqual(["excess-scope"]);
    // A file born minutes ago (a cache a test run left behind) is the agent's own too (2026-11-13).
    expect(
      del([
        { path: "/w/a.log", why: "fresh" },
        { path: "/w/b.log", why: "fresh" },
      ]),
    ).toEqual([]);
  });
  // 2026-11-13: the step that was asked about removed a cache file and its folder, then listed two folders. The listed
  // repository folder was not the agent's, so the step never read as "all its own".
  it("pre-tool: a path a deletion only lists or reads is not reached; a send still counts it (2026-11-13)", () => {
    const t = (path: string, kind: "file" | "dir" = "file") => ({
      path,
      kind,
      resolvedFrom: path,
    });
    const step = (effect: "delete" | "send", readOnly: string[], removes = true) =>
      fam.questionsFor(
        "pre-tool",
        sit("pre-tool", {
          request: F("what is the delivery date"),
          effectClass: F(effect),
          targets: F(
            removes ? [t("/w/c/m.pyc"), t("/w/scripts/", "dir")] : [t("/w/scripts/", "dir")],
          ),
          ownedTargets: F(removes ? [{ path: "/w/c/m.pyc", why: "fresh" as const }] : []),
          readOnlyTargets: F(readOnly),
        }),
        freshState(),
      );
    expect(step("delete", [])).toEqual(["excess-scope"]);
    expect(step("delete", ["/w/scripts/"])).toEqual([]);
    expect(step("send", ["/w/scripts/"])).toEqual(["excess-scope"]);
    // Nothing the step is known to remove: the question stays.
    expect(step("delete", ["/w/scripts/"], false)).toEqual(["excess-scope"]);
  });
  it("the clean-up of 2026-11-13 is not asked about: fresh cache file, its folder, scratch files, two listings", () => {
    const command = [
      "rm -f /home/u/src/app/scripts/__pycache__/m.cpython-313.pyc",
      "rmdir /home/u/src/app/scripts/__pycache__",
      "rm -f /tmp/jarvis/n1x/mm.html /tmp/jarvis/n1x/pcc128.html",
      "ls -A /tmp/jarvis/n1x/",
      "ls /home/u/src/app/scripts/",
    ].join(" && ");
    const at = (freshPath?: (p: string) => boolean) =>
      buildSituation(
        {
          seam: "pre-tool",
          sessionKey: "s",
          turnId: "s#1",
          now: 1_000,
          tool: "Bash",
          toolInput: { command },
        },
        {
          workspaceRoot: "/home/u/ws",
          homeDir: "/home/u",
          request: "What would be the delivery date?",
          scratchDirs: ["/tmp/jarvis"],
          freshPath,
        },
      );
    const now = at((p) => p.includes("__pycache__"));
    expect(now.effectClass.value).toBe("delete");
    expect(fam.questionsFor("pre-tool", now, freshState())).not.toContain("excess-scope");
    // A cache file that is not minutes old is not the agent's own: the question is asked, as before.
    expect(fam.questionsFor("pre-tool", at(), freshState())).toContain("excess-scope");
  });
  it("prompt: the screen runs on the owner's turns only", () => {
    const owner = sit("prompt", { request: F("Carry on"), turnKind: F("owner" as const) });
    const job = sit("prompt", { request: F("Carry on"), turnKind: F("agent" as const) });
    expect(fam.questionsFor("prompt", owner, freshState())).toEqual(["misreading-screen"]);
    expect(fam.questionsFor("prompt", job, freshState())).toEqual([]);
  });
  it("evidence questions only on an open reading with a pick; the confirmation only with two sources", () => {
    const picked = freshState({
      ambiguity: "open",
      readingPick: "a",
      sourcesVerified: ["file:x.md"],
    });
    const backed = freshState({
      ambiguity: "open",
      readingPick: "a",
      sourcesVerified: ["file:x.md", "quote:a b c"],
    });
    const nopick = freshState({ ambiguity: "open" });
    const settled = freshState({
      ambiguity: "settled",
      readingPick: "a",
      sourcesVerified: ["file:x.md", "file:y.md"],
    });
    for (const seam of ["pre-tool", "post-tool"] as const) {
      expect(fam.questionsFor(seam, sit(seam), picked)).toEqual(["reading-ruled-out"]);
      expect(fam.questionsFor(seam, sit(seam), backed)).toEqual([
        "reading-ruled-out",
        "reading-confirmed",
      ]);
      expect(fam.questionsFor(seam, sit(seam), nopick)).toEqual([]);
      expect(fam.questionsFor(seam, sit(seam), settled)).toEqual([]);
    }
  });
  it("every id exists in the seed file and lists the seam; purpose-unclear is never asked", () => {
    const seed = {
      questions: readSeeds(seedDir)
        .map((x) => x.question as { id: string; family: string; seams: string[] })
        .filter((q) => q.family === "second-opinion"),
    };
    const st = () =>
      freshState({
        ambiguity: "open",
        readingPick: "a",
        sourcesVerified: ["file:x.md", "file:y.md"],
      });
    const full = {
      request: F("r"),
      effectClass: F("send" as const),
      draftCommitments: F([commitment]),
      standingFacts: F(["f"]),
    };
    for (const seam of ["prompt", "pre-tool", "post-tool"] as const) {
      for (const id of fam.questionsFor(seam, sit(seam, full), st())) {
        expect(id).not.toBe("purpose-unclear");
        const q = seed.questions.find((x) => x.id === id);
        expect(q, id).toBeDefined();
        expect(q?.seams).toContain(seam);
      }
    }
  });
});

describe("observe: the three stages (2026-11-13)", () => {
  it("prompt: a flag opens the reading at medium risk, no flag closes it, an unanswered screen changes nothing", () => {
    const st = freshState();
    result(fam, "prompt", sit("prompt"), [V("misreading-screen", 0.9)], st);
    expect([st.ambiguity, st.misreadingRisk]).toEqual(["open", "medium"]);
    result(fam, "prompt", sit("prompt"), [V("misreading-screen", 0.3)], st);
    expect([st.ambiguity, st.misreadingRisk]).toEqual(["none", "low"]);
    st.ambiguity = "open";
    const skipped = { ...V("misreading-screen", 0.9), skipped: "error" as const };
    result(fam, "prompt", sit("prompt"), [skipped], st);
    expect(st.ambiguity).toBe("open");
  });
  it("two checked sources and the judge's yes settle the pick", () => {
    const st = freshState({
      ambiguity: "open",
      misreadingRisk: "medium",
      readingPick: "b",
      sourcesVerified: ["file:x.md", "quote:a b c"],
    });
    result(
      fam,
      "pre-tool",
      sit("pre-tool"),
      [V("reading-confirmed", 0.8), V("reading-ruled-out", 0.1)],
      st,
    );
    expect([st.ambiguity, st.misreadingRisk]).toEqual(["settled", "low"]);
    expect(st.readings.find((r) => r.label === "b")?.status).toBe("confirmed");
  });
  it("a yes without two checked sources settles nothing", () => {
    const st = freshState({ ambiguity: "open", readingPick: "b", sourcesVerified: ["file:x.md"] });
    result(fam, "pre-tool", sit("pre-tool"), [V("reading-confirmed", 0.95)], st);
    expect(st.ambiguity).toBe("open");
  });
  it("ruled out drops the pick and its sources, even with a confirmation", () => {
    const st = freshState({
      ambiguity: "open",
      readingPick: "b",
      sourcesVerified: ["file:x.md", "file:y.md"],
    });
    result(
      fam,
      "post-tool",
      sit("post-tool"),
      [V("reading-confirmed", 0.9), V("reading-ruled-out", 0.9)],
      st,
    );
    expect(st.ambiguity).toBe("open");
    expect(st.readingPick).toBeUndefined();
    expect(st.sourcesVerified).toEqual([]);
    expect(st.readings.find((r) => r.label === "b")?.status).toBe("ruled-out");
  });
  it("safety reads the risk after second-opinion at the same step", () => {
    const st = freshState();
    respond(fam, "prompt", sit("prompt", { request: F("r") }), [V("misreading-screen", 0.9)], st);
    expect(st.misreadingRisk).toBe("medium");
  });
});

describe("decide: decision table", () => {
  it("prompt: screen crossing asks for the readings and two sources", () => {
    const r = result(fam, "prompt", sit("prompt"), [V("misreading-screen", 0.9)]);
    expect(r?.response).toMatchObject({ kind: "note", templateId: "reading-evidence" });
    expect(r?.drivers).toEqual(["misreading-screen"]);
    expect(r?.reasonCode).toBe("screen-flagged");
    renders(r?.response as Response);
  });
  it("prompt: screen below the cut-off gives no opinion", () => {
    expect(result(fam, "prompt", sit("prompt"), [V("misreading-screen", 0.6)])).toBeNull();
  });
  describe("pre-tool: an open reading holds a step that changes something (2026-11-13)", () => {
    const write = (over: Partial<Situation> = {}) =>
      sit("pre-tool", {
        tool: F("Edit"),
        effectClass: F("local-write" as const),
        targets: F([{ path: "/work/demo/plan.md", kind: "file" as const, resolvedFrom: "x" }]),
        scratch: F(false),
        ...over,
      });
    const open = () =>
      freshState({ ambiguity: "open", readingPick: "b", sourcesVerified: ["file:x.md"] });
    it("asks for one more source or the owner, needing reading-sources", () => {
      const r = result(fam, "pre-tool", write(), [], open());
      expect(r?.reasonCode).toBe("reading-unsettled");
      expect(r?.response).toMatchObject({
        kind: "proof",
        templateId: "reading-proof",
        needs: ["reading-sources"],
      });
      if (r?.response.kind !== "proof") return;
      const t = renderTemplate(r.response.templateId, r.response.slots);
      expect(t).toContain('pick: "b"');
      expect(t).toContain("1 of 2");
    });
    it("reads, scratch and settled readings never wait", () => {
      const read = sit("pre-tool", { tool: F("Read"), effectClass: F("read" as const) });
      expect(result(fam, "pre-tool", read, [], open())).toBeNull();
      expect(result(fam, "pre-tool", write({ scratch: F(true) }), [], open())).toBeNull();
      expect(result(fam, "pre-tool", write(), [], freshState({ ambiguity: "settled" }))).toBeNull();
      expect(result(fam, "pre-tool", write(), [], freshState())).toBeNull();
    });
    it("the owner's Allow for this step releases it", () => {
      const base = write({ sessionKey: "agent:main:tinker:t1", turnKind: F("owner" as const) });
      const code = proofGrantCode(goalFingerprint(base));
      const r = result(fam, "pre-tool", { ...base, request: F(`allow ${code}`) }, [], open());
      expect(r?.reasonCode).toBe("evidence-released-owner");
    });
  });
  it("pre-tool: commitment changed asks with restore preselected", () => {
    for (const a of ["dropped-condition", "firmer", "new-commitment"]) {
      const s = sit("pre-tool");
      const r = result(fam, "pre-tool", s, [V("commitment-changed", a)]);
      expect(r?.response).toEqual({
        kind: "ask",
        askId: `commitment-${s.id}`,
        options: [
          { id: "as-drafted", label: "Send it as drafted" },
          { id: "restore", label: "Restore what you asked for" },
          { id: "other", label: "Something else…" },
        ],
        preselect: "restore",
      });
      expect(r?.drivers).toEqual(["commitment-changed"]);
      expect(r?.reasonCode).toBe("commitment-changed");
    }
  });
  it("pre-tool: same commitment is quiet", () => {
    expect(result(fam, "pre-tool", sit("pre-tool"), [V("commitment-changed", "same")])).toBeNull();
  });
  it("pre-tool: excess scope asks with only-asked preselected", () => {
    const r = result(fam, "pre-tool", sit("pre-tool"), [V("excess-scope", 0.9)]);
    expect(r?.response).toMatchObject({
      kind: "ask",
      preselect: "only-asked",
      options: [{ id: "only-asked" }, { id: "go-beyond" }, { id: "other" }],
    });
    expect(r?.drivers).toEqual(["excess-scope"]);
    expect(r?.reasonCode).toBe("excess-scope");
  });
  it("pre-tool: his Allow answers the ask, in his own turn and for this step only (2026-10-31)", () => {
    const base = sit("pre-tool", {
      sessionKey: "agent:main:tinker:t1",
      turnKind: { value: "owner", origin: "derived" },
    });
    const allow = F(`allow ${proofGrantCode(goalFingerprint(base))}`);
    const crossing = [V("excess-scope", 0.9)];
    expect(result(fam, "pre-tool", { ...base, request: allow }, crossing)).toEqual({
      response: { kind: "proceed" },
      drivers: [],
      reasonCode: "evidence-released-owner",
    });
    // Any Allow press covers the scope asks of the rest of his turn, not only the step its code fits.
    expect(
      respond(fam, "pre-tool", { ...base, request: F("allow JEV-000000") }, crossing).kind,
    ).toBe("proceed");
    for (const s of [
      { ...base, request: F("please carry on") },
      { ...base, request: allow, sessionKey: "agent:main:cron:nightly:run:u1" },
    ]) {
      expect(respond(fam, "pre-tool", s, crossing).kind).toBe("ask");
    }
  });
  it("pre-tool: standing-fact clash notes the mapped fact", () => {
    const s = sit("pre-tool", { standingFacts: F(["first fact", "second fact"]) });
    const r = result(fam, "pre-tool", s, [V("standing-fact-clash", "fact-2")]);
    expect(r?.response).toMatchObject({
      kind: "note",
      templateId: "relevant-fact",
      slots: { fact: "the plan contradicts a standing fact: second fact" },
    });
    expect(r?.reasonCode).toBe("standing-fact-clash");
    expect(r?.drivers).toEqual(["standing-fact-clash"]);
    renders(r?.response as Response);
  });
  it("pre-tool: fact index out of range or none is ignored", () => {
    const s = sit("pre-tool", { standingFacts: F(["only"]) });
    expect(result(fam, "pre-tool", s, [V("standing-fact-clash", "fact-2")])).toBeNull();
    expect(result(fam, "pre-tool", s, [V("standing-fact-clash", "none")])).toBeNull();
  });
  it("pre-tool: several at once, ask over note, first in order on a tie", () => {
    const s = sit("pre-tool", { standingFacts: F(["f"]) });
    const both = result(fam, "pre-tool", s, [
      V("standing-fact-clash", "fact-1"),
      V("excess-scope", 0.9),
    ]);
    expect(both?.reasonCode).toBe("excess-scope");
    const tie = result(fam, "pre-tool", s, [
      V("excess-scope", 0.9),
      V("commitment-changed", "firmer"),
    ]);
    expect(tie?.reasonCode).toBe("commitment-changed");
  });
  it("post-tool: no response, evidence only updates state", () => {
    const st = freshState({ ambiguity: "open", readingPick: "a" });
    expect(
      result(fam, "post-tool", sit("post-tool"), [V("reading-ruled-out", 0.9)], st),
    ).toBeNull();
    expect(st.readings[0]?.status).toBe("ruled-out");
  });
});

describe("cannot-tell and skipped", () => {
  const choiceQs: [string, string, string][] = [
    ["commitment-changed", "firmer", "same"],
    ["standing-fact-clash", "fact-1", "none"],
  ];
  it("cannot-tell at p 0.95 never acts", () => {
    for (const [id] of choiceQs) {
      const s = sit("pre-tool", { standingFacts: F(["f"]) });
      expect(respond(fam, "pre-tool", s, [V(id, "cannot-tell", 0.95)]).kind).toBe("proceed");
    }
  });
  it("the acting option just below its cut-off does not act", () => {
    for (const [id, act, other] of choiceQs) {
      const s = sit("pre-tool", { standingFacts: F(["f"]) });
      const v = V(id, other, 0.41);
      const q = book.get(id);
      const at = q && q.cutoff.kind === "choice" ? q.cutoff.at : 0;
      const probs = { [act]: at - 0.02, [other]: 1 - (at - 0.02) };
      expect(respond(fam, "pre-tool", s, [{ ...v, probs }]).kind).toBe("proceed");
    }
  });
  it("every skipped verdict is absent", () => {
    const skip = (id: string, a: string | number) => ({ ...V(id, a), skipped: "error" as const });
    const s = sit("pre-tool", { standingFacts: F(["f"]) });
    const vs = [
      skip("commitment-changed", "firmer"),
      skip("excess-scope", 0.95),
      skip("standing-fact-clash", "fact-1"),
    ];
    expect(respond(fam, "pre-tool", s, vs).kind).toBe("proceed");
    expect(respond(fam, "prompt", sit("prompt"), [skip("misreading-screen", 0.95)]).kind).toBe(
      "proceed",
    );
  });
});

describe("cases replay", () => {
  const seamOf = (ids: string[]) => {
    const q = book.get(ids[0] ?? "");
    return (q?.seams[0] ?? "pre-tool") as "prompt" | "pre-tool" | "post-tool";
  };
  const run = (c: ReturnType<typeof loadCaseFile>[number]) => {
    const seam = seamOf(Object.keys(c.answers ?? {}));
    const r = respond(fam, seam, caseSituation(c, seam), verdictsFromCase(c));
    renders(r);
    return r;
  };
  const must = loadCaseFile("must-catch", "second-opinion");
  const ctl = loadCaseFile("controls", "second-opinion");
  it("has cases", () => {
    expect(must.length).toBeGreaterThanOrEqual(6);
    expect(ctl.length).toBeGreaterThanOrEqual(5);
  });
  for (const c of must) {
    it(`must-catch ${c.id}`, () => {
      expect(c.answers).toBeDefined();
      expect(meetsFloor(run(c), c.mustBeAtLeast ?? "note")).toBe(true);
    });
  }
  for (const c of ctl) {
    it(`control ${c.id}`, () => {
      expect(meetsCeiling(run(c), c.mustBeAtMost ?? "proceed")).toBe(true);
    });
  }
});
