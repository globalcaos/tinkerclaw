/**
 * FORK 2026-08-22 — the per-plugin breakdown under a phase timing row.
 *
 * Two things are pinned here, and they are pinned for different reasons.
 *
 * THE CONTENT RULES exist because these popups are the only place a newcomer who just cloned
 * the repo learns why a stage is allowed to spend their seconds. A plugin doc that states a
 * benefit without evidence, or quotes a paper's benchmark as though it were this deployment's
 * behaviour, is worse than no doc: it teaches something false and looks authoritative doing it.
 *
 * THE PARSER RULES exist because the breakdown arrives over the wire from a gateway that may
 * be older, newer, or mid-deploy. A row rendering a plugin with a NaN duration is a wrong
 * measurement; a row rendering no breakdown is an honest absence. Prefer the second.
 */
import { describe, it, expect } from "vitest";
import {
  documentedPluginIds,
  pluginDisplayName,
  pluginDocFor,
  phaseDocFor,
  stageOwner,
} from "./phase-docs.js";
import { readTurnPhaseEvent } from "./turn-phase.js";

// ─── content ─────────────────────────────────────────────────────────────────

describe("plugin docs: every entry argues its own cost", () => {
  it("documents every plugin observed on the narrated hooks", () => {
    // Measured live on 2026-08-22 from `before_prompt_build` and `before_compaction`. A plugin
    // that appears in a breakdown with no entry renders the fallback, which says "unknown" —
    // honest, but this list is what stops it happening silently for the ones we know about.
    const observed = [
      "tinkerclaw-total-recall",
      "tinkerclaw-identity-persistence",
      "tinkerclaw-prefrontal",
      "tinkerclaw-computational-humor",
      "active-memory",
      "memory-lancedb",
      "skill-workshop",
      "diffs",
      "tinkerclaw-memory-enhancements",
    ];
    for (const id of observed) {
      expect(documentedPluginIds(), `undocumented plugin: ${id}`).toContain(id);
    }
  });

  it("states WHAT THE MILLISECONDS BUY, not merely what the code does", () => {
    for (const id of documentedPluginIds()) {
      const doc = pluginDocFor(id);
      expect(doc.profit.length, `${id} has no profit statement`).toBeGreaterThan(80);
      expect(doc.what.length, `${id} has no description`).toBeGreaterThan(40);
      expect(doc.title.trim(), `${id} has no title`).not.toBe("");
    }
  });

  it("never links a reference to a host outside thetinkerzone", () => {
    // Same rule the phase docs already enforce. The post ids for these papers were recorded
    // once in J-number order and that order was WRONG, so three links pointed at the wrong
    // paper. Every URL here is one already confirmed through a real browser; an unconfirmed
    // citation is listed WITHOUT a url rather than guessed.
    for (const id of documentedPluginIds()) {
      for (const ref of pluginDocFor(id).refs) {
        if (ref.url) {
          expect(ref.url, `${id} links off-site`).toMatch(/^https:\/\/thetinkerzone\.com\//);
        }
        expect(ref.label.trim(), `${id} has an unlabelled ref`).not.toBe("");
        expect(ref.note.trim(), `${id} has an unexplained ref`).not.toBe("");
      }
    }
  });

  it("marks the stages whose claimed benefit is NOT realised here", () => {
    // The three that must carry a caveat, because each is correct, well-tested, and currently
    // buying this deployment nothing:
    //   - compaction has fired 0 times in 980 gate evaluations
    //   - the pre-computed concept index loads 0 concepts on every start
    //   - the retrieval pack ADDS tokens rather than saving them
    for (const id of [
      "tinkerclaw-memory-enhancements",
      "memory-lancedb",
      "tinkerclaw-total-recall",
    ]) {
      expect(pluginDocFor(id).caveat, `${id} overstates its benefit`).toBeTruthy();
    }
  });

  it("falls back honestly for an unknown plugin instead of inventing a justification", () => {
    const doc = pluginDocFor("some-plugin-nobody-documented");
    expect(doc.profit.toLowerCase()).toContain("unknown");
    expect(doc.title).toBe("this plugin");
  });

  it("gives an unknown plugin a readable name rather than a package id", () => {
    expect(pluginDisplayName("tinkerclaw-total-recall")).toBe("Total Recall · ENGRAM");
    // The naming convention (the architect, 2026-08-23): descriptive name first, brain
    // codename second, both from the J-series registry. A plugin with no registered
    // codename carries the descriptive name alone rather than an invented brain word —
    // the registry tracks which are taken, and inventing one collides with a future paper.
    expect(pluginDisplayName("tinkerclaw-prefrontal")).toBe("Recipe Execution · PREFRONTAL");
    expect(pluginDisplayName("tinkerclaw-identity-persistence")).toBe(
      "Identity Persistence · CORTEX",
    );
    expect(pluginDisplayName("active-memory")).toBe("Working Memory");
    expect(pluginDisplayName("tinkerclaw-some-new-thing")).toBe("some new thing");
    expect(pluginDisplayName("plain-id")).toBe("plain id");
  });
});

describe("phase docs: the aggregate rows say what they buy too", () => {
  it("gives the memory and compaction phases a profit and a caveat", () => {
    for (const label of ["recalling memories", "compacting context"]) {
      const doc = phaseDocFor(label);
      expect(doc.profit, `${label} has no profit statement`).toBeTruthy();
      expect(doc.caveat, `${label} has no caveat`).toBeTruthy();
    }
  });

  it("warns that 'preparing context' contains the rows beneath it", () => {
    // The one arithmetic error a reader is most likely to make: these rows NEST.
    expect(phaseDocFor("preparing context").caveat?.toLowerCase()).toContain("contains");
  });

  it("says out loud that 'recalling memories' is a sum of plugins", () => {
    expect(phaseDocFor("recalling memories").whenSlow.toLowerCase()).toContain("sum");
  });
});

// ─── parser ──────────────────────────────────────────────────────────────────

const envelope = (data: unknown) => ({ sessionKey: "agent:main:tinker:abc", data });

describe("readTurnPhaseEvent: the plugin breakdown", () => {
  it("parses a well-formed breakdown on a completion", () => {
    const p = readTurnPhaseEvent(
      envelope({
        phase: "before_prompt_build",
        label: "recalling memories",
        ms: 12700,
        plugins: [
          { id: "tinkerclaw-total-recall", ms: 12650 },
          { id: "tinkerclaw-prefrontal", ms: 2 },
        ],
      }),
      1000,
    );
    expect(p?.plugins).toEqual([
      { id: "tinkerclaw-total-recall", ms: 12650 },
      { id: "tinkerclaw-prefrontal", ms: 2 },
    ]);
  });

  it("preserves the gateway's order — it is the order the handlers ran in", () => {
    const p = readTurnPhaseEvent(
      envelope({
        phase: "x",
        label: "recalling memories",
        ms: 10,
        plugins: [
          { id: "b", ms: 1 },
          { id: "a", ms: 9 },
        ],
      }),
      1,
    );
    expect(p?.plugins?.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("ignores a breakdown on a START event, which has no ms", () => {
    const p = readTurnPhaseEvent(
      envelope({ phase: "x", label: "recalling memories", plugins: [{ id: "a", ms: 1 }] }),
      1,
    );
    expect(p).not.toBeNull();
    expect(p?.ms).toBeUndefined();
    expect(p?.plugins).toBeUndefined();
  });

  it("drops malformed entries rather than rendering a wrong number", () => {
    const p = readTurnPhaseEvent(
      envelope({
        phase: "x",
        label: "recalling memories",
        ms: 10,
        plugins: [
          { id: "good", ms: 5 },
          { id: "", ms: 5 },
          { id: "nan", ms: Number.NaN },
          { id: "negative", ms: -1 },
          { id: "missing-ms" },
          { ms: 5 },
          null,
          "not-an-object",
        ],
      }),
      1,
    );
    expect(p?.plugins).toEqual([{ id: "good", ms: 5 }]);
  });

  it("is absent, not empty, when nothing survives validation", () => {
    // An empty array would render an empty breakdown, which reads as "no plugins ran".
    const p = readTurnPhaseEvent(
      envelope({ phase: "x", label: "recalling memories", ms: 10, plugins: [{ id: "", ms: -1 }] }),
      1,
    );
    expect(p?.plugins).toBeUndefined();
  });

  it("is absent when an older gateway sends no breakdown at all", () => {
    const p = readTurnPhaseEvent(envelope({ phase: "x", label: "recalling memories", ms: 10 }), 1);
    expect(p?.ms).toBe(10);
    expect(p?.plugins).toBeUndefined();
  });

  it("survives `plugins` arriving as a non-array", () => {
    for (const junk of [{}, "x", 5, true]) {
      const p = readTurnPhaseEvent(
        envelope({ phase: "x", label: "recalling memories", ms: 10, plugins: junk }),
        1,
      );
      expect(p?.plugins).toBeUndefined();
    }
  });

  it("trims a padded id so it still matches a doc entry", () => {
    const p = readTurnPhaseEvent(
      envelope({
        phase: "x",
        label: "recalling memories",
        ms: 10,
        plugins: [{ id: "  tinkerclaw-total-recall  ", ms: 5 }],
      }),
      1,
    );
    expect(p?.plugins?.[0].id).toBe("tinkerclaw-total-recall");
    expect(pluginDocFor(p?.plugins?.[0].id).title).toContain("Total Recall");
  });
});

// ─── stage ownership ─────────────────────────────────────────────────────────

/**
 * FORK 2026-08-24 — the architect: "'Total Recall' is still not itemized".
 *
 * Total Recall emits two stages of its own, but every stage was being attached to the
 * client-measured "preparing context" bracket, so the largest plugin on the pre-model path was
 * the one plugin that could not show the breakdown it was already producing. Ownership is what
 * routes a stage to the right row, and getting it wrong in either direction is visible: an
 * unowned stage attributed to a plugin inflates that plugin, and an owned one left in the
 * bracket double-counts it against its own row.
 */
describe("stage ownership routes a stage to the row that produced it", () => {
  it("claims the two Total Recall stages even from a gateway that sends no tag", () => {
    // The deploy window where the browser has the new UI and the gateway has not restarted yet.
    expect(stageOwner({ id: "engram-store-load" })).toBe("tinkerclaw-total-recall");
    expect(stageOwner({ id: "engram-search-rank" })).toBe("tinkerclaw-total-recall");
  });

  it("leaves RUNNER stages unowned, so they stay in the preparing-context bracket", () => {
    for (const stage of ["tools-build", "mcp-tools", "skills-load", "sandbox", "lsp-runtime"]) {
      expect(stageOwner({ id: stage })).toBeUndefined();
    }
  });

  it("prefers the gateway's tag over the local fallback table", () => {
    // The tag is a fact from the emitter; the table is a guess about someone else's code. When
    // a plugin is renamed, the tag is right and the table is stale.
    expect(stageOwner({ id: "engram-search-rank", plugin: "some-other-plugin" })).toBe(
      "some-other-plugin",
    );
  });

  it("owns a stage it has never heard of when the gateway tags it", () => {
    // This is the whole point of the tag: a new plugin gets an itemized row without a UI change.
    expect(stageOwner({ id: "brand-new-stage", plugin: "tinkerclaw-prefrontal" })).toBe(
      "tinkerclaw-prefrontal",
    );
  });

  it("names an owner that actually has a doc — an owned stage must reach a real row", () => {
    const owners = ["engram-store-load", "engram-search-rank"].map((id) => stageOwner({ id }));
    for (const owner of owners) {
      expect(owner).toBeTruthy();
      expect(documentedPluginIds()).toContain(owner as string);
    }
  });
});
