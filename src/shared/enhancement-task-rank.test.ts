import { describe, expect, it } from "vitest";
import type { RankedEntry, RankResult } from "./enhancement-rank.js";
import {
  adviceLine,
  capResult,
  FOLLOW_UP_WORDS,
  isInteractiveSession,
  MAX_INSPIRE,
  MAX_USE,
  rankTextFor,
  recommendable,
  recipeSlugOf,
  seedableCards,
  shortlistFromResult,
} from "./enhancement-task-rank.js";
import { seedCards, type EnhancementCard } from "./thalamus-enhancements.js";
import { shortlistContext } from "./thalamus-shortlist-text.js";

const e = (
  cardId: string,
  mode: "USE" | "INSPIRE",
  source: "jev" | "local",
  score: number,
  section?: string,
): RankedEntry => ({
  cardId,
  source,
  mode,
  ...(section ? { section, sectionSource: source } : {}),
  score,
  modeScore: score,
  recallRank: 0,
});
const result = (
  use: RankedEntry[],
  inspire: RankedEntry[],
  source: RankResult["source"],
): RankResult => ({
  use,
  inspire,
  source,
  asked: use.length + inspire.length,
  answered: use.length + inspire.length,
  dropped: 0,
});
const names = (id: string): string => id.slice(id.indexOf(":") + 1);

describe("which prompts are owed a recommendation", () => {
  const ok = {
    sessionKey: "agent:main:tinker:abc",
    text: "Plan a family trip to Scotland in August",
  };

  it("accepts a person's request in a Tinker tab and in the main chat", () => {
    expect(recommendable(ok)).toEqual({ ok: true });
    expect(recommendable({ ...ok, sessionKey: "agent:main:main" })).toEqual({ ok: true });
    expect(recommendable({ ...ok, provenanceKind: "external_user" })).toEqual({ ok: true });
  });

  it("never gives one to a subagent, a cron job, a heartbeat or a channel chat", () => {
    expect(recommendable({ ...ok, sessionKey: "agent:main:subagent:x" })).toMatchObject({
      ok: false,
    });
    expect(recommendable({ ...ok, sessionKey: "agent:main:cron:nightly" })).toMatchObject({
      ok: false,
    });
    expect(recommendable({ ...ok, sessionKey: "agent:main:whatsapp:123" })).toMatchObject({
      ok: false,
    });
    expect(recommendable({ ...ok, trigger: "cron" })).toEqual({
      ok: false,
      why: "subagent-or-cron",
    });
    expect(recommendable({ ...ok, trigger: "heartbeat" })).toEqual({ ok: false, why: "heartbeat" });
    expect(recommendable({ ...ok, sessionKey: undefined })).toMatchObject({ ok: false });
  });

  it("uses provenance where the gateway recorded it", () => {
    expect(recommendable({ ...ok, provenanceKind: "inter_session" })).toEqual({
      ok: false,
      why: "provenance",
    });
    expect(recommendable({ ...ok, provenanceKind: "internal_system" })).toEqual({
      ok: false,
      why: "provenance",
    });
  });

  it.each([
    "[System] the gateway restarted",
    "[Tue 2026-10-06 08:43 GMT+2] ⟦AGENT:📈 Thalamus⟧ Turn 03 of the build",
    "System (untrusted): exec completed (code 0)",
    "<task-notification><task-id>abc</task-id></task-notification>",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsomething",
    "[Subagent Context] you are a worker",
    '<cross-session-message from="x">hi</cross-session-message>',
    "[injected: gateway] continue",
  ])("gives a marked notice none: %s", (text) => {
    expect(recommendable({ ...ok, text })).toEqual({ ok: false, why: "notice" });
  });

  it("gives an empty prompt (only a stamp and a sender block) none", () => {
    expect(recommendable({ ...ok, text: "[Tue 2026-10-06 08:43 GMT+2]" })).toEqual({
      ok: false,
      why: "empty",
    });
  });

  it("names the interactive sessions", () => {
    expect(isInteractiveSession("agent:main:tinker:mtba8duf")).toBe(true);
    expect(isInteractiveSession("agent:main:main")).toBe(true);
    expect(isInteractiveSession("agent:main:cron:x")).toBe(false);
    expect(isInteractiveSession(undefined)).toBe(false);
  });
});

describe("which text is ranked", () => {
  const none = () => false;
  it("ranks a full request as it is, without the envelope", () => {
    expect(
      rankTextFor(
        "[Tue 2026-10-06 08:43 GMT+2] plan a family trip to Scotland in August",
        undefined,
        none,
      ),
    ).toEqual({
      text: "plan a family trip to Scotland in August",
      basis: "own",
    });
  });

  it(`ranks a request of under ${FOLLOW_UP_WORDS} words on the previous user turn`, () => {
    const prev = "download the film Project Hail Mary in the best quality you can find";
    expect(rankTextFor("Make the update land", prev, none)).toEqual({
      text: prev,
      basis: "previous",
    });
  });

  it("keeps a short request that names a card", () => {
    expect(
      rankTextFor("run the trip-planner", "something long enough to rank on its own text", (t) =>
        /trip-planner/.test(t),
      ),
    ).toEqual({
      text: "run the trip-planner",
      basis: "own",
    });
  });

  it("skips a follow-up with no usable previous turn", () => {
    expect(rankTextFor("yes do it", undefined, none)).toEqual({ skip: "follow-up-no-context" });
    expect(
      rankTextFor(
        "yes do it",
        "[System] restarted the gateway and resumed all the pending work",
        none,
      ),
    ).toEqual({
      skip: "follow-up-no-context",
    });
    expect(rankTextFor("yes do it", "ok", none)).toEqual({ skip: "follow-up-no-context" });
  });
});

