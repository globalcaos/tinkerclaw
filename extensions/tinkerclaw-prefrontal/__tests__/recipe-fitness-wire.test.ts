import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectEpisodes, type Episode } from "../../../src/memory/engram/episode-detection.js";
import { createEventStore } from "../../../src/memory/engram/event-store.js";
import { attributeRecipe } from "../../../src/memory/engram/recipe-fitness.js";
import { stampRecipeAttribution } from "../recipe-rpcs.js";

/**
 * U1 fitness loop — PRODUCER wire (seam A). The runner emits a `recipe:<owner/slug>`
 * tag; stampRecipeAttribution lands it in the session's engram event store so
 * sleep-consolidation's attributeRecipe() can credit the episode outcome to the
 * recipe. Before this wire the tag only reached the observability trail, so the
 * fitness store stayed empty (attributeRecipe → null → no record). These tests prove
 * the marker persists, reads back as the exact owner/slug the CONSUMER looks fitness
 * up by, and survives episode detection without fragmenting the run.
 */
describe("U1 recipe-fitness wire — stampRecipeAttribution (producer seam A)", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "recipe-fitness-wire-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("writes a recipe: tag attributeRecipe reads back — keyed by the full owner/slug", () => {
    const kitRef = "globalcaos/deep-research";
    stampRecipeAttribution(baseDir, "sess-1", `recipe:${kitRef}`);

    // Fresh store instance → reads from disk (proves it persisted, not just cached).
    const events = createEventStore({ baseDir, sessionKey: "sess-1" }).readAll();
    expect(events).toHaveLength(1);
    // attributeRecipe returns EXACTLY the kitRef the consumer passes to makeFitnessLookup —
    // the load-bearing key round-trip: recipe:<owner/slug> → <owner/slug>.
    expect(attributeRecipe({} as unknown as Episode, events)).toBe(kitRef);
  });

  it("marker is a turnId:0 system_event — can't flip inferOutcome or split an episode", () => {
    stampRecipeAttribution(baseDir, "sess-2", "recipe:globalcaos/triage");
    const [e] = createEventStore({ baseDir, sessionKey: "sess-2" }).readAll();
    expect(e.kind).toBe("system_event");
    expect(e.turnId).toBe(0);
    // No [session_start]/[session_end] content → never a boundary or outcome trigger.
    expect(e.content).not.toContain("[session_start]");
    expect(e.content).not.toContain("[session_end]");
  });

  it("the marker rides into the run's episode (survives detectEpisodes)", async () => {
    const store = createEventStore({ baseDir, sessionKey: "sess-3" });
    // A normal turn …
    store.append({
      turnId: 1,
      sessionKey: "sess-3",
      kind: "user_message",
      content: "run the recipe",
      tokens: 5,
      metadata: {},
    });
    store.append({
      turnId: 1,
      sessionKey: "sess-3",
      kind: "user_message",
      content: "and report back",
      tokens: 5,
      metadata: {},
    });
    // … plus the attribution marker the producer stamps at run start.
    stampRecipeAttribution(baseDir, "sess-3", "recipe:globalcaos/triage");

    const events = createEventStore({ baseDir, sessionKey: "sess-3" }).readAll();
    const episodes = await detectEpisodes(events);
    expect(episodes).toHaveLength(1); // the marker did NOT fragment the turn
    const ep = episodes[0];
    const epEvents = events.filter((ev) => ep.sourceEventIds.includes(ev.id));
    expect(attributeRecipe(ep, epEvents)).toBe("globalcaos/triage");
  });

  it("is best-effort — never throws", () => {
    expect(() => stampRecipeAttribution(baseDir, "sess-4", "recipe:globalcaos/x")).not.toThrow();
  });
});