describe("the lists", () => {
  it("caps USE and INSPIRE at three each", () => {
    const r = result(
      ["a", "b", "c", "d", "e"].map((x) => e(`skill:${x}`, "USE", "jev", 0.2)),
      ["f", "g", "h", "i"].map((x) => e(`recipe:${x}`, "INSPIRE", "jev", 0.4, "S")),
      "jev",
    );
    const c = capResult(r);
    expect(c.use).toHaveLength(MAX_USE);
    expect(c.inspire).toHaveLength(MAX_INSPIRE);
    expect(c.use.map((x) => x.cardId)).toEqual(["skill:a", "skill:b", "skill:c"]);
  });

  it("builds the short list USE first, with mode, source and section on each entry", () => {
    const sl = shortlistFromResult(
      result(
        [e("skill:amazon-shopper", "USE", "jev", 0.9)],
        [e("recipe:acme-coding", "INSPIRE", "local", 0, "Commit diagram")],
        "mixed",
      ),
    );
    expect(sl.shown).toBe(true);
    expect(sl.source).toBe("jev");
    expect(sl.entries.map((x) => [x.cardId, x.rank, x.mode, x.source, x.section])).toEqual([
      ["skill:amazon-shopper", 1, "USE", "jev", undefined],
      ["recipe:acme-coding", 2, "INSPIRE", "local", "Commit diagram"],
    ]);
    expect(sl.entries[0].fit).toMatchObject({ value: "made-for", source: "jev" });
    expect(sl.entries[1].fit).toBeUndefined();
    expect(sl.noneFitsProb).toBeCloseTo(0.1);
  });

  it("an empty ranking is an empty, unshown list", () => {
    const sl = shortlistFromResult(result([], [], "local"));
    expect(sl).toMatchObject({ shown: false, reason: "empty", source: "local", noneFitsProb: 1 });
  });

  it("the note names the section for an inspiration and prints no percentage for a local entry", () => {
    const cards: EnhancementCard[] = seedCards([
      { kind: "skill", name: "amazon-shopper", description: "Ranks Amazon listings." },
      { kind: "recipe", name: "acme-coding", description: "Codes a ACME feature." },
    ]);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const sl = shortlistFromResult(
      result(
        [e("skill:amazon-shopper", "USE", "jev", 0.9)],
        [e("recipe:acme-coding", "INSPIRE", "local", 0, "Commit diagram")],
        "mixed",
      ),
    );
    const lines = shortlistContext(sl, byId)!.split("\n");
    expect(lines[1]).toMatch(/^1\. skill amazon-shopper, 90%; made for this task:/);
    expect(lines[2]).toMatch(
      /^2\. recipe acme-coding; not made for this, but it works the same way \(the "Commit diagram" part\):/,
    );
    expect(lines[2]).not.toContain("%");
  });
});

describe("the line the owner sees", () => {
  it("names use, inspiration with its section, and the source", () => {
    const line = adviceLine(
      result(
        [
          e("skill:amazon-shopper", "USE", "jev", 0.9),
          e("recipe:plan-family-trip", "USE", "jev", 0.05),
        ],
        [e("recipe:acme-coding", "INSPIRE", "jev", 0.5, "Commit diagram")],
        "jev",
      ),
      names,
    );
    expect(line).toBe(
      "Use: amazon-shopper, plan-family-trip · Inspiration: acme-coding (§ Commit diagram) · source: Jev",
    );
  });

  it("leaves out an empty group, says local for a local list, and is absent when there is nothing", () => {
    expect(adviceLine(result([e("skill:a", "USE", "local", 0)], [], "local"), names)).toBe(
      "Use: a · source: local",
    );
    expect(adviceLine(result([], [e("recipe:b", "INSPIRE", "local", 0)], "local"), names)).toBe(
      "Inspiration: b · source: local",
    );
    expect(adviceLine(result([], [], "local"), names)).toBeUndefined();
  });

  it("says Jev for a mixed list and keeps the line to one line", () => {
    const line = adviceLine(
      result(
        [e("skill:a", "USE", "jev", 0.7)],
        [e("recipe:b", "INSPIRE", "local", 0, "Two\nlines")],
        "mixed",
      ),
      (id) => `${names(id)}\n`,
    )!;
    expect(line).not.toContain("\n");
    expect(line.endsWith("source: Jev")).toBe(true);
  });
});

describe("when a plan may be seeded", () => {
  it("only from a USE Jev chose with a high share; never an INSPIRE, never a local entry", () => {
    const r = result(
      [
        e("recipe:a", "USE", "jev", 0.8),
        e("recipe:b", "USE", "jev", 0.3),
        e("recipe:c", "USE", "local", 0),
      ],
      [e("recipe:d", "INSPIRE", "jev", 0.95, "S")],
      "mixed",
    );
    expect(seedableCards(r)).toEqual(["recipe:a"]);
  });

  it("names the recipe slug of a recipe card only", () => {
    expect(recipeSlugOf("recipe:acme-coding")).toBe("acme-coding");
    expect(recipeSlugOf("skill:amazon-shopper")).toBeUndefined();
  });
});
